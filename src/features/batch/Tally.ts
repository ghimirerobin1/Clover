import { create } from 'zustand';

export interface TallyRow {
  itemId: string;
  itemName: string;
  count: number;
}

/** Running tally for continuous (counting) scan mode (spec §4.3). Pure functions over an immutable list. */
export class Tally {
  /** Same item again increments; a new item goes to the top. */
  static add(rows: readonly TallyRow[], item: { id: string; name: string }, by = 1): TallyRow[] {
    const i = rows.findIndex((r) => r.itemId === item.id);
    if (i < 0) return [{ itemId: item.id, itemName: item.name, count: by }, ...rows];
    return rows.map((r, j) => (j === i ? { ...r, count: r.count + by } : r));
  }

  /** −1; drops the row at zero. */
  static decrement(rows: readonly TallyRow[], itemId: string): TallyRow[] {
    return rows.flatMap((r) => (r.itemId !== itemId ? [r] : r.count > 1 ? [{ ...r, count: r.count - 1 }] : []));
  }

  static remove(rows: readonly TallyRow[], itemId: string): TallyRow[] {
    return rows.filter((r) => r.itemId !== itemId);
  }

  static total(rows: readonly TallyRow[]): number {
    return rows.reduce((n, r) => n + r.count, 0);
  }

  static label(r: TallyRow): string {
    return `${r.itemName} ×${r.count}`;
  }
}

interface TallyState {
  rows: TallyRow[];
}

export const useTallyStore = create<TallyState>(() => ({ rows: [] }));

export class TallyController {
  static add(item: { id: string; name: string }): TallyRow[] {
    const rows = Tally.add(useTallyStore.getState().rows, item);
    useTallyStore.setState({ rows });
    return rows;
  }

  static decrement(itemId: string): void {
    useTallyStore.setState((s) => ({ rows: Tally.decrement(s.rows, itemId) }));
  }

  static remove(itemId: string): void {
    useTallyStore.setState((s) => ({ rows: Tally.remove(s.rows, itemId) }));
  }

  static clear(): void {
    useTallyStore.setState({ rows: [] });
  }
}
