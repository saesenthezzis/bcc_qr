/**
 * Texts the bot shows to store staff in Telegram. Plain words, one idea per message:
 * people read them at the till, not a log.
 */

const formatAmount = (amount?: number): string =>
  amount !== undefined ? `${amount.toFixed(2)} тг` : '—';

export const formatTimeLeft = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${(safe % 60).toString().padStart(2, '0')}`;
};

export const BotText = {
  needsConfirmation: (orderId: string, amount: number): string =>
    `⚠️ Новая заявка ${orderId}\nСумма: ${formatAmount(amount)}\n\nЕё нужно подтвердить. QR придёт сюда сам.\nКабинет: https://online.bcc.kz/cashier-cabinet`,
  qrCaption: (orderId: string, amount: number): string =>
    `🧾 QR для оплаты\nЗаявка ${orderId}\nСумма: ${formatAmount(amount)}`,

  // Step 1: send SMS to the client?
  askSendSms: (orderId: string, amount: number, timeLeft?: string): string =>
    `📱 Заявка ${orderId}\nСумма: ${formatAmount(amount)}\n\nОтправить клиенту SMS с кодом?` +
    (timeLeft ? `\n\n⏱ Осталось ${timeLeft}` : ''),
  sendSmsButton: '✅ Отправить SMS',
  skipSmsButton: '↩️ Не отправлять',
  sendingSms: (orderId: string): string => `📤 Отправляю SMS клиенту\nЗаявка ${orderId}`,
  smsSkipped: (orderId: string, username: string): string =>
    `↩️ SMS не отправлено (${username})\nЗаявку ${orderId} можно подтвердить в кабинете.`,
  decisionExpired: '⏱ Время вышло, SMS не отправлено',

  // Step 2: the code
  waitingCode: (orderId: string, amount?: number, timeLeft?: string): string =>
    `📲 Жду код из SMS\nЗаявка ${orderId}\nСумма: ${formatAmount(amount)}\n\nОтветьте на это сообщение кодом.` +
    (timeLeft ? `\n⏱ Осталось ${timeLeft}` : ''),
  wrongCode: (orderId: string, attempt: number, maxAttempts: number, timeLeft?: string): string =>
    `❌ Код неправильный\nЗаявка ${orderId}\n\nПришлите код ещё раз (попытка ${attempt} из ${maxAttempts}).` +
    (timeLeft ? `\n⏱ Осталось ${timeLeft}` : ''),
  wrongCodeShort: (orderId: string): string => `❌ Код неправильный\nЗаявка ${orderId}`,
  checkingCode: (orderId: string, username: string): string =>
    `⏳ Проверяю код…\nЗаявка ${orderId}\nКод прислал ${username}`,
  codeTimedOut: (orderId: string): string => `⏱ Код не пришёл вовремя\nЗаявка ${orderId}`,
  useReplyHint: 'ℹ️ Лучше отвечайте кнопкой «Ответить» на сообщение с запросом кода.',
  badCodeFormat: '❌ Пришлите только цифры кода.',
  codeNotExpected: (orderId: string): string => `⚠️ По заявке ${orderId} код сейчас не нужен.`,

  // Step 3: result
  codeAccepted: (orderId: string): string => `✅ Код принят. Заявка ${orderId}, готовлю QR.`,
  tooManyWrong: (orderId: string): string =>
    `🚫 Код неправильный, попытки закончились.\nПодтвердите заявку ${orderId} в кабинете вручную.\n\nЕсли уже подтвердил — нажми кнопку ниже:`,
  codeBlocked: (orderId: string): string =>
    `🚫 Банк заблокировал ввод кода по заявке ${orderId}.\nПодтвердите её в кабинете или позвоните в поддержку: 605.`,
  codeNotEntered: (orderId: string): string =>
    `⚠️ Не получилось ввести код по заявке ${orderId}. Проверяю статус в банке…`,
  bankNotConfirmedYet: (orderId: string): string =>
    `⏳ Банк ещё не подтвердил заявку ${orderId}.\nQR придёт, когда статус станет «Подтверждено».`,
  requestLimit: (orderId: string, count: number): string =>
    `⚠️ По заявке ${orderId} спрашивал про SMS ${count} раз без результата. Больше не спрашиваю, подтвердите в кабинете.`,
};
