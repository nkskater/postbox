# syntax=docker/dockerfile:1
# ---- build stage: compiles better-sqlite3 and the Next.js standalone bundle
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/postbox.db
RUN groupadd --system --gid 1001 postbox && useradd --system --uid 1001 --gid postbox postbox \
    && mkdir -p /data && chown postbox:postbox /data
COPY --from=build --chown=postbox:postbox /app/.next/standalone ./
COPY --from=build --chown=postbox:postbox /app/.next/static ./.next/static
COPY --from=build --chown=postbox:postbox /app/public ./public
COPY --from=build --chown=postbox:postbox /app/drizzle ./drizzle
COPY --from=build --chown=postbox:postbox /app/dist /opt/postbox-cli
RUN ln -s /opt/postbox-cli/cli.mjs /usr/local/bin/postbox-cli
USER postbox
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
