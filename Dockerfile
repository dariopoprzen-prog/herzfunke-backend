FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# Persistenz: Volume nach /data mounten und DATA_DIR=/data setzen
CMD ["node", "server.js"]
