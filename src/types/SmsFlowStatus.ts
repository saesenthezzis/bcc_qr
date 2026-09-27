export enum SmsFlowStatus {
  SUCCESS = 'SUCCESS',
  CANCELLED = 'CANCELLED',
  TIMEOUT = 'TIMEOUT',
  /** The code could not be entered/checked on the page — the bank table decides whether to send the QR. */
  NEEDS_BANK_CHECK = 'NEEDS_BANK_CHECK',
}