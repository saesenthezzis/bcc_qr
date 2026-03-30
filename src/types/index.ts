export type OrderStatus = 'READY_FOR_QR' | 'PENDING';
export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'READY_FOR_QR' | 'COMPLETED';
export type SmsStatus = 
  | 'WAITING_FOR_USER_ACTION'  // Ждет решения админа
  | 'SMS_SENT'                 // СМС отправлен
  | 'SMS_BLOCKED'              // Заблокирован банком
  | 'USER_REFUSED_SMS'         // Админ отказался
  | 'SMS_TIMEOUT'              // Истек таймаут 5 мин
  | 'COMPLETED';               // Успешно завершено

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
