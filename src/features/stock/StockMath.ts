import type { AdjustReason, StockAction } from '../../api/schemas';

/**
 * What the user asked for, independent of the base it was computed from:
 * - receive: add `amount` (≥ 0)
 * - adjust:  add signed `amount`
 * - count:   set to `amount` (absolute)
 * - undo:    add signed `amount` (= before − after of the change being undone)
 */
export interface StockIntent {
  action: StockAction;
  amount: number;
  reason?: AdjustReason;
  note?: string;
}

export const ACTION_LABEL: Record<StockAction, string> = {
  receive: 'Receive',
  count: 'Count',
  adjust: 'Adjust',
  undo: 'Undo',
};

export const REASON_LABEL: Record<AdjustReason, string> = {
  damaged: 'Damaged',
  expired: 'Expired',
  theft_loss: 'Theft/Loss',
  correction: 'Correction',
  other: 'Other',
};

export class StockMath {
  /** New absolute quantity for an intent applied on `base`. */
  static target(intent: StockIntent, base: number): number {
    return intent.action === 'count' ? intent.amount : base + intent.amount;
  }

  /**
   * 409 handling (spec §4.4 step 4): Receive/Adjust/Undo recompute from the new live base;
   * Count keeps the user's absolute number.
   */
  static rebase(intent: StockIntent, liveBase: number): { expected: number; target: number } {
    return { expected: liveBase, target: StockMath.target(intent, liveBase) };
  }

  /** Destructive styling when the result is lower than current, or zero/below. */
  static isDestructive(before: number, after: number): boolean {
    return after < before || after <= 0;
  }

  static signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0';
  }

  /** "Current 14 → New 38 (+24, Receive)". */
  static summary(intent: StockIntent, before: number): string {
    const after = StockMath.target(intent, before);
    return `Current ${before} → New ${after} (${StockMath.signed(after - before)}, ${ACTION_LABEL[intent.action]})`;
  }

  /** Human-readable reason the intent can't be applied on `base`, or null if OK. */
  static validate(intent: StockIntent, base: number): string | null {
    if (!Number.isInteger(intent.amount)) return 'Whole units only';
    if (intent.action === 'receive' && intent.amount <= 0) return 'Enter how many you received';
    if (intent.action === 'count' && intent.amount < 0) return 'Count cannot be negative';
    if (intent.action === 'adjust' && !intent.reason) return 'Pick a reason';
    if ((intent.action === 'adjust' || intent.action === 'undo') && intent.amount === 0) return 'No change';
    const after = StockMath.target(intent, base);
    if (after < 0) return `Would go below zero (${after})`;
    return null;
  }

  /** Undo is a new, confirmed write applying the inverse delta of the change. */
  static undoIntent(change: { before: number; after: number }): StockIntent {
    return { action: 'undo', amount: change.before - change.after };
  }
}
