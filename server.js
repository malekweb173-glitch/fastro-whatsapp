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
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.WHATSAPP_ENGINE_SECRET || 'fastro_whatsapp_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory active sessions store
// sessionId -> { sock, status, qr, phone, lastUpdated }
const sessions = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Sanitize sessionId for filesystem safety
function sanitizeId(id) {
    return String(id || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

// Authentication Middleware
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, message: 'Authorization header is missing' });
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token !== API_SECRET) {
        return res.status(403).json({ success: false, message: 'Invalid API secret key' });
    }
    next();
}

/**
 * Initialize or retrieve a Baileys session for a tenant
 */
async function initSession(sessionId) {
    const safeId = sanitizeId(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, safeId);

    if (sessions.has(safeId)) {
        const current = sessions.get(safeId);
        if (current.status === 'CONNECTED' && current.sock) {
            return current;
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: ['GoFastro Logistics', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        retryRequestDelayMs: 250
    });

    const sessionData = {
        sock,
        status: 'INITIALIZING',
        qr: null,
        phone: null,
        lastUpdated: Date.now()
    };
    sessions.set(safeId, sessionData);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr);
                sessionData.qr = qrImage;
                sessionData.status = 'SCAN_QR';
                sessionData.lastUpdated = Date.now();
                console.log(`[${safeId}] QR Code ready for scanning`);
            } catch (err) {
                console.error(`[${safeId}] QR conversion error:`, err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${safeId}] Connection closed. Reason code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.loggedOut) {
                sessionData.status = 'DISCONNECTED';
                sessionData.qr = null;
                sessionData.phone = null;
                sessionData.sock = null;
                // Delete invalid credentials folder
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } catch (e) {}
            } else {
                sessionData.status = 'RECONNECTING';
                setTimeout(() => {
                    initSession(safeId).catch(console.error);
                }, 4000);
            }
        } else if (connection === 'open') {
            const rawJid = sock.user?.id || '';
            const phone = rawJid.split(':')[0].replace(/[^0-9]/g, '');
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            sessionData.phone = phone;
            sessionData.lastUpdated = Date.now();
            console.log(`[${safeId}] Successfully CONNECTED with number: +${phone}`);
        }
    });

    return sessionData;
}

// Auto-restore existing saved sessions on server boot
async function restoreSavedSessions() {
    try {
        const folders = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
        for (const f of folders) {
            if (f.isDirectory() && !f.name.startsWith('.')) {
                console.log(`Restoring session for tenant: ${f.name}`);
                initSession(f.name).catch(console.error);
            }
        }
    } catch (err) {
        console.error('Session restore failed:', err);
    }
}

// --- PUBLIC HEALTH ROUTE ---
app.get(['/', '/health'], (req, res) => {
    let connectedCount = 0;
    sessions.forEach(s => {
        if (s.status === 'CONNECTED') connectedCount++;
    });

    res.json({
        success: true,
        service: 'Fastro WhatsApp Microservice',
        status: 'RUNNING',
        uptime_seconds: Math.floor(process.uptime()),
        total_sessions: sessions.size,
        connected_sessions: connectedCount,
        timestamp: new Date().toISOString()
    });
});

// --- PROTECTED ROUTES ---
app.use(authMiddleware);

// 1. Start or Refresh Session (Request QR)
app.post('/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const safeId = sanitizeId(sessionId);
    try {
        let current = sessions.get(safeId);
        if (!current || !current.sock || current.status === 'DISCONNECTED') {
            current = await initSession(safeId);
        }

        // Wait up to 5 seconds if QR is being generated
        let attempts = 0;
        while (attempts < 10 && current.status !== 'CONNECTED' && !current.qr) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
            current = sessions.get(safeId);
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
app.get('/session/status/:sessionId', (req, res) => {
    const safeId = sanitizeId(req.params.sessionId);
    const session = sessions.get(safeId);

    if (!session) {
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

// 3. Logout / Disconnect Session
app.post('/session/logout', async (req, res) => {
    const { sessionId } = req.body;
    const safeId = sanitizeId(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, safeId);

    try {
        const session = sessions.get(safeId);
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (e) {}
            try {
                session.sock.end();
            } catch (e) {}
        }

        sessions.delete(safeId);

        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        console.log(`[${safeId}] Session logged out and directory removed`);
        return res.json({ success: true, message: `Session ${safeId} disconnected successfully` });
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
    const session = sessions.get(safeId);

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        return res.status(400).json({
            success: false,
            message: `Session for [${safeId}] is not connected. Current status: ${session ? session.status : 'NOT_INITIALIZED'}`
        });
    }

    try {
        let cleanPhone = String(to).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('01')) {
            cleanPhone = '2' + cleanPhone;
        } else if (cleanPhone.startsWith('1') && cleanPhone.length === 10) {
            cleanPhone = '20' + cleanPhone;
        }

        const jid = `${cleanPhone}@s.whatsapp.net`;
        const result = await session.sock.sendMessage(jid, { text: String(message) });

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

// Global Uncaught Exception Guards
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Start Server & Restore Sessions
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Fastro WhatsApp Engine running on port: ${PORT}`);
    console.log(`🔐 API Secret Key: ${API_SECRET}`);
    console.log(`🌐 Health Check: http://localhost:${PORT}/health`);
    console.log(`====================================================`);
    restoreSavedSessions();
});
