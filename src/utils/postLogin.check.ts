import assert from 'assert';
import { afterCredentialsSubmitted } from './postLogin';

assert.strictEqual(afterCredentialsSubmitted('LOGGED_IN'), 'done');
assert.strictEqual(afterCredentialsSubmitted('ACCESS_DENIED'), 'recover_access_denied');
assert.strictEqual(afterCredentialsSubmitted('SKELETON'), 'keep_waiting');
assert.strictEqual(afterCredentialsSubmitted('LOGIN_FORM'), 'keep_waiting');
assert.strictEqual(afterCredentialsSubmitted('UNKNOWN'), 'keep_waiting');
console.log('postLogin: all checks passed');
