export type OrderStatus = 'READY_FOR_QR' | 'PENDING';
export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'READY_FOR_QR' | 'COMPLETED';
export type SmsStatus =
  | 'WAITING_FOR_USER_ACTION'
  | 'SMS_SENT'
  | 'SMS_CONFIRMED'
  | 'SMS_BLOCKED'
  | 'USER_REFUSED_SMS'
  | 'IGNORED'
  | 'SMS_TIMEOUT'
  | 'COMPLETED_EXTERNALLY';

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

export interface SmsConfirmation {
  external_id: string;
  amount: number;
  iin?: string;
  status: SmsStatus;
  sms_attempts: number;
  sent_count: number;
  last_sent_at?: string;
  telegram_message_id?: string;
  created_at: string;
  updated_at: string;
  locked_at?: string;
  locked_by?: string;
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

export interface OrderData {
  installmentPeriod: string | null;
}

export interface OrderAttributes {
  external_id: string;
  iin?: string;
  amount: number;
}
