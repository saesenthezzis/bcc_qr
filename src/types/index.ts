export type OrderStatus = 'READY_FOR_QR' | 'PENDING';
export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'READY_FOR_QR' | 'COMPLETED';

export interface Order {
  external_id: string;
  amount: number;
  status: OrderStatus;
}

export interface ProcessedOrder {
  external_id: string;
  amount: number;
  status: ProcessStatus;
  created_at: string;
}

export interface Config {
  bankUrl: string;
  bankLogin: string;
  bankPassword: string;
  telegramBotToken: string;
  telegramChatIds: string[];
  supabaseUrl: string;
  supabaseKey: string;
}
