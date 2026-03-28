import { Logger } from './Logger';

/**
 * Mapping of installment periods (in months) to 1C codes
 */
export const INSTALLMENT_MAP: Record<string, string> = {
  "3": "KZ281",
  "6": "KZ282",
  "12": "KZ283",
  "18": "KZ284",
  "24": "KZ285" // Reserve for future
};

/**
 * Extracts BCC code from parsed installment period text
 * @param parsedText - Text containing installment period (e.g., "12 месяцев", "12 мес.", "12")
 * @returns Corresponding BCC code or "UNKNOWN" if not found
 */
export function getBccCode(parsedText: string): string {
  // Clean the string - extract only digits
  const digitsOnly = parsedText.replace(/\D/g, '');
  
  if (!digitsOnly) {
    Logger.warn(`InstallmentMapper: No digits found in text: "${parsedText}"`);
    return 'UNKNOWN';
  }

  // Look up the code in the map
  const bccCode = INSTALLMENT_MAP[digitsOnly];
  
  if (!bccCode) {
    Logger.warn(`InstallmentMapper: No mapping found for period: ${digitsOnly} months`);
    return 'UNKNOWN';
  }

  Logger.info(`[LOG] Срок: ${parsedText} -> Код 1С: ${bccCode}`);
  return bccCode;
}

/**
 * Validates if a BCC code is known
 * @param code - BCC code to validate
 * @returns true if code is in the mapping
 */
export function isValidBccCode(code: string): boolean {
  return Object.values(INSTALLMENT_MAP).includes(code);
}
