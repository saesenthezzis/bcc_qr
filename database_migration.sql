-- Миграция для CreditBridge RPA Engine
-- Выполнить в Supabase SQL Editor

-- 1. Создаем таблицу для обработки заказов с новыми статусами
CREATE TABLE IF NOT EXISTS processed_orders (
  external_id TEXT UNIQUE NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT status_check CHECK (status IN ('PENDING', 'PROCESSING', 'READY_FOR_QR', 'COMPLETED'))
);

-- 2. Создаем таблицу для сессий
CREATE TABLE IF NOT EXISTS bot_sessions (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Индексы для ускорения поиска
CREATE INDEX IF NOT EXISTS idx_processed_orders_status ON processed_orders(status);
CREATE INDEX IF NOT EXISTS idx_processed_orders_external_id ON processed_orders(external_id);
CREATE INDEX IF NOT EXISTS idx_processed_orders_created_at ON processed_orders(created_at);

-- 4. Включаем RLS
ALTER TABLE processed_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;

-- 5. Политики доступа (для service role)
CREATE POLICY "Allow all for service role on orders" 
  ON processed_orders 
  USING (true) 
  WITH CHECK (true);

CREATE POLICY "Allow all for service role on sessions" 
  ON bot_sessions 
  USING (true) 
  WITH CHECK (true);

-- 6. Миграция существующих данных (если есть)
UPDATE processed_orders 
SET status = 'COMPLETED' 
WHERE status = 'READY_FOR_QR';
