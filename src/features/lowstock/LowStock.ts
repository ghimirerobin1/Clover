import type { ItemRow } from '../../db/items';

export const UNCATEGORIZED = 'Uncategorized';

export type LowStockEntry =
  | { kind: 'header'; key: string; title: string; count: number }
  | { kind: 'item'; key: string; item: ItemRow };

/** Groups low-stock rows by category for a single FlashList (headers interleaved, sticky). */
export class LowStock {
  static group(rows: readonly ItemRow[]): LowStockEntry[] {
    const groups = new Map<string, ItemRow[]>();
    for (const r of rows) {
      const title = r.category_name ?? UNCATEGORIZED;
      const list = groups.get(title) ?? [];
      list.push(r);
      groups.set(title, list);
    }
    const titles = [...groups.keys()].sort((a, b) =>
      a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    const out: LowStockEntry[] = [];
    for (const title of titles) {
      const items = (groups.get(title) ?? []).slice().sort((a, b) => (a.stock_qty ?? 0) - (b.stock_qty ?? 0) || a.name.localeCompare(b.name));
      out.push({ kind: 'header', key: `h:${title}`, title, count: items.length });
      for (const item of items) out.push({ kind: 'item', key: item.id, item });
    }
    return out;
  }

  static stickyIndices(entries: readonly LowStockEntry[]): number[] {
    return entries.flatMap((e, i) => (e.kind === 'header' ? [i] : []));
  }

  /** Tab badge text: hidden at 0, capped for space. */
  static badge(count: number): string | undefined {
    if (count <= 0) return undefined;
    return count > 99 ? '99+' : String(count);
  }
}
