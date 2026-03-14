import QRCode from 'qrcode';
import { Logger } from '../utils/Logger';

/**
 * Generator Agent - создаёт 1C-совместимый QR-код
 * Protocol Template: AI1|KZ282|2489604|${amount}.00|210140004940|KZ10609|1|0.00|1
 */
export class GeneratorAgent {
  private static readonly MERCHANT_ID = '2489604';
  private static readonly ACCOUNT = '210140004940';
  private static readonly BANK_CODE = 'KZ10609';

  /**
   * Формирует строку протокола для QR-кода
   */
  private buildProtocolString(amount: number): string {
    // Форматируем сумму с 2 знаками после запятой
    const formattedAmount = amount.toFixed(2);
    
    return `AI1|KZ282|${GeneratorAgent.MERCHANT_ID}|${formattedAmount}|${GeneratorAgent.ACCOUNT}|${GeneratorAgent.BANK_CODE}|1|0.00|1`;
  }

  /**
   * Генерирует QR-код и возвращает Buffer
   */
  async generateQR(amount: number): Promise<Buffer> {
    try {
      const protocolString = this.buildProtocolString(amount);
      Logger.info(`Generator: Protocol string: ${protocolString}`);

      const qrBuffer = await QRCode.toBuffer(protocolString, {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

      Logger.info('Generator: QR code generated successfully');
      return qrBuffer;
    } catch (error) {
      Logger.error(`Generator: Failed to generate QR - ${error}`);
      throw error;
    }
  }

  /**
   * Сохраняет QR-код в файл (для тестирования)
   */
  async generateQRToFile(amount: number, orderId: string): Promise<string> {
    const path = require('path');
    const fs = require('fs');
    
    const buffer = await this.generateQR(amount);
    const filePath = path.join(process.cwd(), 'storage', `qr_${orderId}.png`);
    
    fs.writeFileSync(filePath, buffer);
    Logger.info(`Generator: QR saved to ${filePath}`);
    
    return filePath;
  }
}
