FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код и компилируем TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Устанавливаем переменную окружения для storage
ENV STORAGE_DIR=/app/storage

# Создаём директорию для storage
RUN mkdir -p /app/storage

# Запускаем приложение
CMD ["node", "dist/index.js"]
