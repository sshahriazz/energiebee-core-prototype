# syntax=docker/dockerfile:1
# EnergieBee core: nginx (static site + reverse proxy) in front of the Node app, one container.
#
#   docker build -t energiebee-core .
#   docker run -d --name energiebee -p 8080:80 --env-file .env -e DATABASE_URL=postgresql://... -v energiebee-data:/app/data energiebee-core
#   (or docker compose up -d --build, which also runs Postgres)
#
# The environment (credentials, DATABASE_URL, sync settings) is NOT baked into the image: pass your
# .env at run time (--env-file, or env_file in docker-compose.yml). The database is PostgreSQL
# (DATABASE_URL); the entrypoint applies its migrations before the app starts. Raw payloads and logs
# live in /app/data (DATA_DIR): mount a volume there or they are lost with the container.

# ───────────── Stage 1: production dependencies ─────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

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
  DATA_DIR=data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY prisma ./prisma
COPY prisma.config.js ./
# The Prisma client is generated from prisma/schema.prisma into src/generated (not in the repository).
RUN npx prisma generate
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
