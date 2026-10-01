# Office Tracker backend, as a long-running server (not serverless).
#
# Run by deploy/docker-compose.yml. Secrets come from an env file at run time,
# never from the image.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 is only used by an old one-off migration
# script and would otherwise compile a native module for nothing.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY config ./config
COPY scripts ./scripts

# Local fallback storage (documents, backups) when object storage is not
# configured; a named volume in docker-compose keeps it across rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 5000
CMD ["node", "src/server.js"]
