import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/Logger';
import { SurveillanceAgent } from './Surveillance';
import { RegistryAgent } from './Registry';
import { SmsFlowStatus } from '../types/SmsFlowStatus';
import { SmsCodeLoopOutcome, SmsStatus } from '../types';
import { BotText, formatTimeLeft } from '../utils/botMessages';
import { CodeRequestKind, runSmsCodeLoop } from '../utils/smsCodeLoop';

const DECISION_TIMEOUT_SEC = 240;
const CODE_TIMEOUT_SEC = 180;

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
  private silentMode: boolean = false;
  private readonly logger: Logger;
  private surveillanceAgent: SurveillanceAgent | null = null;
  private isWaitingForSms: boolean = false;
  private smsCodeReplyContexts: Map<string, SmsCodeReplyContext> = new Map();
  private smsCodeCallbacks: Map<string, (code: string) => void> = new Map();
  private decisionMessageRefs: Map<string, Map<number, TelegramMessageRef>> = new Map();
  private codeMessageRefs: Map<string, Map<number, TelegramMessageRef>> = new Map();
  /** Orders whose "send SMS?" question is open — the send button is ignored at any other step. */
  private awaitingDecision: Set<string> = new Set();
  private readonly MESSAGE_REF_TTL_MS = 24 * 60 * 60 * 1000;
  private onConfirmQr: ((orderId: string, amount: number) => Promise<boolean>) | null = null;

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

      // 2. Fallback: 4-значный код без reply — привязать к активному заказу
      if (this.isAuthorized(chatId) && /^\d{4}$/.test(text.trim())) {
        if (this.smsCodeCallbacks.size > 0 && this.smsCodeReplyContexts.size > 0) {
          const activeOrderId = this.smsCodeReplyContexts.keys().next().value;
          if (activeOrderId) {
            const orderId = activeOrderId.split(':')[0]; // Extract orderId from key format "orderId:chatId"
            this.logger.info(`Dispatcher: 4-digit code without reply — applying to ${orderId}`);
            // Personal hint to the sender only; the order status itself is posted by handleSmsCodeReply
            await ctx.reply(BotText.useReplyHint).catch(() => {});
            await this.handleSmsCodeReply(orderId, text.trim(), ctx);
            return;
          }
        }
      }

      // 3. Старый обработчик SMS для входа (личка админа)
      if (this.isWaitingForSms && this.isAdmin(chatId)) {
        if (/^\d{4,8}$/.test(text)) {
          if (this.surveillanceAgent) {
            this.surveillanceAgent.submitSmsCode(text);
            this.isWaitingForSms = false;
            await ctx.reply('✅ Код принят');
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

    this.bot.command('confirm', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!this.isAuthorized(chatId)) {
        await ctx.reply('❌ Unauthorized');
        return;
      }
      const arg = ctx.payload as string;
      if (!arg) {
        await ctx.reply('❌ Использование: /confirm [иин_заказа]');
        return;
      }
      if (!this.surveillanceAgent) {
        await ctx.reply('❌ Ошибка: агент наблюдения не инициализирован.');
        return;
      }
      const { status, amount } = await this.surveillanceAgent.getOrderStatus(arg.trim());
      if (!status || !amount) {
        await ctx.reply(`❌ Заявка ${arg.trim()} не найдена в таблице банка.`);
        return;
      }
      if (status === 'READY_FOR_QR' || status === 'IN_PROCESSING') {
        if (this.onConfirmQr) {
          await ctx.reply(`✅ Заявка ${arg.trim()} подтверждена (статус: ${status}), отправляю QR...`);
          const ok = await this.onConfirmQr(arg.trim(), amount);
          await ctx.reply(ok ? '✅ QR отправлен.' : '❌ Не удалось отправить QR.');
        } else {
          await ctx.reply('❌ Callback не настроен.');
        }
      } else {
        await ctx.reply(`⚠️ Заявка ${arg.trim()} ещё не подтверждена (статус: ${status}). Подтвердите в кабинете.`);
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
    const caption = BotText.qrCaption(orderId, amount);

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
        caption: `🔐 Нужен код из SMS для входа в кабинет банка.\nПришлите цифры кода ответом.\n\n${timestamp}`,
      });

      this.isWaitingForSms = true;
      this.logger.info(`Dispatcher: SMS request sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsRequest to ${this.adminChatId}`);
    }
  }

  async sendConfirmationAlert(externalId: string, amount: number): Promise<void> {
    let successCount = 0;
    const caption = BotText.needsConfirmation(externalId, amount);

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

  /** Send a debug screenshot to admin chat only. */
  async sendToAdminChat(photoBuffer: Buffer, caption: string, filename: string): Promise<void> {
    if (!this.adminChatId) {
      this.logger.warn('Dispatcher: ADMIN_ID not configured, debug screenshot skipped');
      return;
    }
    try {
      await this.bot.telegram.sendPhoto(this.adminChatId, {
        source: photoBuffer,
        filename,
      }, { caption });
      this.logger.debug(`Dispatcher: Debug screenshot sent to admin (${caption})`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendToAdminChat ${caption}`);
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.logger.info('Dispatcher: Telegram bot stopped');
  }

  // SMS Confirmation Methods

  private decisionKeyboard(orderId: string) {
    return {
      inline_keyboard: [[
        { text: BotText.sendSmsButton, callback_data: `send_sms:${orderId}` },
        { text: BotText.skipSmsButton, callback_data: `cancel_sms:${orderId}` },
      ]],
    };
  }

  async sendSmsConfirmationRequest(orderId: string, amount: number): Promise<boolean> {
    const caption = BotText.askSendSms(orderId, amount, formatTimeLeft(DECISION_TIMEOUT_SEC));

    this.decisionMessageRefs.delete(orderId);
    let successCount = 0;

    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        const message = await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
          reply_markup: this.decisionKeyboard(orderId),
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
      // A late press must not be taken as an SMS code by the code step
      if (!this.awaitingDecision.has(orderId)) {
        await ctx.answerCbQuery('Уже не актуально');
        return;
      }
      await ctx.answerCbQuery('Отправляю SMS…');
      this.smsCodeCallbacks.get(orderId)?.('CONFIRMED');
      this.logger.info(`Dispatcher: SMS confirmation callback triggered for ${orderId}`);
      await ctx.editMessageText(BotText.sendingSms(orderId), { reply_markup: undefined });
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to handle SMS confirmation callback for ${orderId} - ${error}`);
      await ctx.answerCbQuery('Ошибка').catch(() => {});
    }
  }

  async sendSmsCodeRequest(orderId: string, screenshot: Buffer, caption: string): Promise<boolean> {
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
      if (!/^\d{4,6}$/.test(code)) {
        await ctx.reply(BotText.badCodeFormat);
        return;
      }

      const callback = this.smsCodeCallbacks.get(orderId);
      if (!callback) {
        await ctx.reply(BotText.codeNotExpected(orderId));
        return;
      }

      const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'сотрудник';
      this.logger.info(`Dispatcher: SMS code received for ${orderId} from ${username}`);
      this.smsCodeCallbacks.delete(orderId);
      // One status for everybody: the request message turns into "checking" before the next request can replace it
      await this.updateCountdownMessage(orderId, BotText.checkingCode(orderId, username));
      callback(code);
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to handle SMS code reply for ${orderId} - ${error}`);
      await ctx.reply('❌ Не получилось принять код, пришлите ещё раз.').catch(() => {});
    }
  }

  async sendToAllowedChats(message: string): Promise<void> {
    for (const { chatId, threadId } of this.getNotificationChats()) {
      try {
        await this.bot.telegram.sendMessage(chatId, message, {
          message_thread_id: threadId,
        });
      } catch (error) {
        await this.handleTelegramError(error, `sendToAllowedChats to ${chatId}`);
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

  private async handleSmsCancellation(orderId: string, ctx: any): Promise<void> {
    try {
      if (!this.awaitingDecision.has(orderId)) {
        await ctx.answerCbQuery('Уже не актуально');
        return;
      }
      await ctx.answerCbQuery('Не отправляю');

      // Trigger the callback with CANCELLED signal
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback('CANCELLED');
        this.logger.info(`Dispatcher: SMS cancellation callback triggered for ${orderId}`);
      } else {
        this.logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
      }

      // Get user info to include in the message
      const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'сотрудник';

      // Update the message
      await ctx.editMessageText(BotText.smsSkipped(orderId, username), { reply_markup: undefined });

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

  /** Edits every "enter the code" message (it is a photo, so the caption changes). */
  async updateCountdownMessage(orderId: string, caption: string): Promise<void> {
    for (const ref of this.getMessageRefs(this.codeMessageRefs, orderId)) {
      try {
        await this.bot.telegram.editMessageCaption(ref.chatId, ref.messageId, undefined, caption);
      } catch (editError: any) {
        if (editError?.response?.description?.includes('message is not modified')) continue;
        await this.handleTelegramError(editError, `updateCountdownMessage to ${ref.chatId}`);
      }
    }
  }

  /** Edits every "send SMS?" message; keyboard=false removes the buttons. */
  async updateDecisionMessage(orderId: string, text: string, keyboard: boolean): Promise<void> {
    for (const ref of this.getMessageRefs(this.decisionMessageRefs, orderId)) {
      try {
        await this.bot.telegram.editMessageText(ref.chatId, ref.messageId, undefined, text, {
          reply_markup: keyboard ? this.decisionKeyboard(orderId) : undefined,
        });
      } catch (editError: any) {
        if (editError?.response?.description?.includes('message is not modified')) continue;
        await this.handleTelegramError(editError, `updateDecisionMessage to ${ref.chatId}`);
      }
    }
  }

  /**
   * Waits for one callback (button or code) for this order, refreshing the countdown every minute.
   * Resolves with null when time runs out. The callback is always unregistered on exit.
   */
  private waitForAnswer(
    orderId: string,
    timeoutSec: number,
    onTick: (timeLeft: string) => Promise<void>
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let secondsLeft = timeoutSec;
      const finish = (value: string | null) => {
        clearInterval(tick);
        clearTimeout(timer);
        this.smsCodeCallbacks.delete(orderId);
        resolve(value);
      };
      const tick = setInterval(() => {
        secondsLeft -= 60;
        if (secondsLeft > 0) void onTick(formatTimeLeft(secondsLeft)).catch(() => {});
      }, 60000);
      const timer = setTimeout(() => finish(null), timeoutSec * 1000);
      this.registerSmsCodeCallback(orderId, (value) => finish(value));
    });
  }

  private async syncSmsStatus(orderId: string, amount: number, status: SmsStatus, incrementCount = false): Promise<void> {
    const registry = this.surveillanceAgent?.getRegistry();
    if (!registry) return;
    try {
      const existing = await registry.getSmsConfirmation(orderId);
      if (!existing) await registry.registerSmsConfirmation(orderId, amount, status);
      if (incrementCount) {
        await registry.updateSmsStatusWithCount(orderId, status);
      } else if (existing) {
        await registry.updateSmsStatus(orderId, status);
      }
    } catch (error) {
      this.logger.error(`Dispatcher: Failed to save SMS status ${status} for ${orderId} - ${error}`);
    }
  }

  /** Step 1: "send SMS to the client?" Returns 'CONFIRMED', 'CANCELLED' or null (no answer / not sent). */
  private async askSendSmsDecision(orderId: string, amount: number): Promise<string | null> {
    if (!(await this.sendSmsConfirmationRequest(orderId, amount))) return null;
    this.awaitingDecision.add(orderId);
    try {
      const answer = await this.waitForAnswer(orderId, DECISION_TIMEOUT_SEC, (timeLeft) =>
        this.updateDecisionMessage(orderId, BotText.askSendSms(orderId, amount, timeLeft), true)
      );
      if (answer === null) await this.updateDecisionMessage(orderId, BotText.decisionExpired, false);
      if (answer === 'CONFIRMED') await this.updateDecisionMessage(orderId, BotText.sendingSms(orderId), false);
      return answer;
    } finally {
      this.awaitingDecision.delete(orderId);
    }
  }

  /** Step 2 (one attempt): posts the code request with a fresh screenshot and waits for the reply. */
  private async askSmsCode(
    orderId: string,
    amount: number,
    kind: CodeRequestKind,
    attempt: number,
    maxAttempts: number
  ): Promise<string | null> {
    const caption = (timeLeft: string) => kind === 'FIRST'
      ? BotText.waitingCode(orderId, amount, timeLeft)
      : BotText.wrongCode(orderId, attempt, maxAttempts, timeLeft);

    const screenshot = await this.surveillanceAgent!.takeSmsScreenshot(orderId, 'input');
    if (!screenshot) return null;
    if (!(await this.sendSmsCodeRequest(orderId, screenshot, caption(formatTimeLeft(CODE_TIMEOUT_SEC))))) return null;

    const code = await this.waitForAnswer(orderId, CODE_TIMEOUT_SEC, (timeLeft) =>
      this.updateCountdownMessage(orderId, caption(timeLeft))
    );
    if (code === null) await this.updateCountdownMessage(orderId, BotText.codeTimedOut(orderId));
    return code;
  }

  /** Maps how the code dialog ended to a flow status, a DB status and one short chat message. */
  private async finishCodeLoop(orderId: string, amount: number, outcome: SmsCodeLoopOutcome): Promise<SmsFlowStatus> {
    switch (outcome) {
      case 'ACCEPTED':
        await this.updateCountdownMessage(orderId, BotText.codeAccepted(orderId));
        await this.syncSmsStatus(orderId, amount, 'SMS_CONFIRMED');
        return SmsFlowStatus.SUCCESS;
      case 'CANCELLED':
        await this.syncSmsStatus(orderId, amount, 'USER_REFUSED_SMS');
        return SmsFlowStatus.CANCELLED;
      case 'NO_CODE':
        await this.syncSmsStatus(orderId, amount, 'SMS_TIMEOUT');
        return SmsFlowStatus.TIMEOUT;
      case 'TOO_MANY_WRONG':
        await this.sendToAllowedChats(BotText.tooManyWrong(orderId));
        await this.syncSmsStatus(orderId, amount, 'SMS_BLOCKED');
        return SmsFlowStatus.TIMEOUT;
      case 'BLOCKED':
        await this.sendToAllowedChats(BotText.codeBlocked(orderId));
        await this.syncSmsStatus(orderId, amount, 'SMS_BLOCKED');
        return SmsFlowStatus.TIMEOUT;
      default:
        // The page misbehaved — the code may still have gone through; the bank table decides
        await this.sendToAllowedChats(BotText.codeNotEntered(orderId));
        await this.syncSmsStatus(orderId, amount, 'SMS_TIMEOUT');
        return SmsFlowStatus.NEEDS_BANK_CHECK;
    }
  }

  /**
   * Full SMS confirmation of one order:
   * ask "send SMS?" -> press the bank button -> ask for the code -> enter it -> read the page.
   * A wrong code keeps the bank dialog open, so the staff is asked again (up to SMS_MAX_ATTEMPTS).
   */
  async performSmsFlow(orderId: string, amount: number): Promise<SmsFlowStatus> {
    const surveillance = this.surveillanceAgent;
    const registry = surveillance?.getRegistry() ?? null;
    if (!surveillance) {
      this.logger.error('Surveillance agent not available in performSmsFlow');
      return SmsFlowStatus.TIMEOUT;
    }

    if (registry && !(await registry.acquireSmsLock(orderId, amount))) {
      this.logger.warn(`Dispatcher: SMS lock is already held for ${orderId}, skipping flow`);
      return SmsFlowStatus.TIMEOUT;
    }

    try {
      return await this.runSmsFlowSteps(orderId, amount, surveillance);
    } catch (error) {
      this.logger.error(`Error in SMS flow for ${orderId}: ${error}`);
      await this.syncSmsStatus(orderId, amount, 'SMS_TIMEOUT');
      return SmsFlowStatus.TIMEOUT;
    } finally {
      this.smsCodeCallbacks.delete(orderId);
      this.clearReplyContexts(orderId);
      this.clearMessageRefs(orderId);
      if (registry) await registry.releaseSmsLock(orderId);
    }
  }

  private async runSmsFlowSteps(orderId: string, amount: number, surveillance: SurveillanceAgent): Promise<SmsFlowStatus> {
    // sent_count = number of "send SMS?" requests posted to chat
    await this.syncSmsStatus(orderId, amount, 'WAITING_FOR_USER_ACTION', true);

    const decision = await this.askSendSmsDecision(orderId, amount);
    if (decision === 'CANCELLED') {
      await this.syncSmsStatus(orderId, amount, 'USER_REFUSED_SMS');
      return SmsFlowStatus.CANCELLED;
    }
    if (decision === null) {
      await this.syncSmsStatus(orderId, amount, 'IGNORED');
      return SmsFlowStatus.TIMEOUT;
    }

    if (!(await surveillance.clickSendSmsButton(orderId))) {
      this.logger.error(`Failed to click Send SMS button for ${orderId} after user confirmation`);
      await this.sendToAllowedChats(BotText.codeNotEntered(orderId));
      await this.syncSmsStatus(orderId, amount, 'SMS_TIMEOUT');
      return SmsFlowStatus.NEEDS_BANK_CHECK;
    }
    await this.syncSmsStatus(orderId, amount, 'SMS_SENT');

    const maxAttempts = parseInt(process.env.SMS_MAX_ATTEMPTS || '3', 10);
    const outcome = await runSmsCodeLoop({
      askCode: (kind, attempt) => this.askSmsCode(orderId, amount, kind, attempt, maxAttempts),
      enterCode: (code) => surveillance.enterSmsCode(code, orderId),
      submitCode: () => surveillance.confirmSmsCode(orderId),
      isDialogOpen: () => surveillance.isSmsCodeDialogOpen(),
      onWrongCode: async () => {
        await this.updateCountdownMessage(orderId, BotText.wrongCodeShort(orderId));
        const registry = surveillance.getRegistry();
        if (registry) await registry.updateSmsAttempts(orderId).catch(() => 0);
      },
    }, orderId, maxAttempts);

    return this.finishCodeLoop(orderId, amount, outcome);
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

  setOnConfirmQr(cb: (orderId: string, amount: number) => Promise<boolean>): void {
    this.onConfirmQr = cb;
  }
}
