/**
 * How many times the bot asked the staff "send SMS?" for one order, kept in memory by (ИИН, amount).
 *
 * The DB row cannot be trusted for this: external_id is a masked ИИН, so an old order of another
 * client with the same last 4 digits (different amount) absorbs the counter and the limit never fires.
 * After a restart the counter starts again — at most `maxAsks` extra questions per order.
 */

/** How one SMS flow ended, from the point of view of "should we ask again?". */
export type FlowEnd = 'CONFIRMED' | 'DECLINED' | 'STOPPED' | 'NO_ANSWER';

/** NO = leave the order alone, ASK = regular "send SMS?" question, RESUME = staff pressed the button, send the SMS at once. */
export type StartDecision = 'NO' | 'ASK' | 'RESUME';

interface Entry {
  asks: number;
  parked: boolean;
  resume: boolean;
}

export class SmsAskTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxAsks: number) {}

  private key(orderId: string, amount: number): string {
    return `${orderId}|${amount}`;
  }

  private entry(orderId: string, amount: number): Entry {
    const k = this.key(orderId, amount);
    let e = this.entries.get(k);
    if (!e) {
      e = { asks: 0, parked: false, resume: false };
      this.entries.set(k, e);
    }
    return e;
  }

  canStart(orderId: string, amount: number): StartDecision {
    const e = this.entries.get(this.key(orderId, amount));
    if (!e) return 'ASK';
    if (e.resume) return 'RESUME';
    return e.parked ? 'NO' : 'ASK';
  }

  /** Records the end of a flow. Returns true when the order is parked now and the staff must get the "send again" button. */
  finish(orderId: string, amount: number, end: FlowEnd): boolean {
    const e = this.entry(orderId, amount);
    e.resume = false;
    if (end === 'CONFIRMED') {
      e.parked = true; // the code went through: the bank table and the QR path take it from here
      return false;
    }
    if (end === 'NO_ANSWER') {
      e.asks++;
      if (e.asks < this.maxAsks) return false;
    }
    e.parked = true;
    return true;
  }

  /** Staff pressed "send SMS again": the next cycle sends the SMS without asking first. */
  resume(orderId: string, amount: number): void {
    const e = this.entry(orderId, amount);
    e.parked = false;
    e.resume = true;
    e.asks = 0;
  }
}
