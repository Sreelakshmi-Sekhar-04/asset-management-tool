# One image for the web app, the background worker and one-off tasks (migrations).
# Build:  docker build -t itam .
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public && npx prisma generate && npx next build

FROM base AS runtime
ENV NODE_ENV=production
# The worker runs TypeScript through tsx, so the runtime keeps the installed dependencies.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.mjs /app/tsconfig.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/public ./public
RUN mkdir -p /data/storage && chown -R node:node /data /app
USER node
ENV STORAGE_DIR=/data/storage PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
