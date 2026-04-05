import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../utils/Logger';
import { OrderStatus, Order, SmsConfirmation, SmsStatus } from '../types';

export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'READY_FOR_QR' | 'COMPLETED';

export class RegistryAgent {
  private client: SupabaseClient;
  private readonly SESSION_ID = 'bcc_bank_session';
  private readonly logger: Logger;

  constructor(supabaseUrl: string, supabaseKey: string, logger: Logger) {
    this.client = createClient(supabaseUrl, supabaseKey);
    this.logger = logger;
  }

  async checkWithStatus(externalId: string): Promise<{ exists: boolean; status: ProcessStatus | null; dbError: boolean }> {
    try {
      const { data, error } = await this.client
        .from('processed_orders')
        .select('external_id, status')
        .eq('external_id', externalId)
        .single();

      if (error && error.code !== 'PGRST116') {
        this.logger.error(`Registry checkWithStatus error: ${error.message}`);
        return { exists: false, status: null, dbError: true };
      }

      if (!data) {
        return { exists: false, status: null, dbError: false };
      }

      return { exists: true, status: data.status as ProcessStatus, dbError: false };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to check order ${externalId}: ${errorMsg}`);
      return { exists: false, status: null, dbError: true };
    }
  }

  async reserveOrder(externalId: string, amount: number): Promise<boolean> {
    try {
      const { error } = await this.client
        .from('processed_orders')
        .insert({
          external_id: externalId,
          amount: amount,
          status: 'PROCESSING',
        });

      if (error) {
        if (error.code === '23505') {
          this.logger.warn(`Order ${externalId} already reserved by another process`);
          return false;
        }
        this.logger.error(`Registry reserveOrder error: ${error.message}`);
        throw new Error(`Database insert failed: ${error.message}`);
      }

      this.logger.info(`Order ${externalId} reserved with status PROCESSING`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to reserve order ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async updateOrderStatus(externalId: string, newStatus: ProcessStatus): Promise<void> {
    try {
      const { error } = await this.client
        .from('processed_orders')
        .update({ status: newStatus })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry updateOrderStatus error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`Order ${externalId} status updated to ${newStatus}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update order status ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async shouldProcessOrder(order: Order): Promise<{
    shouldProcess: boolean;
    reason: 'NEW' | 'STATUS_CHANGED' | 'ALREADY_PROCESSED' | 'DB_ERROR';
    currentStatus?: ProcessStatus;
  }> {
    try {
      const smsConfirmation = await this.getSmsConfirmation(order.external_id);
      if (order.status === 'PENDING' && smsConfirmation && smsConfirmation.sent_count >= 3) {
        this.logger.info(`Order ${order.external_id} skipped: SMS sent_count limit reached (${smsConfirmation.sent_count})`);
        return { shouldProcess: false, reason: 'ALREADY_PROCESSED' };
      }

      const result = await this.checkWithStatus(order.external_id);

      // Критично: если БД не ответила — останавливаем обработку
      // Логика: "Не уверен — не стреляй"
      if (result.dbError) {
        this.logger.error(`Registry unavailable for order ${order.external_id}, blocking to prevent duplicates`);
        return { shouldProcess: false, reason: 'DB_ERROR' };
      }

      if (!result.exists) {
        return { shouldProcess: true, reason: 'NEW' };
      }

      if (result.status === 'PROCESSING') {
        this.logger.warn(`Order ${order.external_id} is being processed by another instance`);
        return { shouldProcess: false, reason: 'ALREADY_PROCESSED', currentStatus: result.status ?? undefined };
      }

      if (result.status === 'PENDING' && order.status === 'READY_FOR_QR') {
        return { shouldProcess: true, reason: 'STATUS_CHANGED', currentStatus: result.status ?? undefined };
      }

      if (result.status === order.status || result.status === 'READY_FOR_QR' || result.status === 'COMPLETED') {
        return { shouldProcess: false, reason: 'ALREADY_PROCESSED', currentStatus: result.status ?? undefined };
      }

      return { shouldProcess: false, reason: 'ALREADY_PROCESSED', currentStatus: result.status ?? undefined };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Registry unavailable for order ${order.external_id}: ${errorMsg}`);
      return { shouldProcess: false, reason: 'DB_ERROR' };
    }
  }

  async register(externalId: string, amount: number, status: ProcessStatus): Promise<void> {
    try {
      const { error } = await this.client
        .from('processed_orders')
        .insert({
          external_id: externalId,
          amount: amount,
          status: status,
        });

      if (error) {
        this.logger.error(`Registry register error: ${error.message}`);
        throw new Error(`Database insert failed: ${error.message}`);
      }

      this.logger.info(`Order ${externalId} registered in database with status ${status}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to register order ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async saveSessionToDb(sessionData: any): Promise<boolean> {
    try {
      const { error } = await this.client
        .from('bot_sessions')
        .upsert({
          id: this.SESSION_ID,
          data: sessionData,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'id',
        });

      if (error) {
        this.logger.error(`Registry saveSession error: ${error.message}`);
        return false;
      }

      this.logger.info('Session saved to Supabase');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save session: ${errorMsg}`);
      return false;
    }
  }

  async loadSessionFromDb(): Promise<any | null> {
    try {
      const { data, error } = await this.client
        .from('bot_sessions')
        .select('data')
        .eq('id', this.SESSION_ID)
        .single();

      if (error && error.code !== 'PGRST116') {
        this.logger.error(`Registry loadSession error: ${error.message}`);
        return null;
      }

      if (data) {
        this.logger.info('Session loaded from Supabase');
        return data.data;
      }

      this.logger.info('No session found in Supabase');
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load session: ${errorMsg}`);
      return null;
    }
  }

  async deleteSessionFromDb(): Promise<boolean> {
    try {
      const { error } = await this.client
        .from('bot_sessions')
        .delete()
        .eq('id', this.SESSION_ID);

      if (error) {
        this.logger.error(`Registry deleteSession error: ${error.message}`);
        return false;
      }

      this.logger.info('Session deleted from Supabase');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to delete session: ${errorMsg}`);
      return false;
    }
  }

  // SMS Confirmation Methods

  async registerSmsConfirmation(externalId: string, amount: number, status: SmsStatus, telegramMessageId?: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('sms_confirmations')
        .insert({
          external_id: externalId,
          amount: amount,
          status: status,
          sms_attempts: 0,
          sent_count: 0,
          telegram_message_id: telegramMessageId,
        });

      if (error) {
        if (error.code === '23505') {
          this.logger.warn(`SMS confirmation for ${externalId} already exists`);
          return;
        }
        this.logger.error(`Registry registerSmsConfirmation error: ${error.message}`);
        throw new Error(`Database insert failed: ${error.message}`);
      }

      this.logger.info(`SMS confirmation registered for ${externalId} with status ${status}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to register SMS confirmation ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async getSmsConfirmation(externalId: string): Promise<SmsConfirmation | null> {
    try {
      const { data, error } = await this.client
        .from('sms_confirmations')
        .select('*')
        .eq('external_id', externalId)
        .single();

      if (error && error.code !== 'PGRST116') {
        this.logger.error(`Registry getSmsConfirmation error: ${error.message}`);
        return null;
      }

      return data as SmsConfirmation | null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get SMS confirmation ${externalId}: ${errorMsg}`);
      return null;
    }
  }

  async updateSmsAttempts(externalId: string): Promise<number> {
    try {
      const current = await this.getSmsConfirmation(externalId);
      if (!current) {
        this.logger.warn(`SMS confirmation ${externalId} not found for attempt update`);
        return 0;
      }

      const newAttempts = current.sms_attempts + 1;

      const { error } = await this.client
        .from('sms_confirmations')
        .update({ sms_attempts: newAttempts })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry updateSmsAttempts error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`SMS attempts for ${externalId} updated to ${newAttempts}`);
      return newAttempts;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update SMS attempts ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async checkSmsAttempts(externalId: string): Promise<{ attempts: number; limitExceeded: boolean }> {
    try {
      const confirmation = await this.getSmsConfirmation(externalId);
      if (!confirmation) {
        return { attempts: 0, limitExceeded: false };
      }

      const maxAttempts = parseInt(process.env.SMS_MAX_ATTEMPTS || '3', 10);
      return {
        attempts: confirmation.sms_attempts,
        limitExceeded: confirmation.sms_attempts >= maxAttempts,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to check SMS attempts ${externalId}: ${errorMsg}`);
      return { attempts: 0, limitExceeded: false };
    }
  }

  async updateSmsStatus(externalId: string, newStatus: SmsStatus): Promise<void> {
    try {
      const { error } = await this.client
        .from('sms_confirmations')
        .update({ status: newStatus })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry updateSmsStatus error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`SMS confirmation ${externalId} status updated to ${newStatus}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update SMS status ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async incrementSentCount(externalId: string): Promise<number> {
    try {
      const current = await this.getSmsConfirmation(externalId);
      if (!current) {
        this.logger.warn(`SMS confirmation ${externalId} not found for sent_count increment`);
        return 0;
      }

      const newCount = current.sent_count + 1;

      const { error } = await this.client
        .from('sms_confirmations')
        .update({ 
          sent_count: newCount,
          last_sent_at: new Date().toISOString()
        })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry incrementSentCount error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`SMS sent_count for ${externalId} incremented to ${newCount}`);
      return newCount;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to increment sent_count ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async updateSmsStatusWithCount(externalId: string, newStatus: SmsStatus): Promise<void> {
    try {
      const current = await this.getSmsConfirmation(externalId);
      if (!current) {
        this.logger.warn(`SMS confirmation ${externalId} not found for status update`);
        return;
      }

      const newCount = current.sent_count + 1;

      const { error } = await this.client
        .from('sms_confirmations')
        .update({ 
          status: newStatus,
          sent_count: newCount,
          last_sent_at: new Date().toISOString()
        })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry updateSmsStatusWithCount error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`SMS confirmation ${externalId} updated: status=${newStatus}, sent_count=${newCount}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update SMS status with count ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async getPendingConfirmations(): Promise<SmsConfirmation[]> {
    const finalStatuses = [
      'SMS_CONFIRMED', 
      'USER_REFUSED_SMS', 
      'IGNORED',
      'SMS_BLOCKED', 
      'COMPLETED_EXTERNALLY'
    ];
    const { data, error } = await this.client
      .from('sms_confirmations')
      .select('*')
      .not('status', 'in', `(${finalStatuses.map(s => `"${s}"`).join(',')})`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []) as SmsConfirmation[];
  }

  async findConfirmationByPartialId(partialId: string): Promise<SmsConfirmation | null> {
    const { data, error } = await this.client
      .from('sms_confirmations')
      .select('*')
      .ilike('external_id', `%${partialId}`)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    if (error) return null;
    return data as SmsConfirmation;
  }

  async clearStaleConfirmations(): Promise<number> {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const staleStatuses = ['WAITING_FOR_USER_ACTION', 'SMS_SENT', 'SMS_TIMEOUT'];
    const { data, error } = await this.client
      .from('sms_confirmations')
      .delete()
      .in('status', staleStatuses)
      .lt('updated_at', thirtyMinutesAgo)
      .select();
    if (error) throw error;
    return data?.length || 0;
  }

  async updateTelegramMessageId(externalId: string, messageId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('sms_confirmations')
        .update({ telegram_message_id: messageId })
        .eq('external_id', externalId);

      if (error) {
        this.logger.error(`Registry updateTelegramMessageId error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      this.logger.info(`Telegram message ID updated for ${externalId}: ${messageId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update telegram message ID ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  // SMS Locking Methods

  async acquireSmsLock(orderId: string): Promise<boolean> {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const now = new Date();
    
    try {
      // Use atomic update with condition to handle race conditions properly
      // Check if lock exists and is older than 10 minutes, or doesn't exist
      const tenMinutesAgo = new Date(now.getTime() - TEN_MINUTES_MS).toISOString();
      
      const { data: existingRecords, error: selectError } = await this.client
        .from('sms_confirmations')
        .select('sms_lock_acquired_at, sms_lock_order_id')
        .eq('external_id', orderId);
      
      if (selectError) {
        this.logger.error(`[LOCK] Failed to check existing lock for ${orderId}: ${selectError.message}`);
        return false;
      }
      
      const existingRecord = existingRecords?.[0];
      let shouldCreateNew = false;
      
      if (!existingRecord) {
        // No record exists, need to create one
        shouldCreateNew = true;
      } else if (existingRecord.sms_lock_acquired_at) {
        // Check if existing lock is stale
        const lockAge = now.getTime() - new Date(existingRecord.sms_lock_acquired_at).getTime();
        if (lockAge < TEN_MINUTES_MS) {
          // Lock is still valid
          this.logger.debug(`[LOCK] Valid lock exists for ${orderId}, owned by ${existingRecord.sms_lock_order_id}`);
          return false;
        }
        // Lock is expired, will update existing record
      }
      // If existing record has no lock (sms_lock_acquired_at is null), we can acquire it
      
      if (shouldCreateNew) {
        // Create new record with lock
        const { error: insertError } = await this.client
          .from('sms_confirmations')
          .insert({
            external_id: orderId,
            amount: 0, // Will be updated later when actual amount is known
            status: 'WAITING_FOR_USER_ACTION',
            sms_attempts: 0,
            sent_count: 0,
            sms_lock_acquired_at: now.toISOString(),
            sms_lock_order_id: orderId
          });
        
        if (insertError) {
          this.logger.error(`[LOCK] Failed to create SMS confirmation with lock for ${orderId}: ${insertError.message}`);
          return false;
        }
      } else {
        // Update existing record to acquire lock
        const { error: updateError } = await this.client
          .from('sms_confirmations')
          .update({ 
            sms_lock_acquired_at: now.toISOString(),
            sms_lock_order_id: orderId
          })
          .eq('external_id', orderId);
        
        if (updateError) {
          this.logger.error(`[LOCK] Failed to acquire lock for ${orderId}: ${updateError.message}`);
          return false;
        }
      }
      
      this.logger.info(`[LOCK] Successfully acquired lock for ${orderId}`);
      return true;
      
    } catch (error) {
      this.logger.error(`[LOCK] Unexpected error acquiring lock for ${orderId}: ${error}`);
      return false;
    }
  }

  async releaseSmsLock(orderId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('sms_confirmations')
        .update({ 
          sms_lock_acquired_at: null,
          sms_lock_order_id: null
        })
        .eq('external_id', orderId);
      
      if (error) {
        this.logger.error(`[LOCK] Failed to release lock for ${orderId}: ${error.message}`);
      } else {
        this.logger.info(`[LOCK] Successfully released lock for ${orderId}`);
      }
    } catch (error) {
      this.logger.error(`[LOCK] Unexpected error releasing lock for ${orderId}: ${error}`);
    }
  }

  async getSmsLockStatus(): Promise<{ isLocked: boolean; orderId: string | null }> {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - TEN_MINUTES_MS).toISOString();
    
    const { data, error } = await this.client
      .from('sms_confirmations')
      .select('external_id, sms_lock_acquired_at')
      .not('sms_lock_acquired_at', 'is', null)
      .gte('sms_lock_acquired_at', cutoffTime)
      .order('sms_lock_acquired_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows found"
      this.logger.error(`Registry: Error fetching SMS lock status: ${error.message}`);
      return { isLocked: false, orderId: null };
    }

    if (data) {
      return { 
        isLocked: true, 
        orderId: data.external_id 
      };
    }

    return { isLocked: false, orderId: null };
  }
}
