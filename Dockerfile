FROM node:26.3.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
RUN npm run build && npm prune --omit=dev
FROM node:26.3.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production BOJI_HOST=0.0.0.0 BOJI_DATA_DIR=/data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server/index.js"]
