FROM node:20 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN npx playwright install chromium

ENV STORAGE_DIR=/app/storage
ENV NODE_ENV=production
ENV PORT=3000
ENV RENDER=true

RUN mkdir -p /app/storage

EXPOSE 3000

CMD ["node", "--max-old-space-size=450", "dist/index.js"]
