/**
 * Очищает строку суммы от валютных символов и всех видов пробелов
 * Примеры:
 * - "852 937.00 KZT" -> 852937.00
 * - "852 937,00 ₸" -> 852937.00
 * - "852\u00A0937.00\u00A0₸" -> 852937.00 (с неразрывными пробелами)
 */
export function sanitizeAmount(amount: string): number {
  if (!amount || typeof amount !== 'string') {
    throw new Error(`Invalid amount input: ${amount}`);
  }

  // Удаляем все виды пробелов (обычные, неразрывные, тонкие и т.д.)
  let cleaned = amount
    .replace(/\u00A0/g, '')  // неразрывный пробел (&nbsp;)
    .replace(/\u202F/g, '')  // узкий неразрывный пробел
    .replace(/\u2009/g, '')  // тонкий пробел
    .replace(/\s/g, '')       // обычные пробелы
    .replace(/₸/g, '')        // символ тенге
    .replace(/KZT/gi, '')     // аббревиатура KZT
    .replace(/тг/gi, '')      // аббревиатура тг
    .replace(/тенге/gi, '')   // слово тенге
    .trim();
  
  // Нормализуем десятичный разделитель (заменяем запятую на точку)
  cleaned = cleaned.replace(',', '.');
  
  // Удаляем все символы кроме цифр и точки
  cleaned = cleaned.replace(/[^\d.]/g, '');
  
  const parsed = parseFloat(cleaned);
  
  if (isNaN(parsed)) {
    throw new Error(`Invalid amount format: ${amount}`);
  }
  
  return parsed;
}
