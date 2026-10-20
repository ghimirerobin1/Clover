import type { CreateItemRequest, CreateItemResult } from '../../api/schemas';
import type { SqlDb } from '../../db/driver';
import { ItemRepo } from '../../db/items';
import { SettingsRepo } from '../../db/settings';
import { ApiError } from '../../lib/errors';
import { Money } from '../../lib/money';

export const MAX_PRICE_CENTS = 100_000_000;
export const MAX_INITIAL_STOCK = 1_000_000;

export interface CreateDraft {
  name: string;
  priceCents: number;
  code: string;
  sku: string;
  categoryId: string | null;
  /** Free text from the field; empty = don't set stock. */
  initialStock: string;
}

export type DraftErrors = Partial<Record<'name' | 'priceCents' | 'code' | 'sku' | 'initialStock', string>>;

export interface CreateApi {
  createItem(body: CreateItemRequest): Promise<CreateItemResult>;
}

export type CreateOutcome =
  | { kind: 'created'; itemId: string; warnings: string[]; replayed: boolean }
  | { kind: 'unknown'; message: string }
  | { kind: 'failed'; message: string; forbidden: boolean };

/**
 * Create item is off unless BOTH the local Settings toggle (behind a confirmation) is on AND the device key
 * carries canCreateItems (spec §4.6). The server enforces the key flag again.
 */
export class CreateGate {
  static allowed(s: { enabled: boolean; deviceCanCreate: boolean }): boolean {
    return s.enabled && s.deviceCanCreate;
  }

  static async load(db: SqlDb): Promise<{ enabled: boolean; deviceCanCreate: boolean; allowed: boolean }> {
    const enabled = await SettingsRepo.flag(db, 'create_items_enabled', false);
    const deviceCanCreate = await SettingsRepo.flag(db, 'device_can_create', false);
    return { enabled, deviceCanCreate, allowed: CreateGate.allowed({ enabled, deviceCanCreate }) };
  }
}

export class CreateItemForm {
  static empty(code = ''): CreateDraft {
    return { name: '', priceCents: 0, code: code.trim(), sku: '', categoryId: null, initialStock: '' };
  }

  static validate(d: CreateDraft): DraftErrors {
    const e: DraftErrors = {};
    const name = d.name.trim();
    if (!name) e.name = 'Name is required';
    else if (name.length > 127) e.name = 'Name is too long (max 127)';
    if (!Number.isSafeInteger(d.priceCents) || d.priceCents < 0) e.priceCents = 'Price must be whole cents';
    else if (d.priceCents > MAX_PRICE_CENTS) e.priceCents = 'Price is too high';
    if (d.code.trim().length > 64) e.code = 'UPC is too long';
    if (d.code.trim() && !/^[0-9A-Za-z-]+$/.test(d.code.trim())) e.code = 'UPC may only contain letters, digits and -';
    if (d.sku.trim().length > 64) e.sku = 'SKU is too long';
    const stock = d.initialStock.trim();
    if (stock) {
      if (!/^\d+$/.test(stock)) e.initialStock = 'Whole units only';
      else if (Number(stock) > MAX_INITIAL_STOCK) e.initialStock = 'Too many';
    }
    return e;
  }

  static isValid(d: CreateDraft): boolean {
    return Object.keys(CreateItemForm.validate(d)).length === 0;
  }

  static toRequest(d: CreateDraft, clientMutationId: string): CreateItemRequest {
    const stock = d.initialStock.trim();
    return {
      name: d.name.trim(),
      priceCents: d.priceCents,
      ...(d.code.trim() ? { code: d.code.trim() } : {}),
      ...(d.sku.trim() ? { sku: d.sku.trim() } : {}),
      ...(d.categoryId ? { categoryId: d.categoryId } : {}),
      ...(stock ? { initialStock: Number(stock) } : {}),
      clientMutationId,
    };
  }

  /** Confirmation summary lines shown before the write. */
  static summary(d: CreateDraft, categoryName: string | null): string[] {
    const stock = d.initialStock.trim();
    return [
      `Name: ${d.name.trim()}`,
      `Price: ${Money.format(d.priceCents)}`,
      `UPC: ${d.code.trim() || '—'}`,
      `SKU: ${d.sku.trim() || '—'}`,
      `Category: ${categoryName ?? '—'}`,
      `Initial stock: ${stock || 'not set'}`,
    ];
  }
}

export class CreateItemWriter {
  /** ONE attempt from the confirmation tap. Never retried; an unknown outcome is reported, not re-sent. */
  static async submit(db: SqlDb, api: CreateApi, req: CreateItemRequest, now = Date.now()): Promise<CreateOutcome> {
    if (!CreateGate.allowed(await CreateGate.load(db))) {
      return { kind: 'failed', message: 'Creating items is turned off on this device', forbidden: true };
    }
    let res: CreateItemResult;
    try {
      res = await api.createItem(req);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'UPSTREAM' || e.code === 'CONFLICT')) {
        return { kind: 'unknown', message: e.message };
      }
      if (e instanceof ApiError) {
        if (e.code === 'AUTH' && e.status === 403) await SettingsRepo.set(db, 'device_can_create', '0');
        return { kind: 'failed', message: e.message, forbidden: e.code === 'AUTH' };
      }
      return { kind: 'unknown', message: e instanceof Error ? e.message : 'Unknown error' };
    }
    await ItemRepo.upsertItems(db, [res.item], now);
    return { kind: 'created', itemId: res.item.id, warnings: res.warnings, replayed: res.replayed };
  }
}
