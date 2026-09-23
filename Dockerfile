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

# Both agents run from inside the container but sign in with the session mounted
# from the host — see docker-compose.yml and README → Authentication. Which one
# actually runs is AGENT_PROVIDER; both are installed so switching is a restart,
# not a rebuild.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g       @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}       @openai/codex@${CODEX_VERSION}     && npm cache clean --force

# Matching the host uid keeps the mounted ~/.claude writable, which token
# refresh depends on. Override with --build-arg on Linux hosts.
ARG APP_UID=1001
ARG APP_GID=1001
# node:22-slim already ships a `node` user at uid/gid 1000, which is exactly the id a
# Linux host passes in. Adopt whatever already holds the id instead of failing to add a
# duplicate -- the old `|| true` hid that failure until `USER app` could not resolve.
RUN set -eu; \
    if getent group ${APP_GID} >/dev/null; then \
      g=$(getent group ${APP_GID} | cut -d: -f1); \
      [ "$g" = app ] || groupmod -n app "$g"; \
    else groupadd -g ${APP_GID} app; fi; \
    if getent passwd ${APP_UID} >/dev/null; then \
      u=$(getent passwd ${APP_UID} | cut -d: -f1); \
      [ "$u" = app ] || usermod -l app -d /home/app -m -s /bin/bash "$u"; \
      usermod -g ${APP_GID} app; \
    else useradd -m -u ${APP_UID} -g ${APP_GID} -s /bin/bash app; fi; \
    mkdir -p /home/app; chown ${APP_UID}:${APP_GID} /home/app

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
    DB_PATH=/data/db/morningmate-alert.db \
    ROUTES_FILE=/app/routes.yml \
    CLAUDE_HOME=/home/app/.claude \
    CODEX_HOME=/home/app/.codex

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

CMD ["node", "dist/server.js"]
