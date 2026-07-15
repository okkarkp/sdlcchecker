FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Remove local-only files
RUN rm -rf dist uploads .env playwright-tests/generated

ENV NODE_ENV=production
ENV PORT=8080
ENV UPLOAD_DIR=/tmp

EXPOSE 8080
CMD ["node", "server.js"]
