import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../utils/Logger';
import { OrderStatus, Order } from '../types';

export type ProcessStatus = 'PENDING' | 'PROCESSING' | 'READY_FOR_QR' | 'COMPLETED';

export class RegistryAgent {
  private client: SupabaseClient;
  private readonly SESSION_ID = 'bcc_bank_session';

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async checkWithStatus(externalId: string): Promise<{ exists: boolean; status: ProcessStatus | null; dbError: boolean }> {
    try {
      const { data, error } = await this.client
        .from('processed_orders')
        .select('external_id, status')
        .eq('external_id', externalId)
        .single();

      if (error && error.code !== 'PGRST116') {
        Logger.error(`Registry checkWithStatus error: ${error.message}`);
        return { exists: false, status: null, dbError: true };
      }

      if (!data) {
        return { exists: false, status: null, dbError: false };
      }

      return { exists: true, status: data.status as ProcessStatus, dbError: false };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to check order ${externalId}: ${errorMsg}`);
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
          Logger.warn(`Order ${externalId} already reserved by another process`);
          return false;
        }
        Logger.error(`Registry reserveOrder error: ${error.message}`);
        throw new Error(`Database insert failed: ${error.message}`);
      }

      Logger.info(`Order ${externalId} reserved with status PROCESSING`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to reserve order ${externalId}: ${errorMsg}`);
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
        Logger.error(`Registry updateOrderStatus error: ${error.message}`);
        throw new Error(`Database update failed: ${error.message}`);
      }

      Logger.info(`Order ${externalId} status updated to ${newStatus}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to update order status ${externalId}: ${errorMsg}`);
      throw error;
    }
  }

  async shouldProcessOrder(order: Order): Promise<{
    shouldProcess: boolean;
    reason: 'NEW' | 'STATUS_CHANGED' | 'ALREADY_PROCESSED' | 'DB_ERROR';
    currentStatus?: ProcessStatus;
  }> {
    try {
      const result = await this.checkWithStatus(order.external_id);

      // Критично: если БД не ответила — останавливаем обработку
      // Логика: "Не уверен — не стреляй"
      if (result.dbError) {
        Logger.error(`Registry unavailable for order ${order.external_id}, blocking to prevent duplicates`);
        return { shouldProcess: false, reason: 'DB_ERROR' };
      }

      if (!result.exists) {
        return { shouldProcess: true, reason: 'NEW' };
      }

      if (result.status === 'PROCESSING') {
        Logger.warn(`Order ${order.external_id} is being processed by another instance`);
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
      Logger.error(`Registry unavailable for order ${order.external_id}: ${errorMsg}`);
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
        Logger.error(`Registry register error: ${error.message}`);
        throw new Error(`Database insert failed: ${error.message}`);
      }

      Logger.info(`Order ${externalId} registered in database with status ${status}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to register order ${externalId}: ${errorMsg}`);
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
        Logger.error(`Registry saveSession error: ${error.message}`);
        return false;
      }

      Logger.info('Session saved to Supabase');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to save session: ${errorMsg}`);
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
        Logger.error(`Registry loadSession error: ${error.message}`);
        return null;
      }

      if (data) {
        Logger.info('Session loaded from Supabase');
        return data.data;
      }

      Logger.info('No session found in Supabase');
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to load session: ${errorMsg}`);
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
        Logger.error(`Registry deleteSession error: ${error.message}`);
        return false;
      }

      Logger.info('Session deleted from Supabase');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to delete session: ${errorMsg}`);
      return false;
    }
  }
}
