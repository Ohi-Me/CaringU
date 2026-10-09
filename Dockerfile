# CareCircle: one container serves the MCP endpoint (/mcp), the agent API and the web client.
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/carecircle.db WEB_DIST=/app/web/dist NODE_NO_WARNINGS=1
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
