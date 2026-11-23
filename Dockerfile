FROM node:20-alpine

WORKDIR /app

# Install git via apk (Alpine is fast, lightweight, and never has debian-security 404 issues)
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persistent sessions directory volume
VOLUME [ "/app/sessions" ]

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["npm", "start"]
