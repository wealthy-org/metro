# Phase 14 (KL-40): the daily sampling cron. Node 24 runs the TypeScript sources directly (type stripping), so there
# is no build step; production dependencies are enough. The container writes to Neon through DATABASE_URL.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY src ./src
COPY config ./config

CMD ["node", "scripts/sample-yesterday.ts"]
