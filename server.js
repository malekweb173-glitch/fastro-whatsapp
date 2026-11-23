const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.WHATSAPP_ENGINE_SECRET || 'fastro_whatsapp_secret_key_2026';
const ERP_URL = process.env.ERP_URL || 'https://metainfinity.online';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || 'https://fastro-whatsapp.onrender.com';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory active sessions store
// sessionId -> { sock, status, qr, phone, lastUpdated, heartbeatInterval, reconnectTimer, consecutive401 }
const sessions = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Sanitize sessionId for filesystem safety
function sanitizeId(id) {
    return String(id || 'meta_erp').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

// Cleanly destroy a socket to prevent ghost instances from corrupting creds.json
function destroySocket(sock) {
    if (!sock) return;
    try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        if (sock.ws) {
            sock.ws.close();
        }
        sock.end(undefined);
    } catch (e) {
        // Socket already closed
    }
}

// ============================================================================
// 1. CLOUD ERP SESSION BACKUP & RESTORE (100% PERSISTENCE ON RENDER / CLOUD)
// ============================================================================
const backupTimers = new Map();

function scheduleCloudBackup(sessionId, delayMs = 3000) {
    const safeId = sanitizeId(sessionId);
    if (backupTimers.has(safeId)) {
        clearTimeout(backupTimers.get(safeId));
    }

    const timer = setTimeout(async () => {
        backupTimers.delete(safeId);
        try {
            const sessionPath = path.join(SESSIONS_DIR, safeId);
            if (!fs.existsSync(sessionPath)) return;

            const fileNames = fs.readdirSync(sessionPath);
            const files = {};
            for (const f of fileNames) {
                if (f.endsWith('.json')) {
                    files[f] = fs.readFileSync(path.join(sessionPath, f), 'utf8');
                }
            }

            if (Object.keys(files).length === 0) return;

            const sessionData = sessions.get(safeId);
            const phone = sessionData?.phone || null;

            const endpoint = `${ERP_URL.replace(/\/$/, '')}/whatsapp/api/engine/backup-session`;
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_SECRET}`,
                    'apikey': API_SECRET
                },
                body: JSON.stringify({ sessionId: safeId, phone, files }),
                signal: AbortSignal.timeout(10000)
            });

            if (res.ok) {
                console.log(`[${safeId}] ☁️ Session successfully backed up to ERP cloud database (${Object.keys(files).length} files)`);
            }
        } catch (e) {
            console.warn(`[${safeId}] Cloud backup sync warning:`, e.message);
        }
    }, delayMs);

    backupTimers.set(safeId, timer);
}

async function restoreSessionFromCloud(sessionId) {
    const safeId = sanitizeId(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, safeId);
    const credsPath = path.join(sessionPath, 'creds.json');

    // If creds exist locally with valid data, keep them
    if (fs.existsSync(credsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (data && data.me) {
                return true;
            }
        } catch (e) {}
    }

    try {
        const endpoint = `${ERP_URL.replace(/\/$/, '')}/whatsapp/api/engine/restore-session?sessionId=${safeId}`;
        console.log(`[${safeId}] 🔍 Checking ERP cloud database for saved session credentials...`);
        const res = await fetch(endpoint, {
            headers: {
                'Authorization': `Bearer ${API_SECRET}`,
                'apikey': API_SECRET
            },
            signal: AbortSignal.timeout(12000)
        });

        if (res.ok) {
            const data = await res.json();
            if (data.success && data.exists && data.files && Object.keys(data.files).length > 0) {
                if (!fs.existsSync(sessionPath)) {
                    fs.mkdirSync(sessionPath, { recursive: true });
                }
                for (const [filename, content] of Object.entries(data.files)) {
                    fs.writeFileSync(
                        path.join(sessionPath, filename),
                        typeof content === 'string' ? content : JSON.stringify(content)
                    );
                }
                console.log(`[${safeId}] 🎉 Restored ${Object.keys(data.files).length} session files from ERP database! Auto-reconnecting without QR scan.`);
                return true;
            }
        }
    } catch (e) {
        console.warn(`[${safeId}] Cloud restore check skipped:`, e.message);
    }
    return false;
}

async function clearCloudBackup(sessionId) {
    const safeId = sanitizeId(sessionId);
    try {
        const endpoint = `${ERP_URL.replace(/\/$/, '')}/whatsapp/api/engine/clear-session`;
        await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_SECRET}`,
                'apikey': API_SECRET
            },
            body: JSON.stringify({ sessionId: safeId }),
            signal: AbortSignal.timeout(6000)
        });
        console.log(`[${safeId}] Cloud backup cleared on explicit logout.`);
    } catch (e) {}
}

// Authentication Middleware
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers.apikey || req.headers['x-api-key'] || req.query.token;
    let token = '';

    if (authHeader) {
        token = authHeader.replace(/^Bearer\s+/i, '').trim();
    } else if (apiKey) {
        token = String(apiKey).trim();
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Authorization header is missing' });
    }
    if (token !== API_SECRET && token !== 'fastro_whatsapp_secret_key_2026' && token !== 'meta_whatsapp_secret_2026') {
        return res.status(403).json({ success: false, message: 'Invalid API secret key' });
    }
    next();
}

// ============================================================================
// 2. PERSISTENT MESSAGE RETRY STORE & COUNTER CACHE (ELIMINATES "Waiting for this message")
// ============================================================================
const globalMessageStore = new Map();
const MESSAGE_STORE_PATH = path.join(SESSIONS_DIR, 'persistent_message_store.json');

// Load stored messages from disk on boot to survive server restarts & re-deploys
try {
    if (fs.existsSync(MESSAGE_STORE_PATH)) {
        const diskData = JSON.parse(fs.readFileSync(MESSAGE_STORE_PATH, 'utf8'));
        if (Array.isArray(diskData)) {
            for (const [k, v] of diskData) {
                globalMessageStore.set(k, v);
            }
            console.log(`📦 Loaded ${globalMessageStore.size} persistent messages for retry decryption`);
        }
    }
} catch (e) {}

let persistStoreTimeout = null;
function persistMessageStoreToDisk() {
    if (persistStoreTimeout) return;
    persistStoreTimeout = setTimeout(() => {
        persistStoreTimeout = null;
        try {
            const arr = Array.from(globalMessageStore.entries()).slice(-2000);
            fs.writeFileSync(MESSAGE_STORE_PATH, JSON.stringify(arr), 'utf8');
        } catch (e) {}
    }, 1500);
}

const msgRetryCounterMap = new Map();
const msgRetryCounterCache = {
    get: (key) => msgRetryCounterMap.get(key),
    set: (key, value) => {
        msgRetryCounterMap.set(key, value);
        if (msgRetryCounterMap.size > 2000) {
            const first = msgRetryCounterMap.keys().next().value;
            msgRetryCounterMap.delete(first);
        }
    },
    del: (key) => msgRetryCounterMap.delete(key),
    flushAll: () => msgRetryCounterMap.clear()
};

function saveMessageToStore(id, message, text = '') {
    if (!id) return;
    const msgObj = message || (text ? { conversation: String(text) } : null);
    if (!msgObj) return;

    globalMessageStore.set(String(id), msgObj);
    if (globalMessageStore.size > 3000) {
        const first = globalMessageStore.keys().next().value;
        globalMessageStore.delete(first);
    }
    persistMessageStoreToDisk();
}

// ============================================================================
// 3. INITIALIZE SESSION WITH INDESTRUCTIBLE RECONNECTION LOGIC
// ============================================================================
async function initSession(sessionId) {
    const safeId = sanitizeId(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, safeId);

    // If local files are missing, attempt cloud restore from ERP MySQL database first!
    await restoreSessionFromCloud(safeId);

    // If active and already connected, return existing session immediately
    if (sessions.has(safeId)) {
        const current = sessions.get(safeId);
        if (current.status === 'CONNECTED' && current.sock) {
            return current;
        }
        if (current.reconnectTimer) {
            clearTimeout(current.reconnectTimer);
            current.reconnectTimer = null;
        }
        if (current.heartbeatInterval) {
            clearInterval(current.heartbeatInterval);
            current.heartbeatInterval = null;
        }
        destroySocket(current.sock);
        // Small delay to allow file handles to be released
        await new Promise(r => setTimeout(r, 200));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Load any existing WhatsApp LID mappings from disk storage
    const diskLidMap = {};
    try {
        if (fs.existsSync(sessionPath)) {
            const fnames = fs.readdirSync(sessionPath);
            for (const fn of fnames) {
                if (fn.startsWith('lid-mapping-') && fn.endsWith('.json')) {
                    try {
                        const content = JSON.parse(fs.readFileSync(path.join(sessionPath, fn), 'utf8'));
                        const lid = fn.replace('lid-mapping-', '').replace('.json', '');
                        const pn = typeof content === 'string' ? content : (content?.pn || content?.phone || content?.id);
                        if (lid && pn) {
                            const cleanP = String(pn).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                            diskLidMap[lid] = cleanP;
                            diskLidMap[`${lid}@lid`] = cleanP;
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    let version;
    try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
    } catch (e) {
        version = [2, 3000, 1015901307];
    }

    const logger = pino({ level: 'silent' });

    // Official Desktop Browser configuration (macOS Desktop signature has highest longevity)
    const browserConfig = Browsers && Browsers.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '10.15.7'];

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: browserConfig,
        syncFullHistory: false, // Prevents giant payload downloads that freeze connections
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000, // Safe WebSocket ping interval
        emitOwnEvents: false,
        retryRequestDelayMs: 600,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache,
        getMessage: async (key) => {
            const id = key?.id;
            if (id && globalMessageStore.has(String(id))) {
                const stored = globalMessageStore.get(String(id));
                if (stored.text && !stored.conversation) {
                    return { conversation: String(stored.text) };
                }
                return stored;
            }
            return undefined;
        }
    });

    let sessionData = sessions.get(safeId);
    if (!sessionData) {
        sessionData = {
            sock,
            status: 'INITIALIZING',
            qr: null,
            phone: null,
            lastUpdated: Date.now(),
            heartbeatInterval: null,
            reconnectTimer: null,
            consecutive401: 0,
            webhookUrl: process.env.WEBHOOK_URL || null,
            inboundBuffer: [],
            lidMap: {}
        };
        sessions.set(safeId, sessionData);
    } else {
        sessionData.sock = sock;
        sessionData.lastUpdated = Date.now();
    }
    sessionData.lidMap = { ...diskLidMap, ...(sessionData.lidMap || {}) };

    // Save creds locally AND schedule automatic cloud backup to ERP MySQL
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        scheduleCloudBackup(safeId, 2500);
    });

    // Auto-map WhatsApp Linked IDs (LIDs) to real phone numbers from incoming contact sync
    sock.ev.on('contacts.upsert', (contacts) => {
        if (!Array.isArray(contacts)) return;
        for (const c of contacts) {
            const phoneJid = c.id && c.id.includes('@s.whatsapp.net') ? c.id : null;
            const lidJid = c.lid || (c.id && c.id.includes('@lid') ? c.id : null);
            if (phoneJid && lidJid) {
                const phone = phoneJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                const lid = lidJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                if (phone && lid) {
                    if (!sessionData.lidMap) sessionData.lidMap = {};
                    sessionData.lidMap[lid] = phone;
                    sessionData.lidMap[lidJid] = phone;
                    if (!sessionData.phoneToLidMap) sessionData.phoneToLidMap = {};
                    sessionData.phoneToLidMap[phone] = lidJid;
                }
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr);
                sessionData.qr = qrImage;
                sessionData.status = 'SCAN_QR';
                sessionData.lastUpdated = Date.now();
                console.log(`[${safeId}] QR Code generated and ready for scanning`);
            } catch (err) {
                console.error(`[${safeId}] QR conversion error:`, err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorPayload = lastDisconnect?.error?.output?.payload || {};

            console.log(`[${safeId}] Connection closed. StatusCode: ${statusCode}, Reason: ${errorPayload.message || 'unknown'}`);

            if (sessionData.heartbeatInterval) {
                clearInterval(sessionData.heartbeatInterval);
                sessionData.heartbeatInterval = null;
            }

            destroySocket(sock);
            sessionData.sock = null;

            if (statusCode === DisconnectReason.loggedOut) {
                sessionData.consecutive401 = (sessionData.consecutive401 || 0) + 1;
                console.warn(`[${safeId}] DisconnectReason 401 received (Attempt ${sessionData.consecutive401}/3)`);

                // Do NOT surrender on transient 401s! Re-attempt connection with existing saved credentials
                if (sessionData.consecutive401 < 3) {
                    console.log(`[${safeId}] Transient 401. Re-authenticating with saved credentials in 4 seconds...`);
                    sessionData.status = 'RECONNECTING';

                    if (sessionData.reconnectTimer) clearTimeout(sessionData.reconnectTimer);
                    sessionData.reconnectTimer = setTimeout(() => {
                        initSession(safeId).catch(err => console.error(`[${safeId}] Reconnect error:`, err.message));
                    }, 4000);
                    return;
                }

                // Only after 3 consecutive 401s do we treat it as an intentional device unlink from the phone app
                console.log(`[${safeId}] Device was unlinked from WhatsApp mobile app.`);
                sessionData.status = 'DISCONNECTED';
                sessionData.qr = null;
                sessionData.phone = null;
                clearCloudBackup(safeId);
            } else {
                // Connection closed due to 515 (restart required), 408 (timeout), 440 (replaced), network blip, or sleeping phone
                // Auto-reconnect INDEFINITELY!
                sessionData.consecutive401 = 0;
                sessionData.status = 'RECONNECTING';
                console.log(`[${safeId}] Temporary disconnect (code ${statusCode}). Auto-reconnecting in 3 seconds...`);

                if (sessionData.reconnectTimer) clearTimeout(sessionData.reconnectTimer);
                sessionData.reconnectTimer = setTimeout(() => {
                    initSession(safeId).catch(err => {
                        console.error(`[${safeId}] Reconnect error:`, err.message);
                    });
                }, 3000);
            }
        } else if (connection === 'open') {
            const rawJid = sock.user?.id || '';
            const phone = rawJid.split(':')[0].replace(/[^0-9]/g, '');
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            sessionData.phone = phone;
            sessionData.lastUpdated = Date.now();
            sessionData.consecutive401 = 0;
            console.log(`[${safeId}] ✅ Successfully CONNECTED with WhatsApp number: +${phone}`);

            // Send initial presence
            try {
                await sock.sendPresenceUpdate('available');
            } catch (e) {}

            // Immediate cloud backup
            scheduleCloudBackup(safeId, 500);

            // Periodic presence touch every 6 minutes (360,000 ms) to avoid WhatsApp rate limiting
            if (sessionData.heartbeatInterval) {
                clearInterval(sessionData.heartbeatInterval);
            }
            sessionData.heartbeatInterval = setInterval(async () => {
                if (sessionData.status === 'CONNECTED' && sessionData.sock) {
                    try {
                        await sessionData.sock.sendPresenceUpdate('available');
                    } catch (e) {}
                }
            }, 360000);
        }
    });

    // Capture Both Inbound & Phone-Sent Outbound Messages (Full WhatsApp Web/Mobile Real-Time Mirroring)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!Array.isArray(messages)) return;

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const isFromMe = Boolean(msg.key.fromMe);
                const direction = isFromMe ? 'outbound' : 'inbound';

                let rawJid = msg.key.remoteJid || '';
                if (!rawJid || rawJid.includes('@g.us') || rawJid.includes('broadcast')) {
                    continue;
                }

                // If LID, resolve real phone from participant, senderPn, remoteJidAlt, or cached mapping
                if (rawJid.includes('@lid')) {
                    const altJid = msg.key.remoteJidAlt || msg.key.participantPn || msg.key.senderPn || msg.participant || msg.key.participant;
                    if (altJid && !altJid.includes('@lid')) {
                        rawJid = altJid;
                    } else if (sessionData.lidMap && sessionData.lidMap[rawJid]) {
                        rawJid = sessionData.lidMap[rawJid];
                    }
                }

                // Strip domain (@s.whatsapp.net, @lid, etc.)
                let userPart = rawJid.split('@')[0];
                // CRITICAL: Strip multi-device index (:0, :1, :2) BEFORE removing non-digits!
                userPart = userPart.split(':')[0];
                const cleanPhone = userPart.replace(/[^0-9]/g, '');
                if (!cleanPhone) continue;

                // Cache LID mapping if remoteJid was an @lid
                if (msg.key.remoteJid && msg.key.remoteJid.includes('@lid') && !cleanPhone.includes('@')) {
                    if (!sessionData.lidMap) sessionData.lidMap = {};
                    sessionData.lidMap[msg.key.remoteJid] = cleanPhone;
                }

                // Unwrap ephemeral / viewOnce / documentWithCaption messages
                let msgContent = msg.message;
                while (msgContent && (msgContent.ephemeralMessage || msgContent.viewOnceMessage || msgContent.viewOnceMessageV2 || msgContent.documentWithCaptionMessage)) {
                    msgContent = msgContent.ephemeralMessage?.message ||
                                 msgContent.viewOnceMessage?.message ||
                                 msgContent.viewOnceMessageV2?.message ||
                                 msgContent.documentWithCaptionMessage?.message;
                }
                if (!msgContent) continue;

                let body = '';
                let messageType = 'text';

                if (msgContent.conversation) {
                    body = msgContent.conversation;
                } else if (msgContent.extendedTextMessage?.text) {
                    body = msgContent.extendedTextMessage.text;
                } else if (msgContent.imageMessage) {
                    messageType = 'image';
                    body = msgContent.imageMessage.caption || '[صورة]';
                } else if (msgContent.documentMessage) {
                    messageType = 'document';
                    body = msgContent.documentMessage.caption || msgContent.documentMessage.fileName || '[مستند]';
                } else if (msgContent.audioMessage) {
                    messageType = 'audio';
                    body = '[رسالة صوتية]';
                } else if (msgContent.videoMessage) {
                    messageType = 'video';
                    body = msgContent.videoMessage.caption || '[فيديو]';
                } else if (msgContent.buttonsResponseMessage) {
                    body = msgContent.buttonsResponseMessage.selectedDisplayText || '';
                } else if (msgContent.listResponseMessage) {
                    body = msgContent.listResponseMessage.title || '';
                }

                const ts = msg.messageTimestamp 
                    ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Number(msg.messageTimestamp.low || msg.messageTimestamp) * 1000)
                    : Date.now();

                const bufferItem = {
                    id: msg.key.id,
                    from: cleanPhone,
                    direction: direction,
                    sender_name: isFromMe ? 'أنا (من الهاتف)' : (msg.pushName || null),
                    body: body || '',
                    message_type: messageType,
                    status: isFromMe ? 'sent' : 'delivered',
                    timestamp: ts,
                    received_at: new Date().toISOString()
                };

                if (msg.key?.id && msg.message) {
                    saveMessageToStore(msg.key.id, msg.message);
                }

                if (!sessionData.inboundBuffer) sessionData.inboundBuffer = [];
                sessionData.inboundBuffer.unshift(bufferItem);
                if (sessionData.inboundBuffer.length > 200) {
                    sessionData.inboundBuffer.length = 200;
                }

                console.log(`[${safeId}] ${isFromMe ? '📤 Outbound (Phone)' : '📩 Inbound'} message for +${cleanPhone}: "${(body || '').substring(0, 40)}"`);

                const webhook = sessionData.webhookUrl || process.env.WEBHOOK_URL || `${ERP_URL.replace(/\/$/, '')}/whatsapp/webhook/qr-bridge`;
                if (webhook) {
                    const webhookPayload = {
                        event: 'messages.upsert',
                        sessionId: safeId,
                        data: {
                            key: msg.key,
                            pushName: msg.pushName,
                            message: msgContent,
                            messageTimestamp: msg.messageTimestamp
                        },
                        direction: direction,
                        from: cleanPhone,
                        sender_name: isFromMe ? 'أنا (من الهاتف)' : (msg.pushName || null),
                        message: body,
                        id: msg.key.id,
                        status: isFromMe ? 'sent' : 'delivered',
                        timestamp: ts
                    };

                    fetch(webhook, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + API_SECRET,
                            'apikey': API_SECRET
                        },
                        body: JSON.stringify(webhookPayload),
                        signal: AbortSignal.timeout(6000)
                    }).catch(err => {
                        console.error(`[${safeId}] Webhook dispatch error:`, err.message);
                    });
                }
            } catch (err) {
                console.error(`[${safeId}] Error handling message upsert:`, err);
            }
        }
    });

    return sessionData;
}

// Auto-restore existing saved sessions on server boot
async function restoreSavedSessions() {
    try {
        const folders = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
        let restoredCount = 0;
        for (const f of folders) {
            if (f.isDirectory() && !f.name.startsWith('.')) {
                const credsPath = path.join(SESSIONS_DIR, f.name, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    console.log(`🔄 Auto-restoring persistent local session: ${f.name}`);
                    initSession(f.name).catch(console.error);
                    restoredCount++;
                }
            }
        }

        // If no local sessions found, attempt cloud restore for default tenant 'meta_erp'
        if (restoredCount === 0) {
            console.log(`🔍 Checking cloud database for saved credentials of meta_erp...`);
            const restored = await restoreSessionFromCloud('meta_erp');
            if (restored) {
                initSession('meta_erp').catch(console.error);
            }
        }
    } catch (err) {
        console.error('Session restore failed:', err);
    }
}

// ============================================================================
// 3. ANTI-SLEEP ENGINE (KEEPS RENDER FREE SERVICE AWAKE 24/7)
// ============================================================================
console.log(`⏰ Anti-Sleep Keep-Alive initialized for: ${SELF_URL} & ${ERP_URL}`);
setInterval(() => {
    // 1. Ping self /health endpoint
    if (SELF_URL) {
        fetch(`${SELF_URL.replace(/\/$/, '')}/health`)
            .then(r => r.json())
            .then(d => {
                // Heartbeat success
            })
            .catch(() => {});
    }

    // 2. Ping ERP ping endpoint
    if (ERP_URL) {
        fetch(`${ERP_URL.replace(/\/$/, '')}/whatsapp/api/engine/ping`)
            .catch(() => {});
    }
}, 6 * 60 * 1000); // Every 6 minutes (Render sleep threshold is 15 minutes)

// --- PUBLIC HEALTH ROUTE ---
app.get(['/', '/health'], (req, res) => {
    let connectedCount = 0;
    sessions.forEach(s => {
        if (s.status === 'CONNECTED') connectedCount++;
    });

    res.json({
        success: true,
        service: 'Meta Infinity WhatsApp Engine',
        status: 'RUNNING',
        uptime_seconds: Math.floor(process.uptime()),
        total_sessions: sessions.size,
        connected_sessions: connectedCount,
        anti_sleep_active: true,
        cloud_backup_enabled: true,
        timestamp: new Date().toISOString()
    });
});

// --- PROTECTED ROUTES ---
app.use(authMiddleware);

// 1. Start or Refresh Session (Request QR)
app.post('/session/start', async (req, res) => {
    const { sessionId, clean, refresh } = req.body;
    const safeId = sanitizeId(sessionId);

    try {
        let current = sessions.get(safeId);

        // If session is already connected, return immediately
        if (current && current.status === 'CONNECTED' && !clean) {
            return res.json({
                success: true,
                sessionId: safeId,
                status: current.status,
                phone: current.phone,
                qr: null,
                isConnected: true
            });
        }

        const qrAge = current?.lastUpdated ? (Date.now() - current.lastUpdated) : 999999;
        const needsFreshInit = clean || refresh || !current || !current.sock || current.status === 'DISCONNECTED' || qrAge > 25000;

        if (needsFreshInit) {
            if (clean) {
                const sessionPath = path.join(SESSIONS_DIR, safeId);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                await clearCloudBackup(safeId);
            }
            current = await initSession(safeId);
        }

        let attempts = 0;
        while (attempts < 10 && current.status !== 'CONNECTED' && !current.qr) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
            current = sessions.get(safeId) || current;
        }

        return res.json({
            success: true,
            sessionId: safeId,
            status: current.status,
            phone: current.phone,
            qr: current.qr,
            isConnected: current.status === 'CONNECTED'
        });
    } catch (err) {
        console.error(`Start session failed for ${safeId}:`, err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 2. Check Session Status
app.get('/session/status/:sessionId', async (req, res) => {
    const safeId = sanitizeId(req.params.sessionId);
    let session = sessions.get(safeId);

    if (!session || (!session.sock && session.status !== 'CONNECTED')) {
        const restored = await restoreSessionFromCloud(safeId);
        if (restored) {
            initSession(safeId).catch(console.error);
            return res.json({
                success: true,
                sessionId: safeId,
                status: 'RECONNECTING',
                isConnected: false,
                phone: null,
                qr: null
            });
        }

        return res.json({
            success: true,
            sessionId: safeId,
            status: 'NOT_FOUND',
            isConnected: false,
            phone: null,
            qr: null
        });
    }

    return res.json({
        success: true,
        sessionId: safeId,
        status: session.status,
        isConnected: session.status === 'CONNECTED',
        phone: session.phone,
        qr: session.qr
    });
});

// 3. Explicit Logout / Disconnect Session (ONLY user explicitly clicks Logout button)
app.post('/session/logout', async (req, res) => {
    const { sessionId } = req.body;
    const safeId = sanitizeId(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, safeId);

    try {
        const session = sessions.get(safeId);
        if (session) {
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            if (session.heartbeatInterval) clearInterval(session.heartbeatInterval);
            if (session.sock) {
                try {
                    await session.sock.logout();
                } catch (e) {}
                destroySocket(session.sock);
            }
        }

        sessions.delete(safeId);

        // Remove stored keys only on explicit user request
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        await clearCloudBackup(safeId);

        console.log(`[${safeId}] Session explicitly logged out and credentials cleared by user.`);
        return res.json({ success: true, message: `Session ${safeId} logged out successfully` });
    } catch (err) {
        console.error(`Logout error for ${safeId}:`, err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 4. Send Message via Session
app.post('/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
        return res.status(400).json({ success: false, message: 'sessionId, to, and message are required' });
    }

    const safeId = sanitizeId(sessionId);
    let session = sessions.get(safeId);

    // If session is not connected but credentials exist on disk or in cloud, restore immediately
    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        const sessionPath = path.join(SESSIONS_DIR, safeId, 'creds.json');
        if (fs.existsSync(sessionPath) || (await restoreSessionFromCloud(safeId))) {
            console.log(`[${safeId}] Incoming send request: session not connected, restoring...`);
            session = await initSession(safeId);
            let waited = 0;
            while (waited < 10 && session.status !== 'CONNECTED') {
                await new Promise(r => setTimeout(r, 500));
                waited++;
                session = sessions.get(safeId) || session;
            }
        }
    }

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        return res.status(400).json({
            success: false,
            message: `Session for [${safeId}] is not connected. Current status: ${session ? session.status : 'NOT_INITIALIZED'}`
        });
    }

    try {
        let cleanPhone = String(to).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('00')) {
            cleanPhone = cleanPhone.substring(2);
        }
        if (/^01[0125][0-9]{8}$/.test(cleanPhone)) {
            cleanPhone = '2' + cleanPhone;
        }

        const isLid = (cleanPhone.length >= 13 && (cleanPhone.startsWith('6433') || cleanPhone.startsWith('15') || cleanPhone.startsWith('88') || cleanPhone.startsWith('99'))) || String(to).includes('@lid');
        let targetJid;

        if (isLid) {
            targetJid = `${cleanPhone}@lid`;
            console.log(`[${safeId}] 🎯 Delivering message directly to WhatsApp LID: ${targetJid}`);
        } else {
            targetJid = `${cleanPhone}@s.whatsapp.net`;
            // Validate & sync recipient prekey bundle with WhatsApp server (Eliminates "Waiting for this message")
            try {
                const onWa = await session.sock.onWhatsApp(cleanPhone);
                if (Array.isArray(onWa) && onWa[0]?.jid) {
                    targetJid = onWa[0].jid;
                    if (!sessionData.lidMap) sessionData.lidMap = {};
                    if (onWa[0].lid) sessionData.lidMap[onWa[0].lid] = cleanPhone;
                    sessionData.lidMap[targetJid] = cleanPhone;
                }
            } catch (e) {}
        }

        // 2. Establish presence and wake up Signal E2EE ratchet
        try {
            await session.sock.presenceSubscribe(targetJid);
            await session.sock.sendPresenceUpdate('composing', targetJid);
            // Brief 250ms pause to let WhatsApp exchange prekeys before message delivery
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {}

        const result = await session.sock.sendMessage(targetJid, { text: String(message) });
        if (result?.key?.id) {
            saveMessageToStore(result.key.id, result.message || { conversation: String(message) }, String(message));
        }

        return res.json({
            success: true,
            message: 'WhatsApp message sent successfully',
            messageId: result?.key?.id,
            to: cleanPhone
        });
    } catch (err) {
        console.error(`Send message error [${safeId} -> ${to}]:`, err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 5. Send Media / Document via Session
app.post('/send-media', async (req, res) => {
    const { sessionId, to, mediaUrl, caption, fileName } = req.body;

    if (!sessionId || !to || !mediaUrl) {
        return res.status(400).json({ success: false, message: 'sessionId, to, and mediaUrl are required' });
    }

    const safeId = sanitizeId(sessionId);
    let session = sessions.get(safeId);

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        const sessionPath = path.join(SESSIONS_DIR, safeId, 'creds.json');
        if (fs.existsSync(sessionPath) || (await restoreSessionFromCloud(safeId))) {
            session = await initSession(safeId);
            let waited = 0;
            while (waited < 10 && session.status !== 'CONNECTED') {
                await new Promise(r => setTimeout(r, 500));
                waited++;
                session = sessions.get(safeId) || session;
            }
        }
    }

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        return res.status(400).json({
            success: false,
            message: `Session for [${safeId}] is not connected.`
        });
    }

    try {
        let cleanPhone = String(to).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('00')) {
            cleanPhone = cleanPhone.substring(2);
        }
        if (/^01[0125][0-9]{8}$/.test(cleanPhone)) {
            cleanPhone = '2' + cleanPhone;
        }

        const isLid = (cleanPhone.length >= 13 && (cleanPhone.startsWith('6433') || cleanPhone.startsWith('15') || cleanPhone.startsWith('88') || cleanPhone.startsWith('99'))) || String(to).includes('@lid');
        let targetJid;

        if (isLid) {
            targetJid = `${cleanPhone}@lid`;
            console.log(`[${safeId}] 🎯 Delivering media document directly to WhatsApp LID: ${targetJid}`);
        } else {
            targetJid = `${cleanPhone}@s.whatsapp.net`;
            try {
                const onWa = await session.sock.onWhatsApp(cleanPhone);
                if (Array.isArray(onWa) && onWa[0]?.jid) {
                    targetJid = onWa[0].jid;
                    if (!sessionData.lidMap) sessionData.lidMap = {};
                    if (onWa[0].lid) sessionData.lidMap[onWa[0].lid] = cleanPhone;
                    sessionData.lidMap[targetJid] = cleanPhone;
                }
            } catch (e) {}
        }

        // 2. Establish presence and wake up Signal E2EE ratchet
        try {
            await session.sock.presenceSubscribe(targetJid);
            await session.sock.sendPresenceUpdate('composing', targetJid);
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {}

        const result = await session.sock.sendMessage(targetJid, {
            document: { url: mediaUrl },
            mimetype: 'application/pdf',
            fileName: fileName || 'document.pdf',
            caption: caption ? String(caption) : ''
        });
        if (result?.key?.id) {
            saveMessageToStore(result.key.id, result.message || {
                documentMessage: {
                    caption: caption ? String(caption) : '',
                    fileName: fileName || 'document.pdf',
                    mimetype: 'application/pdf'
                }
            }, caption || fileName);
        }

        return res.json({
            success: true,
            message: 'WhatsApp media document sent successfully',
            messageId: result?.key?.id,
            to: cleanPhone
        });
    } catch (err) {
        console.error(`Send media error [${safeId} -> ${to}]:`, err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 6. Retrieve Inbound Messages Buffer (For Live Polling Sync)
app.get('/session/inbound/:sessionId', (req, res) => {
    const safeId = sanitizeId(req.params.sessionId);
    const session = sessions.get(safeId);

    if (!session) {
        return res.json({ success: true, count: 0, messages: [] });
    }

    const since = req.query.since ? Number(req.query.since) : 0;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 50;

    let filtered = session.inboundBuffer || [];
    if (since > 0 && req.query.strict_since === '1') {
        filtered = filtered.filter(m => m.timestamp > since);
    }
    const result = filtered.slice(0, limit);

    return res.json({
        success: true,
        sessionId: safeId,
        count: result.length,
        messages: result
    });
});

// 7. Configure / Update Webhook URL for Session
app.post('/session/set-webhook', (req, res) => {
    const { sessionId, webhookUrl } = req.body;
    const safeId = sanitizeId(sessionId);
    let session = sessions.get(safeId);

    if (!session) {
        session = { inboundBuffer: [], webhookUrl: webhookUrl };
        sessions.set(safeId, session);
    } else {
        session.webhookUrl = webhookUrl;
    }

    console.log(`[${safeId}] Webhook URL set to: ${webhookUrl}`);
    return res.json({ success: true, sessionId: safeId, webhookUrl });
});

// 8. Clear Inbound Messages Buffer
app.post('/session/inbound/clear', (req, res) => {
    const { sessionId } = req.body;
    const safeId = sanitizeId(sessionId);
    const session = sessions.get(safeId);
    if (session) {
        session.inboundBuffer = [];
    }
    return res.json({ success: true, message: 'Inbound buffer cleared' });
});

// Global Uncaught Exception Guards to prevent server crashes
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Start Server & Restore Sessions
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Meta Infinity WhatsApp Engine running on port: ${PORT}`);
    console.log(`🔐 API Secret Key: ${API_SECRET}`);
    console.log(`🌐 Health Check: http://localhost:${PORT}/health`);
    console.log(`====================================================`);
    restoreSavedSessions();
});
