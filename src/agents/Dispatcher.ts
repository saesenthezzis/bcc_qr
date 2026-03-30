import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/Logger';
import { SurveillanceAgent } from './Surveillance';

export interface ChatWithThread {
  chatId: number;
  threadId?: number;
}

export interface SmsCodeReplyContext {
  orderId: string;
  messageId: number;
  timestamp: number;
}

export class DispatcherAgent {
  private bot: Telegraf<Context>;
  private allowedChats: ChatWithThread[];
  private adminChatId: number | null;
  private surveillanceAgent: SurveillanceAgent | null = null;
  private isWaitingForSms: boolean = false;
  private smsCodeReplyContexts: Map<string, SmsCodeReplyContext> = new Map();
  private smsCodeCallbacks: Map<string, (code: string) => void> = new Map();

  constructor(botToken: string, chatIds: string[], adminId?: string, surveillanceAgent?: SurveillanceAgent) {
    this.bot = new Telegraf(botToken);
    this.allowedChats = chatIds.map((idStr) => {
      const parts = idStr.split(':');
      const chatId = parseInt(parts[0], 10);
      const threadId = parts.length > 1 ? parseInt(parts[1], 10) : undefined;
      return { chatId, threadId };
    });
    this.adminChatId = adminId ? parseInt(adminId, 10) : null;
    this.surveillanceAgent = surveillanceAgent || null;

    this.setupBot();
  }

  private isAuthorized(chatId: number): boolean {
    return this.allowedChats.some(c => c.chatId === chatId);
  }

  private isAdmin(chatId: number): boolean {
    return this.adminChatId === chatId;
  }

  private async handleTelegramError(error: any, context: string): Promise<void> {
    if (error?.response?.error_code === 400) {
      const description = error.response.description || '';

      if (description.includes('group chat was upgraded to a supergroup chat')) {
        const migrateToChatId = error.response.parameters?.migrate_to_chat_id;
        if (migrateToChatId) {
          Logger.error(`Dispatcher: ${context} - Chat migrated! New ID: ${migrateToChatId}`);
          Logger.error(`Dispatcher: Update TELEGRAM_CHAT_IDS in .env to use ${migrateToChatId}`);
          return;
        }
      }

      if (description.includes('message can\'t be sent to this chat')) {
        Logger.error(`Dispatcher: ${context} - Cannot send to this chat. Check bot permissions.`);
        return;
      }
    }

    Logger.error(`Dispatcher: ${context} - ${error?.message || error}`);
  }

  private setupBot(): void {
    this.bot.start((ctx) => {
      if (this.isAuthorized(ctx.chat.id)) {
        ctx.reply('✅ Авторизовано. Система CreditBridge активна.');
      } else {
        ctx.reply('❌ Доступ запрещён.');
        Logger.warn(`Unauthorized access attempt from chat_id: ${ctx.chat.id}`);
      }
    });

    this.bot.command('status', (ctx) => {
      if (!this.isAuthorized(ctx.chat.id)) {
        ctx.reply('❌ Доступ запрещён.');
        return;
      }

      ctx.reply(`📊 Статус системы:\nВремя: ${new Date().toISOString()}\nСтатус: Активен`);
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

    this.bot.on('text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();
      const replyToMessage = ctx.message.reply_to_message;

      // Handle SMS code reply for order confirmation (works in group chat)
      if (replyToMessage && this.isAuthorized(chatId)) {
        const replyMessageId = replyToMessage.message_id;
        
        // Check if this is a reply to an SMS code request
        for (const [orderId, context] of this.smsCodeReplyContexts.entries()) {
          if (context.messageId === replyMessageId) {
            await this.handleSmsCodeReply(orderId, text, ctx);
            return;
          }
        }
      }

      // Handle SMS code for login (existing functionality)
      if (this.isWaitingForSms && this.isAdmin(chatId)) {
        if (/^\d{4,8}$/.test(text)) {
          if (this.surveillanceAgent) {
            this.surveillanceAgent.submitSmsCode(text);
            this.isWaitingForSms = false;
            await ctx.reply('✅ СМС-код принят и введён в систему.');
            Logger.info(`Dispatcher: SMS code received from admin ${chatId}`);
          }
        } else {
          await ctx.reply('❌ Неверный формат СМС-кода. Отправьте только цифры (4-8 знаков).');
        }
        return;
      }
    });

    this.bot.launch().then(() => {
      Logger.info('Dispatcher: Telegram bot launched');
    }).catch((error) => {
      Logger.error(`Dispatcher: Failed to launch bot - ${error}`);
    });
  }

  async sendQRCode(photoBuffer: Buffer, orderId: string, amount: number): Promise<void> {
    const caption = `🧾 ИИН #${orderId}\nСумма: ${amount.toFixed(2)} KZT\n${new Date().toISOString()}`;

    for (const { chatId, threadId } of this.allowedChats) {
      try {
        await this.bot.telegram.sendPhoto(chatId, {
          source: photoBuffer,
          filename: `qr_${orderId}.png`,
        }, {
          caption,
          message_thread_id: threadId,
        });

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.info(`Dispatcher: QR sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (error) {
        await this.handleTelegramError(error, `sendQRCode to ${chatId}`);
      }
    }
  }

  async sendErrorMessage(error: unknown): Promise<void> {
    if (!this.adminChatId) {
      Logger.warn('Dispatcher: ADMIN_ID not configured, error notification skipped');
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    const caption = `🚨 Ошибка в цикле мониторинга\n\n⏰ Время: ${timestamp}\n❗ Описание: ${errorMessage}`;

    try {
      await this.bot.telegram.sendMessage(this.adminChatId, caption);
      Logger.info(`Dispatcher: Error message sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendErrorMessage to ${this.adminChatId}`);
    }
  }

  async sendSmsRequest(screenshot: Buffer, timestamp: string): Promise<void> {
    if (!this.adminChatId) {
      Logger.warn('Dispatcher: ADMIN_ID not configured, SMS request skipped');
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
      Logger.info(`Dispatcher: SMS request sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsRequest to ${this.adminChatId}`);
    }
  }

  async sendConfirmationAlert(externalId: string, amount: number): Promise<void> {
    const caption = `⚠️ ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ\n\nИИН: ${externalId}\nСумма: ${amount.toFixed(2)} тг\n\n---\nНужно подтвердить заявку в личном кабинете: https://online.bcc.kz/cashier-cabinet/ru\nПосле вашего подтверждения бот автоматически пришлет QR-код в этот чат.\n\nАктуальная инструкция — в закрепленном сообщении.\n\nНАПОМИНАНИЕ: все неподтвержденные заявки автоматически аннулируются.`;

    for (const { chatId, threadId } of this.allowedChats) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });
        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.info(`Dispatcher: Confirmation alert sent to chat_id ${chatId}${threadInfo} for order ${externalId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendConfirmationAlert to ${chatId}`);
      }
    }
  }

  async sendStartupNotification(): Promise<void> {
    if (!this.adminChatId) {
      Logger.warn('Dispatcher: ADMIN_ID not configured, startup notification skipped');
      return;
    }

    const caption = `🚀 Бот успешно запущен на сервере Render и готов к работе!\n\n⏰ Время: ${new Date().toISOString()}\n🌐 Environment: ${process.env.NODE_ENV || 'production'}`;

    try {
      await this.bot.telegram.sendMessage(this.adminChatId, caption);
      Logger.info(`Dispatcher: Startup notification sent to admin ${this.adminChatId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, 'sendStartupNotification');
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    Logger.info('Dispatcher: Telegram bot stopped');
  }

  // SMS Confirmation Methods

  async sendSmsConfirmationRequest(orderId: string, amount: number): Promise<string | null> {
    const caption = `📲 ОТПРАВИТЬ СМС КЛИЕНТУ?\n\nИИН: ${orderId}\nСумма: ${amount.toFixed(2)} тг\n\n⚠️ Нажмите кнопку ниже, чтобы отправить СМС-код клиенту для подтверждения заявки.`;

    let messageId: string | null = null;

    for (const { chatId, threadId } of this.allowedChats) {
      try {
        const message = await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Да, отправить СМС клиенту', callback_data: `send_sms:${orderId}` },
                { text: '❌ Отмена / Клиент отказался', callback_data: `cancel_sms:${orderId}` }
              ]
            ]
          }
        });

        if (!messageId) {
          messageId = message.message_id.toString();
        }

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.info(`Dispatcher: SMS confirmation request sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsConfirmationRequest to ${chatId}`);
      }
    }

    return messageId;
  }

  private async handleSmsConfirmationCallback(orderId: string, ctx: any): Promise<void> {
    try {
      await ctx.answerCbQuery('Обработка запроса...');

      // Trigger the callback if registered
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback('CONFIRMED');
        Logger.info(`Dispatcher: SMS confirmation callback triggered for ${orderId}`);
      } else {
        Logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
      }

      // Update the message
      await ctx.editMessageText(
        `✅ Запрос принят!\n\nИИН: ${orderId}\n\nОтправка СМС клиенту...`,
        { reply_markup: undefined }
      );
    } catch (error) {
      Logger.error(`Dispatcher: Failed to handle SMS confirmation callback for ${orderId} - ${error}`);
      await ctx.answerCbQuery('Ошибка обработки запроса').catch(() => {});
    }
  }

  async sendSmsCodeRequest(orderId: string, screenshot: Buffer): Promise<string | null> {
    const caption = `🔐 ВВЕДИТЕ СМС-КОД\n\nИИН: ${orderId}\n\n📝 Ответьте на это сообщение с СМС-кодом (только цифры).`;

    let messageId: string | null = null;

    for (const { chatId, threadId } of this.allowedChats) {
      try {
        const message = await this.bot.telegram.sendPhoto(chatId, {
          source: screenshot,
          filename: `sms_code_${orderId}.png`,
        }, {
          caption,
          message_thread_id: threadId,
        });

        // Store context for reply handling
        this.smsCodeReplyContexts.set(orderId, {
          orderId,
          messageId: message.message_id,
          timestamp: Date.now(),
        });

        if (!messageId) {
          messageId = message.message_id.toString();
        }

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.info(`Dispatcher: SMS code request sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendSmsCodeRequest to ${chatId}`);
      }
    }

    return messageId;
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
        Logger.info(`Dispatcher: SMS code received for ${orderId}: ${code} from ${username}`);
        
        // Update the original message with confirmation
        const replyContext = this.smsCodeReplyContexts.get(orderId);
        if (replyContext) {
          try {
            await this.bot.telegram.editMessageCaption(
              ctx.chat.id,
              replyContext.messageId,
              undefined,
              `✅ КОД ВВЕДЕН\n\nИИН: ${orderId}\n\n👤 Код введен пользователем ${username}\n⏰ ${new Date().toISOString()}`
            );
          } catch (editError) {
            Logger.warn(`Dispatcher: Failed to edit message for ${orderId} - ${editError}`);
          }
        }

        await ctx.reply(`✅ СМС-код принят для заявки ${orderId}`);

        // Clean up context
        this.smsCodeReplyContexts.delete(orderId);
        this.smsCodeCallbacks.delete(orderId);
      } else {
        Logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
        await ctx.reply(`⚠️ Заявка ${orderId} не найдена или уже обработана.`);
      }
    } catch (error) {
      Logger.error(`Dispatcher: Failed to handle SMS code reply for ${orderId} - ${error}`);
      await ctx.reply('❌ Ошибка обработки СМС-кода').catch(() => {});
    }
  }

  async sendSmsBlockedAlert(orderId: string, screenshot: Buffer): Promise<void> {
    if (!this.adminChatId) {
      Logger.warn('Dispatcher: ADMIN_ID not configured, SMS blocked alert skipped');
      return;
    }

    try {
      const caption = `🚫 СМС ЗАБЛОКИРОВАН\n\nИИН: ${orderId}\n\n⚠️ Клиент несколько раз ввел неверный СМС-код. Отправка СМС временно заблокирована.\n\nПопробуйте позже или свяжитесь с клиентом.`;

      await this.bot.telegram.sendPhoto(this.adminChatId, {
        source: screenshot,
        filename: `sms_blocked_${orderId}.png`,
      }, {
        caption,
      });

      Logger.info(`Dispatcher: SMS blocked alert sent to admin ${this.adminChatId} for order ${orderId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsBlockedAlert to ${this.adminChatId}`);
    }
  }

  async sendSmsLimitExceeded(orderId: string, attempts: number): Promise<void> {
    if (!this.adminChatId) {
      Logger.warn('Dispatcher: ADMIN_ID not configured, SMS limit exceeded alert skipped');
      return;
    }

    try {
      const caption = `⛔ ПРЕВЫШЕН ЛИМИТ ПОПЫТОК\n\nИИН: ${orderId}\nПопыток: ${attempts}\n\n❌ Достигнут максимальный лимит попыток отправки СМС (${process.env.SMS_MAX_ATTEMPTS || 3}).\n\nЗаявка требует ручной обработки.`;

      await this.bot.telegram.sendMessage(this.adminChatId, caption);

      Logger.info(`Dispatcher: SMS limit exceeded alert sent to admin ${this.adminChatId} for order ${orderId}`);
    } catch (sendError) {
      await this.handleTelegramError(sendError, `sendSmsLimitExceeded to ${this.adminChatId}`);
    }
  }

  registerSmsCodeCallback(orderId: string, callback: (code: string) => void): void {
    this.smsCodeCallbacks.set(orderId, callback);
    Logger.info(`Dispatcher: SMS code callback registered for ${orderId}`);
  }

  unregisterSmsCodeCallback(orderId: string): void {
    this.smsCodeCallbacks.delete(orderId);
    this.smsCodeReplyContexts.delete(orderId);
    Logger.info(`Dispatcher: SMS code callback unregistered for ${orderId}`);
  }

  private async handleSmsCancellation(orderId: string, ctx: any): Promise<void> {
    try {
      await ctx.answerCbQuery('Отменено');

      // Trigger the callback with CANCELLED signal
      const callback = this.smsCodeCallbacks.get(orderId);
      if (callback) {
        callback('CANCELLED');
        Logger.info(`Dispatcher: SMS cancellation callback triggered for ${orderId}`);
      } else {
        Logger.warn(`Dispatcher: No callback registered for order ${orderId}`);
      }

      // Update the message
      await ctx.editMessageText(
        `❌ ОТМЕНЕНО\n\nИИН: ${orderId}\n\n⚠️ Администратор отменил отправку СМС.\nПричина: Клиент отказался или другая причина.`,
        { reply_markup: undefined }
      );

      // Clean up
      this.smsCodeCallbacks.delete(orderId);
      this.smsCodeReplyContexts.delete(orderId);

      Logger.info(`Dispatcher: SMS request cancelled for ${orderId}`);
    } catch (error) {
      Logger.error(`Dispatcher: Failed to handle SMS cancellation for ${orderId} - ${error}`);
      await ctx.answerCbQuery('Ошибка отмены').catch(() => {});
    }
  }

  async updateCountdownMessage(orderId: string, messageId: string, countdownText: string): Promise<void> {
    for (const { chatId, threadId } of this.allowedChats) {
      try {
        await this.bot.telegram.editMessageCaption(
          chatId,
          parseInt(messageId, 10),
          undefined,
          `🔐 ВВЕДИТЕ СМС-КОД\n\nИИН: ${orderId}\n\n${countdownText}\n\n📝 Ответьте на это сообщение с СМС-кодом (только цифры).`
        );

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.debug(`Dispatcher: Countdown updated for ${orderId} in chat_id ${chatId}${threadInfo}`);
      } catch (editError: any) {
        // Ignore "message is not modified" errors
        if (editError?.response?.description?.includes('message is not modified')) {
          continue;
        }
        await this.handleTelegramError(editError, `updateCountdownMessage to ${chatId}`);
      }
    }
  }

  async updateDecisionCountdown(orderId: string, messageId: string, countdownText: string): Promise<void> {
    for (const { chatId, threadId } of this.allowedChats) {
      try {
        await this.bot.telegram.editMessageText(
          chatId,
          parseInt(messageId, 10),
          undefined,
          `📲 ОТПРАВИТЬ СМС КЛИЕНТУ?\n\nИИН: ${orderId}\n\n${countdownText}\n\n⚠️ Нажмите кнопку ниже, чтобы отправить СМС-код клиенту для подтверждения заявки.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Да, отправить СМС клиенту', callback_data: `send_sms:${orderId}` },
                  { text: '❌ Отмена / Клиент отказался', callback_data: `cancel_sms:${orderId}` }
                ]
              ]
            }
          }
        );

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.debug(`Dispatcher: Decision countdown updated for ${orderId} in chat_id ${chatId}${threadInfo}`);
      } catch (editError: any) {
        // Ignore "message is not modified" errors
        if (editError?.response?.description?.includes('message is not modified')) {
          continue;
        }
        await this.handleTelegramError(editError, `updateDecisionCountdown to ${chatId}`);
      }
    }
  }

  async sendTimeoutAlert(orderId: string): Promise<void> {
    const caption = `⏱️ ТАЙМАУТ СМС-КОДА\n\nИИН: ${orderId}\n\n❌ Истекло время ожидания СМС-кода (5 минут).\n\nЗаявка требует повторной обработки.`;

    for (const { chatId, threadId } of this.allowedChats) {
      try {
        await this.bot.telegram.sendMessage(chatId, caption, {
          message_thread_id: threadId,
        });

        const threadInfo = threadId ? ` (thread ${threadId})` : '';
        Logger.info(`Dispatcher: Timeout alert sent to chat_id ${chatId}${threadInfo} for order ${orderId}`);
      } catch (sendError) {
        await this.handleTelegramError(sendError, `sendTimeoutAlert to ${chatId}`);
      }
    }
  }
}
