FROM node:18-bullseye-slim

WORKDIR /app

# Install basic dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persistent sessions directory volume
VOLUME [ "/app/sessions" ]

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["npm", "start"]
