export function sanitizeAmount(amount: string): number {
  if (!amount || typeof amount !== 'string') {
    throw new Error(`Invalid amount input: ${amount}`);
  }

  let cleaned = amount
    .replace(/\u00A0/g, '')
    .replace(/\u202F/g, '')
    .replace(/\u2009/g, '')
    .replace(/\s/g, '')
    .replace(/₸/g, '')
    .replace(/KZT/gi, '')
    .replace(/тг/gi, '')
    .replace(/тенге/gi, '')
    .trim();

  cleaned = cleaned.replace(',', '.');
  cleaned = cleaned.replace(/[^\d.]/g, '');

  const parsed = parseFloat(cleaned);

  if (isNaN(parsed)) {
    throw new Error(`Invalid amount format: ${amount}`);
  }

  return parsed;
}
