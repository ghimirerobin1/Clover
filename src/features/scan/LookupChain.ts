import type { LookupResult, RemoteItem } from '../../api/schemas';
import type { SqlDb } from '../../db/driver';
import { ItemRepo, type ItemRow } from '../../db/items';
import { Barcode, type NormalizedBarcode, type ScannerType, type VariableWeightRule } from '../../lib/barcode';
import { ApiError } from '../../lib/errors';

export type LookupSource = 'code' | 'sku' | 'alias' | 'remote';

export type LookupOutcome =
  | { kind: 'found'; item: ItemRow; source: LookupSource; barcode: NormalizedBarcode }
  | { kind: 'ambiguous'; candidates: ItemRow[]; source: LookupSource; barcode: NormalizedBarcode }
  | { kind: 'not_found'; barcode: NormalizedBarcode; remoteError: ApiError | null };

export interface RemoteLookup {
  lookup(code: string): Promise<LookupResult>;
}

/**
 * Lookup chain (spec §4.3): local SQLite `code` → `sku` → `barcode_aliases` → proxy lookup → not found.
 * Remote hits are written into SQLite so the next scan is instant and offline-capable.
 */
export class LookupChain {
  static async resolve(
    db: SqlDb,
    remote: RemoteLookup,
    raw: string,
    opts: { type?: ScannerType; rule: VariableWeightRule; globalThreshold: number; now?: number },
  ): Promise<LookupOutcome> {
    const barcode = Barcode.normalize(raw, { type: opts.type, rule: opts.rule });
    const t = opts.globalThreshold;
    if (barcode.candidates.length === 0) return { kind: 'not_found', barcode, remoteError: null };

    const local: [LookupSource, () => Promise<ItemRow[]>][] = [
      ['code', () => ItemRepo.findByCodes(db, barcode.candidates, t)],
      ['sku', () => ItemRepo.findBySku(db, barcode.cleaned, t)],
      ['alias', () => ItemRepo.findByAliases(db, barcode.candidates, t)],
    ];
    for (const [source, find] of local) {
      const rows = await find();
      const outcome = LookupChain.outcome(rows, source, barcode);
      if (outcome) return outcome;
    }

    let result: LookupResult;
    try {
      // The proxy gets the most canonical form; it handles UPC-A/EAN-13 variants itself.
      result = await remote.lookup(barcode.variableWeight?.itemCode ?? barcode.gtin ?? barcode.cleaned);
    } catch (e) {
      return { kind: 'not_found', barcode, remoteError: e instanceof ApiError ? e : new ApiError('UPSTREAM', String(e), true) };
    }
    const hits: RemoteItem[] = result.match ? [result.match] : result.candidates;
    if (hits.length === 0) return { kind: 'not_found', barcode, remoteError: null };
    await ItemRepo.upsertItems(db, hits, opts.now ?? Date.now());
    const rows = (await Promise.all(hits.map((h) => ItemRepo.byId(db, h.id, t)))).filter((r): r is ItemRow => r != null);
    return LookupChain.outcome(rows, 'remote', barcode) ?? { kind: 'not_found', barcode, remoteError: null };
  }

  private static outcome(rows: ItemRow[], source: LookupSource, barcode: NormalizedBarcode): LookupOutcome | null {
    if (rows.length === 1) return { kind: 'found', item: rows[0] as ItemRow, source, barcode };
    if (rows.length > 1) return { kind: 'ambiguous', candidates: rows, source, barcode };
    return null;
  }
}

/** Ignores repeat reads of the same code within a window (spec: 1.2 s). */
export class ScanDebouncer {
  static readonly WINDOW_MS = 1200;
  private last: { code: string; at: number } | null = null;

  accept(code: string, now = Date.now()): boolean {
    if (this.last && this.last.code === code && now - this.last.at < ScanDebouncer.WINDOW_MS) {
      this.last = { code, at: now };
      return false;
    }
    this.last = { code, at: now };
    return true;
  }
}
