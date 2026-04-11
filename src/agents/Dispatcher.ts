import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/Logger';
import { SurveillanceAgent } from './Surveillance';
import { RegistryAgent } from './Registry';
import { SmsFlowStatus } from '../types/SmsFlowStatus';
import { OrderAttributes } from '../types';

export interface ChatWithThread {
  chatId: number;
  threadId?: number;
}

export interface SmsCodeReplyContext {
  orderId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
  timestamp: number;
}

interface TelegramMessageRef {
  chatId: number;
  messageId: number;
  threadId?: number;
  timestamp: number;
}

export class DispatcherAgent {
  private bot: Telegraf<Context>;
  private allowedChats: ChatWithThread[];
  private adminChatId: number | null;
  private silentMode: boolean = true;
  private readonly logger: Logger;
  private surveillanceAgent: SurveillanceAgent | null = null;
  private isWaitingForSms: boolean = false;
  private smsCodeReplyContexts: Map<string, SmsCodeReplyContext> = new Map();
  private smsCodeCallbacks: Map<string, (code: string) => void> = new Map();
  private decisionMessageRefs: Map<string, Map<number, TelegramMessageRef>> = new Map();
  private codeMessageRefs: Map<string, Map<number, TelegramMessageRef>> = new Map();
  private decisionIntervals: Map<string, NodeJS.Timeout> = new Map();
  private codeIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly MESSAGE_REF_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(botToken: string, chatIds: string[], logger: Logger, adminId?: string, surveillanceAgent?: SurveillanceAgent) {
    this.bot = new Telegraf(botToken);
    this.logger = logger;
    this.allowedChats = chatIds.map((idStr) => {
      const parts = idStr.split(':');
      const chatId = parseInt(parts[0], 10);
      const threadId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;
      return { chatId, threadId };
    });
    this.adminChatId = process.env.TELEGRAM_ADMIN_ID 
      ? parseInt(process.env.TELEGRAM_ADMIN_ID, 10) 
      : null;
    this.surveillanceAgent = surveillanceAgent || null;

    this.setupBot();
  }

  private isAuthorized(chatId: string | number): boolean {
    const numChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
    const isAllowedChat = this.allowedChats.some(c => c.chatId === numChatId);
    const isAdmin = this.adminChatId !== null && this.adminChatId === numChatId;
    return isAllowedChat || isAdmin;
  }

  private isAdmin(chatId: number): boolean {
    return this.adminChatId === chatId;
  }

  private getNotificationChats(): ChatWithThread[] {
    if (this.silentMode && this.adminChatId !== null) {
      return [{ chatId: this.adminChatId }];
    }

    return this.allowedChats;
  }

  private getDeliveryModeLabel(): string {
    return this.silentMode ? 'silent' : 'voice';
  }

  private getHelpText(): string {
    return `Commands:\n\n` +
      `/reload - release stuck lock\n` +
      `/skip - skip current order\n` +
      `/again - repeat current order\n` +
      `/pause - pause monitoring\n` +
      `/resume - resume monitoring\n` +
      `/silent - redirect notifications to TELEGRAM_ADMIN_ID\n` +
      `/voice - send notifications to TELEGRAM_CHAT_IDS\n` +
      `/pending - show pending orders\n` +
      `/order [iin] - show order status\n` +
      `/clear - clear stale records\n` +
      `/status - show bot status\n` +
      `/help - this help`;
  }

  private async setSilentMode(enabled: boolean, ctx: any): Promise<void> {
    if (!this.isAdmin(ctx.chat.id)) {
      await ctx.reply('Only TELEGRAM_ADMIN_ID can change silent mode.');
      return;
    }

    this.silentMode = enabled;
    const mode = this.getDeliveryModeLabel();
    this.logger.info(`Dispatcher: Delivery mode changed to ${mode} by ${ctx.chat.id}`);
    await ctx.reply(
      enabled
        ? 'Silent mode enabled. All notifications are redirected to TELEGRAM_ADMIN_ID.'
        : 'Voice mode enabled. Notifications are sent to TELEGRAM_CHAT_IDS.'
    );
  }

  private async handleTelegramError(error: any, context: string): Promise<void> {
    if (error?.response?.error_code === 400) {
      const description = error.response.description || '';

      if (description.includes('group chat was upgraded to a supergroup chat')) {
        const migrateToChatId = error.response.parameters?.migrate_to_chat_id;
        if (migrateToChatId) {
          this.logger.error(`Dispatcher: ${context} - Chat migrated! New ID: ${migrateToChatId}`);
          this.logger.error(`Dispatcher: Update TELEGRAM_CHAT_IDS in .env to use ${migrateToChatId}`);
          return;
        }
      }

      if (description.includes('message can\'t be sent to this chat')) {
        this.logger.error(`Dispatcher: ${context} - Cannot send to this chat. Check bot permissions.`);
        return;
      }
    }

    this.logger.error(`Dispatcher: ${context} - ${error?.message || error}`);
  }

  private async setupBot(): Promise<void> {
    // Callback functions to be set by external code
    this.bot.start((ctx) => {
      if (this.isAuthorized(ctx.chat.id)) {
        ctx.reply('✅ Авторизовано. Система CreditBridge активна.');
      } else {
        ctx.reply('❌ Доступ запрещён.');
        this.logger.warn(`Unauthorized access attempt from chat_id: ${ctx.chat.id}`);
      }
    });

    // Handle callback queries (inline button clicks)
    this.bot.on('callback_query', async (ctx) => {
      if (!('data' in ctx.callbackQuery)) return;
      
      const callbackData = ctx.callbackQuery.data;
      if (!callbackData) return;

      // Handle SMS confirmation button
      if (callbackData.startsWith('send_sms:')) {
        const orderId = callbackData.replace('send_sms:', '');
        await this.handleSmsConfirmationCallback(orderId, ctx);
        return;
      }

      // Handle SMS cancellation button
      if (callbackData.startsWith('cancel_sms:')) {
        const orderId = callbackData.replace('cancel_sms:', '');
        await this.handleSmsCancellation(orderId, ctx);
        return;
      }
    });

    this.bot.on('text', async (ctx, next) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();
      
      this.logger.info(`[CMD-DEBUG] Message received: chatId=${chatId} text="${text}" authorized=${this.isAuthorized(chatId)}`);
      
      if (!this.isAuthorized(chatId)) return;
      
      // 1. Проверка reply на SMS-код
      const replyToMessage = ctx.message.reply_to_message;
      if (replyToMessage) {
        const replyMessageId = replyToMessage.message_id;
        for (const [, context] of this.smsCodeReplyContexts.entries()) {
          if (context.chatId === chatId && context.messageId === replyMessageId) {
            await this.handleSmsCodeReply(context.orderId, text, ctx);
            return;
          }
        }
      }
      
      // 2. Старый обработчик SMS для входа (личка админа)
      if (this.isWaitingForSms && this.isAdmin(chatId)) {
        if (/^\d{4,8}$/.test(text)) {
          if (this.surveillanceAgent) {
            this.surveillanceAgent.submitSmsCode(text);
            this.isWaitingForSms = false;
            await ctx.reply('✅ СМС-код принят и введён в систему.');
            return;
          }
        }
      }

      // Пропускаем сообщение дальше по цепочке, чтобы срабатывали bot.command()
      return next();
    });

    // Register slash commands for Telegram menu
    this.bot.command('reload', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      await this.handleReloadCommand(ctx);
    });

    this.bot.command('skip', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      if (this.surveillanceAgent) {
        const skipCb = this.surveillanceAgent.getSkipCallback();
        if (skipCb) {
          try {
            const orderId = await skipCb();
            if (orderId) {
              await ctx.reply(`⏭️ Заказ ${orderId} пропущен.\nСтатус обновлён: COMPLETED_EXTERNALLY.\nМониторинг возобновится в следующем цикле.`);
            } else {
              await ctx.reply('ℹ️ Нет активного заказа для пропуска.');
            }
          } catch (error) {
            this.logger.error(`Error skipping order: ${error}`);
            await ctx.reply('❌ Ошибка при пропуске заказа.');
          }
        } else {
          await ctx.reply('❌ Callback для skip не установлен.');
        }
      } else {
        await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
      }
    });

    this.bot.command('again', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      await this.handleAgainCommand(ctx);
    });

    this.bot.command('pause', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      if (this.surveillanceAgent) {
        const pauseCb = this.surveillanceAgent.getPauseCallback();
        if (pauseCb) {
          pauseCb(true);
          await ctx.reply('⏸️ Мониторинг приостановлен.\nТекущий SMS-флоу завершится штатно.\nДля возобновления: /resume');
        } else {
          await ctx.reply('❌ Callback для pause не установлен.');
        }
      } else {
        await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
      }
    });

    this.bot.command('resume', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      if (this.surveillanceAgent) {
        const pauseCb = this.surveillanceAgent.getPauseCallback();
        if (pauseCb) {
          pauseCb(false);
          await ctx.reply('▶️ Мониторинг возобновлён.');
        } else {
          await ctx.reply('❌ Callback для pause не установлен.');
        }
      } else {
        await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
      }
    });

    this.bot.command('silent', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      await this.setSilentMode(true, ctx);
    });

    this.bot.command('voice', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      await this.setSilentMode(false, ctx);
    });

    this.bot.command('pending', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      try {
        if (!this.surveillanceAgent) {
          await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
          return;
        }
        const registry = this.surveillanceAgent.getRegistry();
        if (!registry) {
          await ctx.reply('❌ Ошибка: реестр не инициализирован.');
          return;
        }
        const confirmations = await registry.getPendingConfirmations();
        if (confirmations.length === 0) {
          await ctx.reply('✅ Незавершённых заявок нет.');
        } else {
          let response = `📋 Незавершённые заявки (${confirmations.length}):\n\n`;
          for (let i = 0; i < confirmations.length; i++) {
            const conf = confirmations[i];
            const last4 = conf.external_id.slice(-4).padStart(4, '*');
            const createdAt = new Date(conf.created_at).toLocaleString('ru-RU', {
              day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            response += `${i + 1}. ИИН: ${last4}\n   Статус: ${conf.status}\n   Попыток: ${conf.sms_attempts}\n   Обновлено: ${createdAt}\n\n`;
          }
          await ctx.reply(response);
        }
      } catch (error) {
        this.logger.error(`Error getting pending orders: ${error}`);
        await ctx.reply('❌ Ошибка при получении незавершённых заявок.');
      }
    });

    this.bot.command('order', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      const arg = ctx.payload;
      if (arg) {
        try {
          if (!this.surveillanceAgent) { await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.'); return; }
          const registry = this.surveillanceAgent.getRegistry();
          if (!registry) { await ctx.reply('❌ Ошибка: реестр не инициализирован.'); return; }
          
          const confirmation = await registry.findConfirmationByPartialId(arg);
          if (confirmation) {
            const last4 = confirmation.external_id.slice(-4).padStart(4, '*');
            const createdAt = new Date(confirmation.created_at).toLocaleString('ru-RU', {
              day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            const updatedAt = new Date(confirmation.updated_at).toLocaleString('ru-RU', {
              day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            const formattedAmount = confirmation.amount?.toLocaleString('ru-RU') || 'N/A';
            
            await ctx.reply(`🔍 Заявка ${last4}:\nСтатус: ${confirmation.status}\nСумма: ${formattedAmount} тг\nПопыток SMS: ${confirmation.sms_attempts}\nСоздана: ${createdAt}\nОбновлена: ${updatedAt}`);
          } else {
            await ctx.reply(`❌ Заявка с ИИН ${arg} не найдена.`);
          }
        } catch (error) {
          this.logger.error(`Error getting order status: ${error}`);
          await ctx.reply('❌ Ошибка при получении статуса заявки.');
        }
      } else {
        await ctx.reply('❌ Использование: /order [iin]');
      }
    });

    this.bot.command('clear', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      try {
        if (!this.surveillanceAgent) { await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.'); return; }
        const registry = this.surveillanceAgent.getRegistry();
        if (!registry) { await ctx.reply('❌ Ошибка: реестр не инициализирован.'); return; }
        const count = await registry.clearStaleConfirmations();
        if (count > 0) {
          await ctx.reply(`🧹 Очищено ${count} зависших записей старше 30 минут.`);
        } else {
          await ctx.reply('ℹ️ Зависших записей не найдено.');
        }
      } catch (error) {
        this.logger.error(`Error clearing stale records: ${error}`);
        await ctx.reply('❌ Ошибка при очистке зависших записей.');
      }
    });

    this.bot.command('status', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      if (this.surveillanceAgent) {
        try {
          const status = await this.surveillanceAgent.getStatus();
          const timestamp = new Date().toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
          });
          await ctx.reply(`📊 Статус бота:\n🔒 Лок: ${status.isProcessingSms ? 'да' : 'нет'}\n📋 Активный заказ: ${status.currentSmsOrderId || '-'}\nMode: ${this.getDeliveryModeLabel()}\n⏸️ Мониторинг: ${status.isMonitoringPaused ? 'на паузе' : 'активен'}\n⏰ Время: ${timestamp}`);
        } catch (error) {
          this.logger.error(`Error getting status: ${error}`);
          await ctx.reply('❌ Ошибка при получении статуса.');
        }
      } else {
        await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
      }
    });

        this.bot.command('start', (ctx) => {
      if (this.isAuthorized(ctx.chat.id)) {
        ctx.reply('✅ Авторизовано. Система CreditBridge активна.');
      } else {
        ctx.reply('❌ Доступ запрещён.');
      }
    });

    this.bot.launch().then(() => {
      this.logger.info('Dispatcher: Telegram bot launched');
    }).catch((error) => {
      this.logger.error(`Dispatcher: Failed to launch bot - ${error}`);
    });
  }

  private async handleReloadCommand(ctx: any): Promise<void> {
    // Implementation of handleReloadCommand would go here
    await ctx.reply('🔄 Команда reload выполнена');
  }

  private async handleAgainCommand(ctx: any): Promise<void> {
    // Implementation of handleAgainCommand would go here
    await ctx.reply('🔁 Команда again выполнена');
  }

  async sendQRCode(photoBuffer: Buffer, orderId: string, amount: number): Promise<void> {
    let successCount = 0;
    const caption = `🧾 ИИН #${orderId}\nСумма: ${amount.toFixed(2)} KZT\n${new Date().toISOString()}`;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendPhoto(chatId, {
          source: photoBuffer,
          filename: `qr_${orderId}.png`,
        }, {
          caption,
          message_thread_id: threadId,
        });

        successCount++;
        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: QR sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (error) {
        await this.handleTelegramError(error, `sendQRCode to ${chatId}`);
        this.logger.error(`sendQRCode failed for chat ${chatId}: ${error}`);
      }
    }
    if (successCount === 0) {
      throw new Error(`sendQRCode: failed to send to all chats for ${orderId}`);
    }
  }

  async sendErrorMessage(error: unknown, screenshot?: Buffer | null): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, error notification skipped');
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    const filenameTimestamp = timestamp.replace(/[:.]/g, '-');
    const caption = `🚨 Ошибка в цикле мониторинга\n\n⏰ Время: ${timestamp}\n❗ Описание: ${errorMessage}`;

    try {
      if (screenshot) {
        await this.bot.telegram.sendPhoto(this.adminChatId, {
          source: screenshot,
          filename: `critical_error_${filenameTimestamp}.png`,
        }, {
          caption,
        });
      } else {
        await this.bot.telegram.sendMessage(this.adminChatId, caption);
      }
      this.logger.info(`Dispatcher: Error message sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendErrorMessage to ${this.adminChatId}`);
    }
  }

  async sendSmsRequest(screenshot: Buffer, timestamp: string): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, SMS request skipped');
      return;
    }

    try {
      await this.bot.telegram.sendPhoto(this.adminChatId, {
        source: screenshot,
        filename: 'sms_verification.png',
      }, {
        caption: `🔐 Требуется СМС-код для входа\n\n⏰ Время: ${timestamp}\n\n📝 Отправьте СМС-код в ответ (только цифры).`,
      });

      this.isWaitingForSms = true;
      this.logger.info(`Dispatcher: SMS request sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsRequest to ${this.adminChatId}`);
    }
  }

  async sendConfirmationAlert(externalId: string, amount: number): Promise<void> {
    let successCount = 0;
    const caption = `⚠️ ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ\n\nИИН: ${externalId}\nСумма: ${amount.toFixed(2)} тг\n\n---\nНужно подтвердить заявку в личном кабинете: https://online.bcc.kz/cashier-cabinet/ru\nПосле вашего подтверждения бот автоматически пришлет QR-код в этот чат.\n\nАктуальная инструкция — в закрепленном сообщении.\n\nНАПОМИНАНИЕ: все неподтвержденные заявки автоматически аннулируются.`;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });
        successCount++;
        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: Confirmation alert sent to chat_id ${chatId}${threadInfo} for order ${externalId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendConfirmationAlert to ${chatId}`);
        this.logger.error(`sendConfirmationAlert failed for chat ${chatId}: ${sendError}`);
      }
    }
    if (successCount === 0) {
      throw new Error(`sendConfirmationAlert: failed to send to all chats for ${externalId}`);
    }
  }

  async sendStartupNotification(): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, startup notification skipped');
      return;
    }

    const caption = `🚀 Бот успешно запущен на сервере Render и готов к работе!\n\n⏰ Время: ${new Date().toISOString()}\n🌐 Environment: ${process.env.NODE_ENV || 'production'}`;

    try {
      await this.bot.telegram.sendMessage(this.adminChatId, caption);
      this.logger.info(`Dispatcher: Startup notification sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, 'sendStartupNotification');
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.logger.info('Dispatcher: Telegram bot stopped');
  }

  // SMS Confirmation Methods

  async sendSmsConfirmationRequest(orderId: string, amount: number): Promise<boolean> {
    const caption = `📱 ОТПРАВИТЬ SMS КЛИЕНТУ?\n\nИИН: ${orderId}\nСумма: ${amount.toFixed(2)} тг\n\n⏸️ Мониторинг приостановлен — новые QR не генерируются.\nЕсли желаете подтвердить сами — нажмите «↩️ Не отправлять SMS».\n\n⚠️ Нажмите кнопку ниже чтобы отправить SMS-код клиенту.\nℹ️ Кнопка «Не отправлять SMS» не отменяет заявку клиента.`;

    this.decisionMessageRefs.delete(orderId);
    let successCount = 0;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        const message = await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Отправить SMS', callback_data: `send_sms:${orderId}` },
                { text: '↩️ Не отправлять SMS', callback_data: `cancel_sms:${orderId}` }
              ]
            ]
          }
        });

        this.setMessageRef(this.decisionMessageRefs, orderId, {
          chatId,
          messageId: message.message_id,
          threadId,
          timestamp: Date.now(),
        });
        successCount++;

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: SMS confirmation request sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsConfirmationRequest to ${chatId}`);
      }
    }

    return successCount > 0;
  }

  private async handleSmsConfirmationCallback(orderId: string, ctx: any): Promise<void> {
    try {
      await ctx.answerCbQuery('Обработка запроса...');

      // Trigger the callback if registered
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback('CONFIRMED');
        this.logger.info(`Dispatcher: SMS confirmation callback triggered for ${orderId}`);
      } else {
        this.logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
      }

      // Update the message
      await ctx.editMessageText(
        `✅ Запрос принят!\n\nИИН: ${orderId}\n\nОтправка СМС клиенту...`,
        { reply_markup: undefined }
      );
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to handle SMS confirmation callback for ${orderId} - ${error}`);
      await ctx.answerCbQuery('Ошибка обработки запроса').catch(() => {});
    }
  }

  async sendSmsCodeRequest(orderId: string, screenshot: Buffer, isRetry: boolean = false, attemptNumber: number = 1, amount?: number): Promise<boolean> {
    let caption = '';
    
    if (isRetry) {
      caption = `⚠️ Код не подошёл. Клиенту отправлен новый SMS.\nПопытка ${attemptNumber}/3.\n\n📝 Ответьте на это сообщение новым кодом.`;
    } else {
      caption = `📲 ВВЕДИТЕ SMS-КОД\nИИН: ${orderId}\nСумма: ${amount?.toFixed(2) || 'N/A'} тг\n\n📝 Ответьте на это сообщение кодом (только цифры).\nℹ️ У вас есть 5 минут.`;
    }

    this.clearReplyContexts(orderId);
    this.codeMessageRefs.delete(orderId);
    let successCount = 0;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        const message = await this.bot.telegram.sendPhoto(chatId, {
          source: screenshot,
          filename: `sms_code_${orderId}.png`,
        }, {
          caption,
          message_thread_id: threadId,
        });

        // Store context for reply handling
        this.smsCodeReplyContexts.set(this.getReplyContextKey(orderId, chatId), {
          orderId,
          chatId,
          messageId: message.message_id,
          threadId,
          timestamp: Date.now(),
        });
        this.setMessageRef(this.codeMessageRefs, orderId, {
          chatId,
          messageId: message.message_id,
          threadId,
          timestamp: Date.now(),
        });
        successCount++;

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: SMS code request sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsCodeRequest to ${chatId}`);
      }
    }

    return successCount > 0;
  }

  private async handleSmsCodeReply(orderId: string, code: string, ctx: any): Promise<void> {
    try {
      // Validate code format
      if (!/^\d{4,6}$/.test(code)) {
        await ctx.reply('❌ Неверный формат СМС-кода. Отправьте только цифры (4-6 знаков).');
        return;
      }

      // Get user info
      const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'Пользователь';

      // Trigger the callback if registered
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback(code);
        this.logger.info(`Dispatcher: SMS code received for ${orderId}: ${code} from ${username}`);
        
        // Update the original message with confirmation
        const replyContext = this.smsCodeReplyContexts.get(this.getReplyContextKey(orderId, ctx.chat.id));
        if (replyContext) {
          try {
            await this.bot.telegram.editMessageCaption(
              ctx.chat.id,
              replyContext.messageId,
              undefined,
              `✅ КОД ВВЕДЕН\n\nИИН: ${orderId}\n\n👤 Код введен пользователем ${username}\n⏰ ${new Date().toISOString()}`
            );
          } catch (editError) {
            this.logger.warn(`Dispatcher: Failed to edit message for ${orderId} - ${editError}`);
          }
        }

        await ctx.reply(`✅ СМС-код принят для заявки ${orderId}`);

        // Clean up context
        this.clearReplyContexts(orderId);
        this.smsCodeCallbacks.delete(orderId);
      } else {
        this.logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
        await ctx.reply(`⚠️ Заявка ${orderId} не найдена или уже обработана.`);
      }
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to handle SMS code reply for ${orderId} - ${error}`);
      await ctx.reply('❌ Ошибка обработки СМС-кода').catch(() => {});
    }
  }

  async sendSmsBlockedAlert(orderId: string, screenshot: Buffer): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, SMS blocked alert skipped');
      return;
    }

    try {
      const caption = `🚫 КОД НЕ ПРИНЯТ\n\nИИН: ${orderId}\n\n`;

      await this.bot.telegram.sendPhoto(this.adminChatId, {
        source: screenshot,
        filename: `sms_blocked_${orderId}.png`,
      }, {
        caption,
      });

      this.logger.info(`Dispatcher: SMS blocked alert sent to admin ${this.adminChatId} for order ${orderId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsBlockedAlert to ${this.adminChatId}`);
    }
  }

  async sendSmsButtonNotFoundAlert(orderId: string, screenshot: Buffer): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, SMS button not found alert skipped');
      return;
    }

    try {
      const caption = `⚠️ КНОПКА SMS НЕ НАЙДЕНА\n\nИИН: ${orderId}\n\nНе удалось найти кнопку отправки SMS на странице.\nВозможно, заявка была обработана или интерфейс изменился.`;

      await this.bot.telegram.sendPhoto(this.adminChatId, {
        source: screenshot,
        filename: `sms_button_not_found_${orderId}.png`,
      }, {
        caption,
      });

      this.logger.info(`Dispatcher: SMS button not found alert sent to admin ${this.adminChatId} for order ${orderId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsButtonNotFoundAlert to ${this.adminChatId}`);
    }
  }

  async sendSmsBlockedNotification(orderId: string): Promise<void> {
    const caption = `🚫 ИИН ${orderId}: доступ заблокирован на 24 часа.\nОбратитесь в поддержку: 605`;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: SMS blocked notification sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsBlockedNotification to ${chatId}`);
      }
    }
  }

  async sendSmsLimitExceeded(orderId: string, attempts: number): Promise<void> {
    const caption = `⛔ ПРЕВЫШЕН ЛИМИТ ПОПЫТОК\n\nИИН: ${orderId}\nПопыток: ${attempts}\n\n❌ Достигнут максимальный лимит попыток отправки СМС (${process.env.SMS_MAX_ATTEMPTS || 3}).\n\nЗаявка требует ручной обработки.`;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: SMS limit exceeded alert sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsLimitExceeded to ${chatId}`);
      }
    }
  }

  registerSmsCodeCallback(orderId: string, callback: (code: string) => void): void {
    this.smsCodeCallbacks.set(orderId, callback);
    this.logger.info(`Dispatcher: SMS code callback registered for ${orderId}`);
  }

  unregisterSmsCodeCallback(orderId: string): void {
    this.smsCodeCallbacks.delete(orderId);
    this.clearReplyContexts(orderId);
    this.logger.info(`Dispatcher: SMS code callback unregistered for ${orderId}`);
  }

  private getReplyContextKey(orderId: string, chatId: number): string {
    return `${orderId}:${chatId}`;
  }

  private pruneStaleMessageRefs(): void {
    const cutoff = Date.now() - this.MESSAGE_REF_TTL_MS;

    for (const refsByOrder of [this.decisionMessageRefs, this.codeMessageRefs]) {
      for (const [orderId, refsByChat] of refsByOrder.entries()) {
        for (const [chatId, ref] of refsByChat.entries()) {
          if (ref.timestamp < cutoff) {
            refsByChat.delete(chatId);
          }
        }

        if (refsByChat.size === 0) {
          refsByOrder.delete(orderId);
        }
      }
    }

    for (const [key, context] of this.smsCodeReplyContexts.entries()) {
      if (context.timestamp < cutoff) {
        this.smsCodeReplyContexts.delete(key);
      }
    }
  }

  private setMessageRef(
    store: Map<string, Map<number, TelegramMessageRef>>,
    orderId: string,
    ref: TelegramMessageRef
  ): void {
    this.pruneStaleMessageRefs();

    const refsByChat = store.get(orderId) ?? new Map<number, TelegramMessageRef>();
    refsByChat.set(ref.chatId, ref);
    store.set(orderId, refsByChat);
  }

  private getMessageRefs(
    store: Map<string, Map<number, TelegramMessageRef>>,
    orderId: string
  ): TelegramMessageRef[] {
    this.pruneStaleMessageRefs();
    return Array.from(store.get(orderId)?.values() ?? []);
  }

  private clearReplyContexts(orderId: string): void {
    for (const key of this.smsCodeReplyContexts.keys()) {
      if (key.startsWith(`${orderId}:`)) {
        this.smsCodeReplyContexts.delete(key);
      }
    }
  }

  private clearMessageRefs(orderId: string): void {
    this.decisionMessageRefs.delete(orderId);
    this.codeMessageRefs.delete(orderId);
  }

  private clearDecisionInterval(orderId: string): void {
    const interval = this.decisionIntervals.get(orderId);
    if (interval) {
      clearInterval(interval);
      this.decisionIntervals.delete(orderId);
    }
  }

  private clearCodeInterval(orderId: string): void {
    const interval = this.codeIntervals.get(orderId);
    if (interval) {
      clearInterval(interval);
      this.codeIntervals.delete(orderId);
    }
  }

  private clearSmsIntervals(orderId: string): void {
    this.clearDecisionInterval(orderId);
    this.clearCodeInterval(orderId);
  }

  private async handleSmsCancellation(orderId: string, ctx: any): Promise<void> {
    try {
      await ctx.answerCbQuery('Отменено');

      // Trigger the callback with CANCELLED signal
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback('CANCELLED');
        this.logger.info(`Dispatcher: SMS cancellation callback triggered for ${orderId}`);
      } else {
        this.logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
      }

      // Get user info to include in the message
      const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'Пользователь';

      // Update the message
      await ctx.editMessageText(
        `↩️ SMS НЕ БУДЕТ ОТПРАВЛЕН\n\nИИН: ${orderId}\n\n👤 ${username} отменил отправку\n✅ Заявка клиента НЕ отменена\n🔄 Бот возвращается к мониторингу`,
        { reply_markup: undefined }
      );

      // Clean up
      this.smsCodeCallbacks.delete(orderId);
      this.clearReplyContexts(orderId);
      this.clearMessageRefs(orderId);

      this.logger.info(`Dispatcher: SMS request cancelled for ${orderId}`);
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to handle SMS cancellation for ${orderId} - ${error}`);
      await ctx.answerCbQuery('Ошибка отмены').catch(() => {});
    }
  }

  async performSmsFlow(orderId: string, amount: number): Promise<SmsFlowStatus> {
    const surveillanceAgent = this.surveillanceAgent;
    if (!surveillanceAgent) {
      this.logger.error('Surveillance agent not available in performSmsFlow');
      return SmsFlowStatus.TIMEOUT;
    }

    return new Promise<SmsFlowStatus>(async (resolve) => {
      const registry = surveillanceAgent.getRegistry();
      let decisionTimeout: NodeJS.Timeout | null = null;
      let codeTimeout: NodeJS.Timeout | null = null;
      let lockAcquired = false;
      let settled = false;
      
      const cleanup = () => {
        if (decisionTimeout) clearTimeout(decisionTimeout);
        if (codeTimeout) clearTimeout(codeTimeout);
        this.clearSmsIntervals(orderId);
        this.unregisterSmsCodeCallback(orderId);
      };

      const syncSmsStatus = async (
        status: 'WAITING_FOR_USER_ACTION' | 'SMS_SENT' | 'SMS_CONFIRMED' | 'SMS_BLOCKED' | 'USER_REFUSED_SMS' | 'IGNORED' | 'SMS_TIMEOUT',
        incrementCount: boolean = false
      ) => {
        if (!registry) {
          return;
        }

        const existing = await registry.getSmsConfirmation(orderId);
        if (!existing) {
          await registry.registerSmsConfirmation(orderId, amount, status);
          return;
        }

        if (incrementCount) {
          await registry.updateSmsStatusWithCount(orderId, status);
          return;
        }

        await registry.updateSmsStatus(orderId, status);
      };

      const expireDecisionMessage = async () => {
        const decisionRefs = this.getMessageRefs(this.decisionMessageRefs, orderId);
        if (decisionRefs.length === 0) {
          return;
        }

        for (const ref of decisionRefs) {
          try {
            await this.bot.telegram.editMessageText(
              ref.chatId,
              ref.messageId,
              undefined,
              'Время ожидания истекло',
              { reply_markup: undefined }
            );
          } catch (error: any) {
            if (error?.response?.description?.includes('message is not modified')) {
              continue;
            }
            await this.handleTelegramError(error, `expireDecisionMessage in ${ref.chatId}`);
          }
        }
      };

      const finalizeFlow = async (
        status: SmsFlowStatus,
        options?: {
          smsStatus?: 'WAITING_FOR_USER_ACTION' | 'SMS_SENT' | 'SMS_CONFIRMED' | 'SMS_BLOCKED' | 'USER_REFUSED_SMS' | 'IGNORED' | 'SMS_TIMEOUT';
          incrementCount?: boolean;
          expireDecision?: boolean;
        }
      ) => {
        if (settled) {
          return;
        }
        settled = true;

        cleanup();

        try {
          if (options?.expireDecision) {
            await expireDecisionMessage();
          }

          if (options?.smsStatus) {
            await syncSmsStatus(options.smsStatus, options.incrementCount);
          }
        } catch (error) {
          this.logger.error(`Dispatcher: Failed to finalize SMS flow state for ${orderId} - ${error}`);
        } finally {
          this.clearMessageRefs(orderId);
          if (registry && lockAcquired) {
            await registry.releaseSmsLock(orderId);
          }
          resolve(status);
        }
      };

      const startDecisionCountdown = (initialSeconds: number) => {
        let secondsLeft = initialSeconds;
        this.clearDecisionInterval(orderId);
        
        const interval = setInterval(async () => {
          secondsLeft -= 60;
          const minutes = Math.floor(secondsLeft / 60);
          const seconds = secondsLeft % 60;
          const countdownText = `⏱️ Ожидание решения: ${minutes}:${seconds.toString().padStart(2, '0')}`;
          
          if (this.getMessageRefs(this.decisionMessageRefs, orderId).length > 0) {
            try {
              await this.updateDecisionCountdown(orderId, countdownText);
            } catch (error) {
              this.logger.warn(`Failed to update decision countdown: ${error}`);
            }
          }
          
          if (secondsLeft <= 0) {
            this.clearDecisionInterval(orderId);
            void finalizeFlow(SmsFlowStatus.TIMEOUT, {
              smsStatus: 'IGNORED',
              expireDecision: true,
            });
          }
        }, 60000);

        this.decisionIntervals.set(orderId, interval);
      };

      const startCodeCountdown = (initialSeconds: number) => {
        let secondsLeft = initialSeconds;
        this.clearCodeInterval(orderId);
        
        const interval = setInterval(async () => {
          secondsLeft -= 60;
          const minutes = Math.floor(secondsLeft / 60);
          const seconds = secondsLeft % 60;
          const countdownText = `⏱️ Ожидание СМС-кода: ${minutes}:${seconds.toString().padStart(2, '0')}`;
          
          if (this.getMessageRefs(this.codeMessageRefs, orderId).length > 0) {
            try {
              await this.updateCountdownMessage(orderId, countdownText);
            } catch (error) {
              this.logger.warn(`Failed to update code countdown: ${error}`);
            }
          }
          
          if (secondsLeft <= 0) {
            this.clearCodeInterval(orderId);
            void finalizeFlow(SmsFlowStatus.TIMEOUT, {
              smsStatus: 'SMS_TIMEOUT',
            });
          }
        }, 60000);

        this.codeIntervals.set(orderId, interval);
      };

      // Step 1: Send decision request (send SMS or cancel)
      try {
        if (registry) {
          lockAcquired = await registry.acquireSmsLock(orderId);
          if (!lockAcquired) {
            this.logger.warn(`Dispatcher: SMS lock is already held for ${orderId}, skipping flow`);
            resolve(SmsFlowStatus.TIMEOUT);
            return;
          }

          await syncSmsStatus('WAITING_FOR_USER_ACTION');
        }

        const decisionRequestSent = await this.sendSmsConfirmationRequest(orderId, amount);
        if (!decisionRequestSent) {
          this.logger.error(`Failed to send SMS confirmation request for ${orderId}`);
          await finalizeFlow(SmsFlowStatus.TIMEOUT, {
            smsStatus: 'SMS_TIMEOUT',
          });
          return;
        }
        
        startDecisionCountdown(240);
        
        decisionTimeout = setTimeout(() => {
          this.logger.info(`Decision timeout for order ${orderId}`);
          void finalizeFlow(SmsFlowStatus.TIMEOUT, {
            smsStatus: 'IGNORED',
            expireDecision: true,
          });
        }, 240000);
        
        // Wait for decision callback
        const decisionResult = await new Promise<string>((decisionResolve) => {
          this.registerSmsCodeCallback(orderId, (code) => {
            if (decisionTimeout) clearTimeout(decisionTimeout);
            this.clearDecisionInterval(orderId);
            decisionResolve(code);
          });
        });
        
        if (decisionResult === 'CANCELLED') {
          this.logger.info(`SMS flow cancelled for order ${orderId}`);
          await finalizeFlow(SmsFlowStatus.CANCELLED, {
            smsStatus: 'USER_REFUSED_SMS',
          });
          return;
        }

        const smsButtonClicked = await this.retryOperation(async () => {
          if (!this.surveillanceAgent) {
            throw new Error('Surveillance agent not available');
          }
          return await this.surveillanceAgent.clickSendSmsButton(orderId);
        });

        if (!smsButtonClicked) {
          this.logger.error(`Failed to click Send SMS button for ${orderId} after user confirmation`);
          await finalizeFlow(SmsFlowStatus.TIMEOUT, {
            smsStatus: 'SMS_TIMEOUT',
          });
          return;
        }

        this.logger.info(`Dispatcher: Send SMS button clicked for ${orderId}, waiting for SMS code from user`);
        await syncSmsStatus('SMS_SENT', true);
        
        // Step 2: Decision confirmed, now wait for SMS code
        let attemptNumber = 1;
        const maxAttempts = parseInt(process.env.SMS_MAX_ATTEMPTS || '3', 10);
        
        while (attemptNumber <= maxAttempts) {
          try {
              // Get fresh screenshot from browser
                const screenshot = await this.retryOperation(async () => {
                  if (!this.surveillanceAgent) {
                    throw new Error('Surveillance agent not available');
                  }
                  return await this.surveillanceAgent.takeSmsScreenshot(orderId, 'input');
                });
            
            if (!screenshot) {
              this.logger.error(`Failed to get screenshot for SMS code entry for ${orderId}, attempt ${attemptNumber}`);
              if (attemptNumber === maxAttempts) {
                await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                  smsStatus: 'SMS_TIMEOUT',
                });
                return;
              }
              attemptNumber++;
              continue;
            }
            
            const codeRequestSent = await this.sendSmsCodeRequest(
              orderId, 
              screenshot, 
              attemptNumber > 1, 
              attemptNumber, 
              amount
            );
            
            if (!codeRequestSent) {
              this.logger.error(`Failed to send SMS code request for ${orderId}, attempt ${attemptNumber}`);
              if (attemptNumber === maxAttempts) {
                await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                  smsStatus: 'SMS_TIMEOUT',
                });
                return;
              }
              attemptNumber++;
              continue;
            }
            
            startCodeCountdown(180);
            
            codeTimeout = setTimeout(() => {
              this.logger.info(`SMS code timeout for order ${orderId}, attempt ${attemptNumber}`);
              void finalizeFlow(SmsFlowStatus.TIMEOUT, {
                smsStatus: 'SMS_TIMEOUT',
              });
            }, 180000);
            
            // Wait for SMS code
            const smsCode = await new Promise<string>((codeResolve) => {
              this.registerSmsCodeCallback(orderId, (code) => {
                if (codeTimeout) clearTimeout(codeTimeout);
                this.clearCodeInterval(orderId);
                codeResolve(code);
              });
            });
            
            if (smsCode === 'CANCELLED') {
              this.logger.info(`SMS code entry cancelled for order ${orderId}`);
              await finalizeFlow(SmsFlowStatus.CANCELLED, {
                smsStatus: 'USER_REFUSED_SMS',
              });
              return;
            }
            
                // Step 1: Enter the code into input fields
                const codeEntered = await this.retryOperation(async () => {
                  if (!this.surveillanceAgent) {
                    throw new Error('Surveillance agent not available');
                  }
                  return await this.surveillanceAgent.enterSmsCode(smsCode, orderId);
                });

            if (!codeEntered) {
              this.logger.error(`Failed to enter SMS code for ${orderId}, attempt ${attemptNumber}`);
              if (attemptNumber < maxAttempts) {
                attemptNumber++;
                continue;
              }
              await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                smsStatus: 'SMS_TIMEOUT',
              });
              return;
            }

            this.logger.info(`SMS code entered successfully for ${orderId}`);

                // Step 2: Click the "Подтвердить" confirm button
                const confirmResult = await this.retryOperation(async () => {
                  if (!this.surveillanceAgent) {
                    throw new Error('Surveillance agent not available');
                  }
                  return await this.surveillanceAgent.clickConfirmButton(orderId);
                });

            if (!confirmResult.success) {
              this.logger.error(`Failed to click confirm button for ${orderId}, attempt ${attemptNumber}`);

              // Send debug screenshot to admin for manual validation
              if (confirmResult.debugScreenshot && this.adminChatId) {
                try {
                  const debugCaption = `⚠️ МОДАЛКА НЕ ЗАКРЫЛАСЬ\n\nИИН: ${orderId}\nПопытка: ${attemptNumber}/${maxAttempts}\n\n❌ После 2 попыток нажатия кнопки "Подтвердить" модальное окно не исчезло.\nСкриншот для ручной валидации ошибки.`;

                  await this.bot.telegram.sendPhoto(this.adminChatId, {
                    source: confirmResult.debugScreenshot,
                    filename: `confirm_fail_${orderId}.png`,
                  }, {
                    caption: debugCaption,
                  });

                  this.logger.info(`Dispatcher: Confirm failure screenshot sent to admin ${this.adminChatId} for ${orderId}`);
                } catch (sendError) {
                  await this.handleTelegramError(sendError, `sendConfirmFailureScreenshot to ${this.adminChatId}`);
                }
              }

              // Check for error/blocked modal after failed confirm
              if (this.surveillanceAgent) {
                const errorCheck = await this.surveillanceAgent.checkSmsErrorModal();

                if (errorCheck.isBlocked) {
                  // === BLOCKED: 24-hour ban ===
                  this.logger.error(`SMS BLOCKED for ${orderId} — 24-hour ban detected`);

                  await this.sendSmsBlockedNotification(orderId);
                  await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                    smsStatus: 'SMS_BLOCKED',
                  });

                  // Close the blocked modal
                  await this.surveillanceAgent.closeSmsBlockedModal();
                  return;
                }

                if (errorCheck.error) {
                  // === ERROR but not blocked: wrong code, recovery flow ===
                  this.logger.warn(`SMS error modal detected for ${orderId} (not blocked). Starting recovery...`);

                  // Step 1: Wait 3 seconds for modal to settle
                  await new Promise(r => setTimeout(r, 3000));

                  // Step 2: Close error modal
                  await this.surveillanceAgent.closeSmsBlockedModal();
                  await new Promise(r => setTimeout(r, 1000));

                  // Step 3: Increment sms_attempts
                  if (registry) {
                    const newAttempts = await registry.updateSmsAttempts(orderId);
                    this.logger.info(`SMS attempts for ${orderId} incremented to ${newAttempts}`);

                    // Step 4: Check limit
                    if (newAttempts >= maxAttempts) {
                      this.logger.error(`SMS attempts limit reached for ${orderId} (${newAttempts}/${maxAttempts})`);
                      await this.sendSmsLimitExceeded(orderId, newAttempts);
                      await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                        smsStatus: 'SMS_TIMEOUT',
                      });
                      return;
                    }
                  }

                  // Step 5: Reload page and re-navigate
                  this.logger.info(`Recovery: Reloading page for ${orderId}...`);
                  const page = (this.surveillanceAgent as any).page;
                  if (page) {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForLoadState('networkidle', { timeout: 60000 });
                    await page.waitForTimeout(2000);
                  }

                  // Step 6: Open sidebar for the order
                  const sidebarOpened = await this.surveillanceAgent.openSidebarForOrder(orderId);
                  if (!sidebarOpened) {
                    this.logger.error(`Recovery: Failed to open sidebar for ${orderId}`);
                    await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                      smsStatus: 'SMS_TIMEOUT',
                    });
                    return;
                  }

                  // Step 7: Click Send SMS button directly (no Telegram decision)
                  const retrySmsClicked = await this.surveillanceAgent.clickSendSmsButton(orderId);
                  if (!retrySmsClicked) {
                    this.logger.error(`Recovery: Failed to click Send SMS button for ${orderId}`);
                    await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                      smsStatus: 'SMS_TIMEOUT',
                    });
                    return;
                  }

                  this.logger.info(`Recovery: Send SMS button clicked for ${orderId}, continuing to next attempt`);
                  await syncSmsStatus('SMS_SENT', true);

                  // Increment attemptNumber and continue the while loop
                  // The loop will take a fresh screenshot, send retry code request, and wait for new code
                  attemptNumber++;
                  continue;
                }
              }

              // No error modal detected — generic failure
              if (attemptNumber < maxAttempts) {
                attemptNumber++;
                continue;
              }
              await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                smsStatus: 'SMS_TIMEOUT',
              });
              return;
            }

            // Step 3: Verify success
            this.logger.info(`SMS code submitted and confirmed successfully for ${orderId}`);
            await finalizeFlow(SmsFlowStatus.SUCCESS, {
              smsStatus: 'SMS_CONFIRMED',
            });
            return;
            
          } catch (error) {
            this.logger.error(`Error in SMS code entry loop for ${orderId}, attempt ${attemptNumber}: ${error}`);
            if (attemptNumber < maxAttempts) {
              attemptNumber++;
              continue;
            } else {
              await finalizeFlow(SmsFlowStatus.TIMEOUT, {
                smsStatus: 'SMS_TIMEOUT',
              });
              return;
            }
          }
        }
        
      } catch (error) {
        this.logger.error(`Error in SMS flow for ${orderId}: ${error}`);
        await finalizeFlow(SmsFlowStatus.TIMEOUT, {
          smsStatus: 'SMS_TIMEOUT',
        });
      }
    });
  }

  async updateCountdownMessage(orderId: string, countdownText: string): Promise<void> {
    for (const ref of this.getMessageRefs(this.codeMessageRefs, orderId)) {
      try {
        await this.bot.telegram.editMessageCaption(
          ref.chatId,
          ref.messageId,
          undefined,
          `🔐 ВВЕДИТЕ СМС-КОД\n\nИИН: ${orderId}\n\n${countdownText}\n\n📝 Ответьте на это сообщение с СМС-кодом (только цифры).`
        );

        const threadInfo = ref.threadId ? ` (thread ${ref.threadId})` : '';
        this.logger.debug(`Dispatcher: Countdown updated for ${orderId} in chat_id ${ref.chatId}${threadInfo}`);
      } catch (editError: any) {
        // Ignore "message is not modified" errors
        if (editError?.response?.description?.includes('message is not modified')) {
          continue;
        }
        await this.handleTelegramError(editError, `updateCountdownMessage to ${ref.chatId}`);
      }
    }
  }

  async updateDecisionCountdown(orderId: string, countdownText: string): Promise<void> {
    for (const ref of this.getMessageRefs(this.decisionMessageRefs, orderId)) {
      try {
        await this.bot.telegram.editMessageText(
          ref.chatId,
          ref.messageId,
          undefined,
          `📱 ОТПРАВИТЬ SMS КЛИЕНТУ?\n\nИИН: ${orderId}\n\n${countdownText}\n\n⏸️ Мониторинг приостановлен — новые QR не генерируются.\nЕсли желаете подтвердить сами — нажмите «↩️ Не отправлять SMS».\n\n⚠️ Нажмите кнопку ниже чтобы отправить SMS-код клиенту.\nℹ️ Кнопка «Не отправлять SMS» не отменяет заявку клиента.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Отправить SMS', callback_data: `send_sms:${orderId}` },
                  { text: '↩️ Не отправлять SMS', callback_data: `cancel_sms:${orderId}` }
                ]
              ]
            }
          }
        );

        const threadInfo = ref.threadId ? ` (thread ${ref.threadId})` : '';
        this.logger.debug(`Dispatcher: Decision countdown updated for ${orderId} in chat_id ${ref.chatId}${threadInfo}`);
      } catch (editError: any) {
        // Ignore "message is not modified" errors
        if (editError?.response?.description?.includes('message is not modified')) {
          continue;
        }
        await this.handleTelegramError(editError, `updateDecisionCountdown to ${ref.chatId}`);
      }
    }
  }

  async sendTimeoutAlert(orderId: string, amount?: number): Promise<void> {
    const caption = `⏱️ ТАЙМАУТ СМС-КОДА\n\nИИН: ${orderId}\nСумма: ${amount?.toFixed(2) || 'N/A'} тг\n\n❌ Истекло время ожидания СМС-кода (5 минут).\n\nЗаявка требует повторной обработки.`;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        this.logger.info(`Dispatcher: Timeout alert sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendTimeoutAlert to ${chatId}`);
      }
    }
  }

  // Getters to access private properties from outside the class
  get getAllowedChats(): ChatWithThread[] {
    return this.allowedChats;
  }

  get getBot(): Telegraf<Context> {
    return this.bot;
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    delayMs = 2000
  ): Promise<T> {
    let lastError: unknown;

    for (let i = 1; i <= maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (i === maxRetries) {
          throw error;
        }
        this.logger.warn(`Operation failed, retry ${i}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unknown operation error');
  }

  get getHandleTelegramError(): (error: any, context: string) => Promise<void> {
    return this.handleTelegramError;
  }
}
