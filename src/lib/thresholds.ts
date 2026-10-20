import type { BadgeTone } from '../components/Badge';

export type StockStatus = 'out' | 'low' | 'ok' | 'untracked';

export const DEFAULT_GLOBAL_THRESHOLD = 5;

/** Low-stock threshold resolution (spec §4.5): per-item → per-category → global default. */
export class Thresholds {
  static resolve(item: number | null | undefined, category: number | null | undefined, global: number): number {
    if (item != null) return item;
    if (category != null) return category;
    return global;
  }

  /** Red ≤ 0, amber ≤ threshold, green otherwise; null stock = not tracked in Clover. */
  static status(qty: number | null, threshold: number): StockStatus {
    if (qty == null) return 'untracked';
    if (qty <= 0) return 'out';
    if (qty <= threshold) return 'low';
    return 'ok';
  }

  static tone(status: StockStatus): BadgeTone {
    return ({ out: 'danger', low: 'warning', ok: 'success', untracked: 'neutral' } as const)[status];
  }
}
