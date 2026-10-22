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

export type DeniedRecovery = 'done' | 'submit_login' | 'wait_for_table' | 'still_denied';

/** After a reload of the "Доступ ограничен" glitch. A loading cabinet is not a login form. */
export function afterAccessDeniedReload(state: CashierPage): DeniedRecovery {
  if (state === 'LOGGED_IN') return 'done';
  if (state === 'LOGIN_FORM') return 'submit_login';
  if (state === 'ACCESS_DENIED') return 'still_denied';
  return 'wait_for_table';
}
