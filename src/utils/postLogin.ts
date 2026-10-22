/**
 * What to do when the cashier table did not appear right after the login form was submitted.
 * ACCESS_DENIED is a bank UI glitch ("Доступ ограничен"), not a real block: reload, do not wait out
 * the table timeout and do not kill the process.
 */
export type CashierPage = 'LOGGED_IN' | 'LOGIN_FORM' | 'SKELETON' | 'ACCESS_DENIED' | 'UNKNOWN';

export type AfterSubmit = 'done' | 'recover_access_denied' | 'keep_waiting';

export function afterCredentialsSubmitted(state: CashierPage): AfterSubmit {
  if (state === 'LOGGED_IN') return 'done';
  if (state === 'ACCESS_DENIED') return 'recover_access_denied';
  return 'keep_waiting';
}
