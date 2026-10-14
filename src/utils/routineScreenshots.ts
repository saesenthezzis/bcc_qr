import { createHash } from 'node:crypto';

export type ScreenshotReason = 'authorization_required' | 'sms_button_missing';
export function isScreenshotReason(value: unknown): value is ScreenshotReason {
  return value === 'authorization_required' || value === 'sms_button_missing';
}
export interface ScreenshotEpisodeStore {
  claimScreenshotEpisode(id: string): Promise<boolean>;
  resetScreenshotEpisode(id: string): Promise<boolean>;
}

// Durable unique claims precede capture. Failures consume the episode, never retry photos.
export class ScreenshotEpisodes {
  private attempted = new Set<string>();
  private recovered = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  constructor(private store: ScreenshotEpisodeStore) {}
  private id(reason: ScreenshotReason, scope: string): string {
    const hash = createHash('sha256').update(scope).digest('hex');
    return 'bcc_screenshot_' + reason + '_' + hash;
  }
  private async serialize(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(id, next);
    try { await next; }
    finally { if (this.pending.get(id) === next) this.pending.delete(id); }
  }
  async attempt(reason: unknown, scope: string, captureAndSend: () => Promise<void>): Promise<void> {
    if (!isScreenshotReason(reason)) return;
    const id = this.id(reason, scope);
    await this.serialize(id, async () => {
      if (this.attempted.has(id)) return;
      this.attempted.add(id);
      this.recovered.delete(id);
      if (!(await this.store.claimScreenshotEpisode(id))) return;
      await captureAndSend();
    });
  }
  async recover(reason: ScreenshotReason, scope: string): Promise<void> {
    const id = this.id(reason, scope);
    await this.serialize(id, async () => {
      if (this.recovered.has(id)) return;
      if (!(await this.store.resetScreenshotEpisode(id))) return;
      this.attempted.delete(id);
      this.recovered.add(id);
    });
  }
}
