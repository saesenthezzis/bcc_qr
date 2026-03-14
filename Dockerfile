# ============================================================
# Stage 1: Build (компиляция TypeScript)
# ============================================================
FROM node:20 AS builder

WORKDIR /app

# Копируем package.json и устанавливаем ВСЕ зависимости (включая dev)
COPY package*.json ./
RUN npm ci

# Копируем исходный код и компилируем TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Production (запуск приложения)
# ============================================================
FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

# Копируем package.json и устанавливаем ТОЛЬКО продакшн-зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем результат сборки из Stage 1
COPY --from=builder /app/dist ./dist

# Устанавливаем ТОЛЬКО Chromium (экономия места)
RUN npx playwright install chromium

# Устанавливаем переменную окружения для storage
ENV STORAGE_DIR=/app/storage
ENV NODE_ENV=production

# Создаём директорию для storage
RUN mkdir -p /app/storage

# Запускаем приложение
CMD ["node", "dist/index.js"]
