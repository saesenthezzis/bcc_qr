import assert from 'assert';
import { afterAccessDeniedReload, afterCredentialsSubmitted } from './postLogin';

assert.strictEqual(afterCredentialsSubmitted('LOGGED_IN'), 'done');
assert.strictEqual(afterCredentialsSubmitted('ACCESS_DENIED'), 'recover_access_denied');
assert.strictEqual(afterCredentialsSubmitted('SKELETON'), 'keep_waiting');
assert.strictEqual(afterCredentialsSubmitted('LOGIN_FORM'), 'keep_waiting');
assert.strictEqual(afterCredentialsSubmitted('UNKNOWN'), 'keep_waiting');
assert.strictEqual(afterAccessDeniedReload('LOGGED_IN'), 'done');
assert.strictEqual(afterAccessDeniedReload('LOGIN_FORM'), 'submit_login');
assert.strictEqual(afterAccessDeniedReload('SKELETON'), 'wait_for_table');
assert.strictEqual(afterAccessDeniedReload('UNKNOWN'), 'wait_for_table');
assert.strictEqual(afterAccessDeniedReload('ACCESS_DENIED'), 'still_denied');
console.log('postLogin: all checks passed');
