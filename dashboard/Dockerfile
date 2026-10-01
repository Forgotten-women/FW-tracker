# HR dashboard (Next.js). The /api rewrite in next.config.ts is fixed at build
# time, so API_ORIGIN is a build argument: inside docker compose it is the
# backend service on the private network.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG API_ORIGIN=http://backend:5000
ENV API_ORIGIN=$API_ORIGIN NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# public/ is empty and git doesn't keep empty folders; Next serves it if present.
RUN mkdir -p public && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
