import assert from 'node:assert/strict';
import { ScreenshotEpisodes, ScreenshotEpisodeStore, ScreenshotReason } from './routineScreenshots';
import { SurveillanceAgent } from '../agents/Surveillance';
import { DispatcherAgent } from '../agents/Dispatcher';
import { RegistryAgent } from '../agents/Registry';
import { Logger } from './Logger';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as Logger;
class Store implements ScreenshotEpisodeStore {
  rows = new Set<string>();
  writes = 0;
  available = true;
  async claimScreenshotEpisode(id: string): Promise<boolean> {
    this.writes++;
    if (!this.available || this.rows.has(id)) return false;
    this.rows.add(id);
    return true;
  }
  async resetScreenshotEpisode(id: string): Promise<boolean> {
    if (!this.available) return false;
    this.rows.delete(id);
    return true;
  }
}

async function episodes(): Promise<void> {
  const store = new Store();
  let gate = new ScreenshotEpisodes(store);
  let sent = 0;
  const send = async () => { sent++; };
  await gate.attempt('critical_failure', 'bank', send);
  assert.equal(sent, 0);
  for (let i = 0; i < 6000; i++) await gate.attempt('authorization_required', 'bank', send);
  assert.equal(sent, 1);
  assert.equal(store.writes, 1);
  gate = new ScreenshotEpisodes(store); // A fresh process sees the same durable claim.
  await gate.attempt('authorization_required', 'bank', send);
  assert.equal(sent, 1);
  await gate.recover('authorization_required', 'bank');
  await Promise.all(Array.from({length: 20}, () => gate.attempt('authorization_required', 'bank', send)));
  assert.equal(sent, 2);
  await gate.attempt('sms_button_missing', 'A:100', send);
  await gate.recover('sms_button_missing', 'B:100'); // A different order is not recovery of A.
  await gate.attempt('sms_button_missing', 'A:100', send);
  assert.equal(sent, 3);
  await gate.recover('sms_button_missing', 'A:100');
  await gate.attempt('sms_button_missing', 'A:100', send);
  assert.equal(sent, 4);
  let attempts = 0;
  const fail = async () => { attempts++; throw new Error('uncertain photo delivery'); };
  await assert.rejects(gate.attempt('authorization_required', 'failed', fail));
  await gate.attempt('authorization_required', 'failed', fail);
  await new ScreenshotEpisodes(store).attempt('authorization_required', 'failed', fail);
  assert.equal(attempts, 1, 'No retries after capture/delivery failure or restart');
  store.available = false;
  await gate.recover('authorization_required', 'failed');
  await gate.attempt('authorization_required', 'failed', fail);
  await gate.attempt('sms_button_missing', 'unavailable', send);
  assert.equal(attempts, 1);
  assert.equal(sent, 4, 'Unavailable persistence suppresses photos');
  const concurrentStore = new Store();
  const concurrent = new ScreenshotEpisodes(concurrentStore);
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const first = concurrent.attempt('authorization_required', 'inflight', async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await began;
  const recovery = concurrent.recover('authorization_required', 'inflight');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(concurrentStore.rows.size, 1, 'Recovery must wait for an in-flight attempt');
  release();
  await Promise.all([first, recovery]);
  assert.equal(concurrentStore.rows.size, 0);
}

async function capturePaths(): Promise<void> {
  const store = new Store();
  const agent = new SurveillanceAgent('https://offline.invalid', '', '', logger, store as unknown as RegistryAgent);
  let captures = 0;
  const deliveries: ScreenshotReason[] = [];
  let loginForm = false;
  let smsButton = false;
  const page = {
    async screenshot() { captures++; return Buffer.from('offline fixture'); },
    locator() { return {}; },
    async goto() {}, async waitForTimeout() {}, async waitForSelector() {},
    keyboard: { async press() {} },
    async isVisible(selector: string) { return selector === 'input#username' ? loginForm : !loginForm; },
    async textContent() { return 'offline'; },
    async $() { return smsButton ? { async isVisible() { return true; } } : null; },
    async $$() { return []; },
  };
  const access = agent as unknown as Record<string, unknown>;
  access.page = page;
  access.isBrowserInitialized = true;
  access.waitForPageReady = async () => {};
  access.ensureCorrectUrl = async () => {};
  access.performLogin = async () => {};
  access.saveSession = async () => {};
  access.hardRefreshIfNeeded = async () => {};
  access.dismissLeftoverModal = async () => {};
  agent.setScreenshotSender(async reason => { deliveries.push(reason); });
  const oldMock = process.env.BROWSER_MOCK;
  const oldFlag = process.env.ROUTINE_DEBUG_SCREENSHOTS;
  delete process.env.BROWSER_MOCK;
  process.env.ROUTINE_DEBUG_SCREENSHOTS = 'true'; // The obsolete flag cannot broaden permissions.
  try {
    for (let i = 0; i < 5; i++) await agent.runRotation();
    for (const label of ['login_restored','soft_refresh_done','table_ready','browser_initialized',
      'login_performed','access_denied','unknown_page','hard_refresh_done','success_modal_closed',
      'success_modal_stuck','sidebar_A','debug']) assert.equal(await agent.takeDebugScreenshot(label), null);
    assert.equal(await agent.takeErrorScreenshot(), null);
    assert.equal(await agent.takeSmsScreenshot('A', 'input'), null);
    assert.equal(await agent.takeSmsScreenshot('A', 'blocked'), null);
    assert.equal(captures, 0);
    loginForm = true;
    for (let i = 0; i < 5; i++) await agent.login();
    assert.deepEqual(deliveries, ['authorization_required']);
    loginForm = false;
    await agent.login();
    loginForm = true;
    await agent.login();
    assert.equal(captures, 2);
    loginForm = false;
    for (let i = 0; i < 5; i++) assert.equal(await agent.checkSmsButtonExists('A', 100), false);
    assert.deepEqual(deliveries, ['authorization_required','authorization_required','sms_button_missing']);
    smsButton = true;
    assert.equal(await agent.checkSmsButtonExists('A', 100), true);
    smsButton = false;
    assert.equal(await agent.checkSmsButtonExists('A', 100), false);
    assert.equal(captures, 4);
    await agent.checkSmsButtonExists('A', 100);
    assert.equal(captures, 4);
    // A browser-restart/new agent with the same durable store must not create a new episode.
    const restarted = new SurveillanceAgent('https://offline.invalid', '', '', logger, store as unknown as RegistryAgent);
    (restarted as unknown as {page: unknown}).page = page;
    restarted.setScreenshotSender(async reason => { deliveries.push(reason); });
    await restarted.checkSmsButtonExists('A', 100);
    assert.equal(captures, 4);
  } finally {
    if (oldMock === undefined) delete process.env.BROWSER_MOCK; else process.env.BROWSER_MOCK = oldMock;
    if (oldFlag === undefined) delete process.env.ROUTINE_DEBUG_SCREENSHOTS; else process.env.ROUTINE_DEBUG_SCREENSHOTS = oldFlag;
  }
}

async function deliveryPaths(): Promise<void> {
  const dispatcher = new DispatcherAgent('123:offline', ['1'], logger);
  (dispatcher as unknown as {adminChatId: number}).adminChatId = 2;
  let photos = 0, texts = 0, textEdits = 0;
  (dispatcher as unknown as {bot: unknown}).bot = { telegram: {
    async sendPhoto() { photos++; return {message_id: photos}; },
    async sendMessage() { texts++; return {message_id: texts}; },
    async editMessageText() { textEdits++; },
    async editMessageCaption() { throw new Error('Code requests must be text'); },
  }};
  const buffer = Buffer.from('offline');
  await dispatcher.sendErrorMessage(new Error('offline failure'), buffer);
  await dispatcher.sendToAdminChat(buffer, 'debug', 'debug.png');
  await dispatcher.sendSmsRequest(buffer, 'offline');
  assert.equal(await dispatcher.sendSmsCodeRequest('A', buffer, 'enter code'), true);
  await dispatcher.updateCountdownMessage('A', 'checking code');
  assert.equal(photos, 0);
  assert.equal(texts, 3);
  assert.equal(textEdits, 1);
  await dispatcher.sendAllowedScreenshot('critical_failure' as ScreenshotReason, buffer);
  assert.equal(photos, 0);
  await dispatcher.sendAllowedScreenshot('authorization_required', buffer);
  await dispatcher.sendAllowedScreenshot('sms_button_missing', buffer);
  assert.equal(photos, 2);
  await dispatcher.sendQRCode(buffer, 'A', 100);
  assert.equal(photos, 3, 'Functional QR delivery must remain enabled');
}

async function main(): Promise<void> {
  await episodes();
  await capturePaths();
  await deliveryPaths();
  process.stdout.write('routineScreenshots.check: PASS (two reasons, 6000 repeats, recovery, restart, failures, text SMS, QR)\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
