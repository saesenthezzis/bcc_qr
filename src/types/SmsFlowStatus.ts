export enum SmsFlowStatus {
  SUCCESS = 'SUCCESS',
  CANCELLED = 'CANCELLED',
  TIMEOUT = 'TIMEOUT',
  /** Nobody answered the "send SMS?" question in time. */
  NO_ANSWER = 'NO_ANSWER',
  /** Too many wrong codes or the bank blocked the input; the chat already got the stop message with the button. */
  STOPPED = 'STOPPED',
  /** The code could not be entered/checked on the page — the bank table decides whether to send the QR. */
  NEEDS_BANK_CHECK = 'NEEDS_BANK_CHECK',
}