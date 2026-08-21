# ─── build ────────────────────────────────────────────────────
FROM node:22-slim AS build

# better-sqlite3 falls back to compiling when no prebuild matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev


# ─── runtime ──────────────────────────────────────────────────
FROM node:22-slim

# git and ripgrep are the agent's working tools; ripgrep is what makes Grep fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code runs from inside the container but signs in with the session
# mounted from the host — see docker-compose.yml and README → Authentication.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Matching the host uid keeps the mounted ~/.claude writable, which token
# refresh depends on. Override with --build-arg on Linux hosts.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd -g ${APP_GID} app 2>/dev/null || true \
 && useradd -m -u ${APP_UID} -g ${APP_GID} -s /bin/bash app 2>/dev/null || true

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY routes.yml ./routes.yml

RUN mkdir -p /data/work /data/cache /data/db && chown -R ${APP_UID}:${APP_GID} /data /app

USER app
ENV NODE_ENV=production \
    HOME=/home/app \
    PORT=8080 \
    WORKSPACE_DIR=/data/work \
    CACHE_DIR=/data/cache \
    DB_PATH=/data/db/branchsmith.db \
    ROUTES_FILE=/app/routes.yml \
    CLAUDE_HOME=/home/app/.claude

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

CMD ["node", "dist/server.js"]
