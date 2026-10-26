# syntax=docker/dockerfile:1
# EnergieBee core: nginx (static site + reverse proxy) in front of the Node app, one container.
#
#   docker build -t energiebee-core .
#   docker run -d --name energiebee -p 8080:80 --env-file .env -v energiebee-data:/app/data energiebee-core
#
# The environment (credentials, DB_FILE, sync settings) is NOT baked into the image: pass your
# .env at run time (--env-file, or env_file in docker-compose.yml). Data (database, raw payloads,
# logs) lives in /app/data: mount a volume there or it is lost with the container.

# ───────────── Stage 1: production dependencies ─────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ───────────── Stage 2: runtime (nginx + node) ─────────────
FROM node:22-alpine AS runtime
# nginx serves public/ and proxies /api/; tini reaps processes and forwards signals;
# su-exec drops the app to the unprivileged node user; tzdata for local-time work.
RUN apk add --no-cache nginx tini su-exec tzdata \
 && mkdir -p /run/nginx /app/data \
 && chown -R node:node /app

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4100 \
    DB_FILE=data/core.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# Read at run time by the Compatibility page and the coverage check.
COPY docs/coverage-matrix.json docs/coverage-gaps.md docs/database.md docs/predbat-predheat-requirements.md docs/predbat-predheat-coverage.md ./docs/
COPY .env.example ./.env.example
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /app

VOLUME ["/app/data"]
# Only nginx is published. The Node app listens on 127.0.0.1:4100 inside the container.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/api/status || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
