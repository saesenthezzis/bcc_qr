import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../utils/Logger';
import { OrderStatus, Order } from '../types';

export class RegistryAgent {
  private client: SupabaseClient;
  private readonly SESSION_ID = 'bcc_bank_session';

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  async check(externalId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from('processed_orders')
        .select('external_id')
        .eq('external_id', externalId)
        .single();

      if (error && error.code !== 'PGRST116') {
        Logger.error(`Registry check error: ${error.message}`);
        throw error;
      }

      return !data;
    } catch (error) {
      Logger.error(`Failed to check order ${externalId}: ${error}`);
      throw error;
    }
  }

  async getOrderStatus(externalId: string): Promise<OrderStatus | null> {
    try {
      const { data, error } = await this.client
        .from('processed_orders')
        .select('status')
        .eq('external_id', externalId)
        .single();

      if (error && error.code !== 'PGRST116') {
        Logger.error(`Registry getOrderStatus error: ${error.message}`);
        return null;
      }

      return data?.status as OrderStatus || null;
    } catch (error) {
      Logger.error(`Failed to get order status ${externalId}: ${error}`);
      return null;
    }
  }

  async updateOrderStatus(externalId: string, newStatus: OrderStatus): Promise<void> {
    try {
      const { error } = await this.client
        .from('processed_orders')
        .update({ status: newStatus })
        .eq('external_id', externalId);

      if (error) {
        Logger.error(`Registry updateOrderStatus error: ${error.message}`);
        throw error;
      }

      Logger.info(`Order ${externalId} status updated to ${newStatus}`);
    } catch (error) {
      Logger.error(`Failed to update order status ${externalId}: ${error}`);
      throw error;
    }
  }

  async register(externalId: string, amount: number, status: OrderStatus): Promise<void> {
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
        throw error;
      }

      Logger.info(`Order ${externalId} registered in database with status ${status}`);
    } catch (error) {
      Logger.error(`Failed to register order ${externalId}: ${error}`);
      throw error;
    }
  }

  async shouldProcessOrder(order: Order): Promise<{
    shouldProcess: boolean;
    reason: 'NEW' | 'STATUS_CHANGED' | 'ALREADY_PROCESSED';
    currentStatus?: OrderStatus;
  }> {
    const existingStatus = await this.getOrderStatus(order.external_id);

    if (existingStatus === null) {
      return { shouldProcess: true, reason: 'NEW' };
    }

    if (existingStatus === 'PENDING' && order.status === 'READY_FOR_QR') {
      return { shouldProcess: true, reason: 'STATUS_CHANGED', currentStatus: existingStatus };
    }

    if (existingStatus === order.status) {
      return { shouldProcess: false, reason: 'ALREADY_PROCESSED', currentStatus: existingStatus };
    }

    return { shouldProcess: false, reason: 'ALREADY_PROCESSED', currentStatus: existingStatus };
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
      Logger.error(`Failed to save session: ${error}`);
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
      Logger.error(`Failed to load session: ${error}`);
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
      Logger.error(`Failed to delete session: ${error}`);
      return false;
    }
  }
}
