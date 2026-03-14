-- Миграция для добавления колонки status в таблицу processed_orders
-- Выполнить в Supabase SQL Editor

-- 1. Добавляем колонку status если её нет
ALTER TABLE processed_orders 
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'READY_FOR_QR';

-- 2. Обновляем существующие записи (если есть)
UPDATE processed_orders 
SET status = 'READY_FOR_QR' 
WHERE status IS NULL;

-- 3. Добавляем индекс для ускорения поиска по status
CREATE INDEX IF NOT EXISTS idx_processed_orders_status 
ON processed_orders(status);

-- 4. Добавляем индекс для комбинированного поиска
CREATE INDEX IF NOT EXISTS idx_processed_orders_external_id_status 
ON processed_orders(external_id, status);

-- Проверка структуры таблицы
-- \d processed_orders
