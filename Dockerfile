FROM node:20-alpine

WORKDIR /app

# تثبيت git عبر Alpine السريع والمستقر جداً
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["npm", "start"]
