import QRCode from 'qrcode';
import { Logger } from '../utils/Logger';
import { getBccCode } from '../utils/InstallmentMapper';

export class GeneratorAgent {
  private static readonly MERCHANT_ID = '2489604';
  private static readonly ACCOUNT = '210140004940';
  private static readonly BANK_CODE = 'KZ10609';
  private static readonly DEFAULT_BCC_CODE = 'KZ284'; // Default fallback

  private buildProtocolString(amount: number, bccCode: string): string {
    const formattedAmount = amount.toFixed(2);
    return `AI1|${bccCode}|${GeneratorAgent.MERCHANT_ID}|${formattedAmount}|${GeneratorAgent.ACCOUNT}|${GeneratorAgent.BANK_CODE}|1|0.00|1`;
  }

  async generateQR(amount: number, installmentPeriod?: string): Promise<Buffer> {
    try {
      // Determine BCC code based on installment period
      let bccCode = GeneratorAgent.DEFAULT_BCC_CODE;
      
      if (installmentPeriod) {
        const mappedCode = getBccCode(installmentPeriod);
        if (mappedCode !== 'UNKNOWN') {
          bccCode = mappedCode;
        } else {
          Logger.warn(`Generator: Using default BCC code ${GeneratorAgent.DEFAULT_BCC_CODE} for unknown period: ${installmentPeriod}`);
        }
      } else {
        Logger.info(`Generator: No installment period provided, using default BCC code: ${GeneratorAgent.DEFAULT_BCC_CODE}`);
      }

      const protocolString = this.buildProtocolString(amount, bccCode);
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

  async generateQRToFile(amount: number, orderId: string, installmentPeriod?: string): Promise<string> {
    const path = require('path');
    const fs = require('fs');

    const buffer = await this.generateQR(amount, installmentPeriod);
    const filePath = path.join(process.cwd(), 'storage', `qr_${orderId}.png`);

    fs.writeFileSync(filePath, buffer);
    Logger.info(`Generator: QR saved to ${filePath}`);

    return filePath;
  }
}
