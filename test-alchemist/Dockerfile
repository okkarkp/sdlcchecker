# Test Alchemist container — same image for local Docker and a central deploy.
# Debian (glibc) base so Playwright/Chromium runs reliably (unlike Alpine/musl).
FROM node:20-bookworm-slim
WORKDIR /app

# Build tools for better-sqlite3's native module (it compiles from source when no
# prebuilt binary matches the platform). Kept in the image for simplicity; a
# multi-stage build could trim them later if image size matters.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching (package.json present so npx resolves).
COPY package*.json ./
RUN npm ci --omit=dev

# Install the Chromium the app drives, plus its OS libraries — so the browser agent
# works in the container. Call the CLI directly: the `.bin/playwright` symlink points
# at @playwright/test (a devDependency omitted here), so `npx playwright` isn't found.
RUN node node_modules/playwright/cli.js install --with-deps chromium

# App source (secrets, node_modules, and local state are excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOAD_DIR=/tmp
# SQLite lives here; mount a volume so data survives container restarts/redeploys.
VOLUME ["/app/data"]

EXPOSE 3000

# Basic liveness check for orchestrators (compose / ECS / EB).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
