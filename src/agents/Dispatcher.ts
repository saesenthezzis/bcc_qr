import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/Logger';
import { SurveillanceAgent } from './Surveillance';

/**
 * Структура чата с поддержкой тем (Topics)
 */
export interface ChatWithThread {
  chatId: number;
  threadId?: number;
}

/**
 * Dispatcher Agent - отправка QR-кодов в Telegram
 */
export class DispatcherAgent {
  private bot: Telegraf<Context>;
  private allowedChats: ChatWithThread[];
  private adminChatId: number | null;
  private surveillanceAgent: SurveillanceAgent | null = null;
  private isWaitingForSms: boolean = false;

  constructor(botToken: string, chatIds: string[], adminId?: string, surveillanceAgent?: SurveillanceAgent) {
    this.bot = new Telegraf(botToken);
    // Парсинг формата chatId:threadId
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

  /**
   * Проверка авторизации chat_id
   */
  private isAuthorized(chatId: number): boolean {
    return this.allowedChats.some(c => c.chatId === chatId);
  }

  /**
   * Проверка, является ли chat_id админом
   */
  private isAdmin(chatId: number): boolean {
    return this.adminChatId === chatId;
  }

  /**
   * Обработка ошибки миграции чата (supergroup)
   */
  private async handleTelegramError(error: any, context: string): Promise<void> {
    if (error?.response?.error_code === 400) {
      const description = error.response.description || '';
      
      // Обработка "group chat was upgraded to a supergroup chat"
      if (description.includes('group chat was upgraded to a supergroup chat')) {
        const migrateToChatId = error.response.parameters?.migrate_to_chat_id;
        if (migrateToChatId) {
          Logger.error(`Dispatcher: ${context} - Chat migrated! New ID: ${migrateToChatId}`);
          Logger.error(`Dispatcher: Update TELEGRAM_CHAT_IDS in .env to use ${migrateToChatId}`);
          return;
        }
      }
      
      // Обработка "message can't be sent to this chat"
      if (description.includes('message can\'t be sent to this chat')) {
        Logger.error(`Dispatcher: ${context} - Cannot send to this chat. Check bot permissions.`);
        return;
      }
    }
    
    Logger.error(`Dispatcher: ${context} - ${error?.message || error}`);
  }

  /**
   * Настройка обработчиков бота
   */
  private setupBot(): void {
    // Обработчик команды /start
    this.bot.start((ctx) => {
      if (this.isAuthorized(ctx.chat.id)) {
        ctx.reply('✅ Авторизовано. Система CreditBridge активна.');
      } else {
        ctx.reply('❌ Доступ запрещён.');
        Logger.warn(`Unauthorized access attempt from chat_id: ${ctx.chat.id}`);
      }
    });

    // Обработчик команды /status
    this.bot.command('status', (ctx) => {
      if (!this.isAuthorized(ctx.chat.id)) {
        ctx.reply('❌ Доступ запрещён.');
        return;
      }

      ctx.reply(`📊 Статус системы:\nВремя: ${new Date().toISOString()}\nСтатус: Активен`);
    });

    // === Обработчик сообщений для СМС-кодов ===
    this.bot.on('text', async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();

      // Если ожидаем СМС-код и сообщение от админа
      if (this.isWaitingForSms && this.isAdmin(chatId)) {
        // Проверяем, что текст похож на СМС-код (цифры)
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

      // Обычные сообщения игнорируем
    });

    // Запуск бота
    this.bot.launch().then(() => {
      Logger.info('Dispatcher: Telegram bot launched');
    }).catch((error) => {
      Logger.error(`Dispatcher: Failed to launch bot - ${error}`);
    });
  }

  /**
   * Отправка QR-кода во все чаты из TELEGRAM_CHAT_IDS (с поддержкой тем)
   */
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

  /**
   * Отправка критической ошибки только админу (TELEGRAM_ADMIN_ID)
   */
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

  /**
   * Отправка уведомления о требуемом СМС-коде (с скриншотом)
   */
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

  /**
   * Отправка уведомления о необходимости подтверждения заявки (PENDING)
   * Отправляется во ВСЕ чаты из TELEGRAM_CHAT_IDS (включая группу)
   */
  async sendConfirmationAlert(externalId: string, amount: number): Promise<void> {
    const caption = `⚠️ ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ\n\nИИН: ${externalId}\nСумма: ${amount.toFixed(2)} тг\n\n---\nНужно подтвердить заявку в личном кабинете: https://online.bcc.kz/cashier-cabinet/ru\nПосле вашего подтверждения бот автоматически пришлет QR-код в этот чат.\n\n📖 Актуальная инструкция — в закрепленном сообщении.\n\n🔔 НАПОМИНАНИЕ: все неподтвержденные заявки автоматически аннулируются.`;

    // Отправка во все чаты (включая группу)
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

  /**
   * Уведомление о успешном запуске бота на сервере
   */
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

  /**
   * Остановка бота
   */
  async stop(): Promise<void> {
    await this.bot.stop();
    Logger.info('Dispatcher: Telegram bot stopped');
  }
}
