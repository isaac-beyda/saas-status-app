FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# No npm dependencies — the app uses only Node built-ins (http, sqlite).
COPY package.json ./
COPY server ./server
COPY public ./public

# SQLite data lives on a volume so history survives redeploys
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080
ENV PORT=8080 DB_PATH=/app/data/status.db POLL_INTERVAL_MS=300000 FETCH_TIMEOUT_MS=20000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

USER node
CMD ["node", "server/index.js"]
