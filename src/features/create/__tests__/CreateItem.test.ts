import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import type { CreateItemRequest, CreateItemResult } from '../../../api/schemas';
import { ItemRepo } from '../../../db/items';
import { SettingsRepo } from '../../../db/settings';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { ApiError } from '../../../lib/errors';
import { Money } from '../../../lib/money';
import { CreateGate, CreateItemForm, CreateItemWriter, type CreateApi, type CreateDraft } from '../CreateItem';

const draft = (over: Partial<CreateDraft> = {}): CreateDraft => ({
  name: 'Mango Lassi', priceCents: 349, code: '012345678905', sku: 'BEV-1', categoryId: 'CAT_BEV', initialStock: '12', ...over,
});

class FakeApi implements CreateApi {
  calls: CreateItemRequest[] = [];
  constructor(private readonly respond: (b: CreateItemRequest) => CreateItemResult | Error) {}
  async createItem(body: CreateItemRequest): Promise<CreateItemResult> {
    this.calls.push(body);
    const r = this.respond(body);
    if (r instanceof Error) throw r;
    return r;
  }
}

const ok = (b: CreateItemRequest): CreateItemResult => ({
  item: {
    id: 'NEW1', name: b.name, sku: b.sku ?? null, code: b.code ?? null, priceCents: b.priceCents, costCents: null,
    categoryId: b.categoryId ?? null, stockQty: b.initialStock ?? null, modifiedTime: 9, deleted: false,
  },
  warnings: [],
  auditId: 1,
  replayed: false,
});

describe('CreateGate', () => {
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])('enabled=%p deviceCanCreate=%p → %p', (enabled, deviceCanCreate, allowed) => {
    expect(CreateGate.allowed({ enabled, deviceCanCreate })).toBe(allowed);
  });

  it('is off by default', async () => {
    const db = await WasmSqlDb.migrated();
    expect(await CreateGate.load(db)).toEqual({ enabled: false, deviceCanCreate: false, allowed: false });
    db.close();
  });
});

describe('CreateItemForm', () => {
  it('prefills UPC from the scan', () => {
    expect(CreateItemForm.empty(' 012345678905 ')).toMatchObject({ code: '012345678905', name: '', priceCents: 0 });
  });

  it.each<[Partial<CreateDraft>, string, RegExp]>([
    [{ name: '  ' }, 'name', /required/],
    [{ name: 'x'.repeat(128) }, 'name', /too long/],
    [{ priceCents: 3.49 }, 'priceCents', /whole cents/],
    [{ priceCents: -1 }, 'priceCents', /whole cents/],
    [{ priceCents: 100_000_001 }, 'priceCents', /too high/],
    [{ code: '0123 4567' }, 'code', /only contain/],
    [{ sku: 'S'.repeat(65) }, 'sku', /too long/],
    [{ initialStock: '1.5' }, 'initialStock', /Whole units/],
    [{ initialStock: '-3' }, 'initialStock', /Whole units/],
    [{ initialStock: '1000001' }, 'initialStock', /Too many/],
  ])('%j → %s error', (over, field, msg) => {
    const e = CreateItemForm.validate(draft(over)) as Record<string, string>;
    expect(e[field]).toMatch(msg);
  });

  it('valid draft → request; blanks omitted; price free (0) allowed', () => {
    expect(CreateItemForm.validate(draft())).toEqual({});
    expect(CreateItemForm.toRequest(draft(), 'cmid-create-1')).toEqual({
      name: 'Mango Lassi', priceCents: 349, code: '012345678905', sku: 'BEV-1', categoryId: 'CAT_BEV', initialStock: 12, clientMutationId: 'cmid-create-1',
    });
    expect(CreateItemForm.toRequest(draft({ code: ' ', sku: '', categoryId: null, initialStock: '', priceCents: 0 }), 'id-12345')).toEqual({
      name: 'Mango Lassi', priceCents: 0, clientMutationId: 'id-12345',
    });
  });

  it('summary shows everything before the write', () => {
    expect(CreateItemForm.summary(draft({ initialStock: '' }), 'Beverages')).toEqual([
      'Name: Mango Lassi', 'Price: $3.49', 'UPC: 012345678905', 'SKU: BEV-1', 'Category: Beverages', 'Initial stock: not set',
    ]);
  });
});

describe('Money.fromDigits (cents mask)', () => {
  it.each([
    ['', 0], ['3', 3], ['349', 349], ['$3.49', 349], ['$0.034', 34], ['0003', 3], ['12a3', 123], ['99999999999', 100_000_000],
  ])('%p → %d', (t, c) => expect(Money.fromDigits(t)).toBe(c));
  it('round-trips through format while typing', () => {
    let cents = 0;
    for (const ch of '1299') cents = Money.fromDigits(Money.format(cents) + ch);
    expect(Money.format(cents)).toBe('$12.99');
    expect(Money.fromDigits(Money.format(cents).slice(0, -1))).toBe(129); // backspace
  });
});

describe('CreateItemWriter', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
  });
  afterEach(() => db.close());
  const enable = async () => {
    await SettingsRepo.set(db, 'create_items_enabled', '1');
    await SettingsRepo.set(db, 'device_can_create', '1');
  };

  it('gate off → no request at all', async () => {
    const api = new FakeApi(ok);
    await SettingsRepo.set(db, 'create_items_enabled', '1'); // toggle on but key lacks the flag
    const out = await CreateItemWriter.submit(db, api, CreateItemForm.toRequest(draft(), 'cmid-000001'));
    expect(out).toMatchObject({ kind: 'failed', forbidden: true });
    expect(api.calls).toEqual([]);
  });

  it('created → inserted into SQLite (openable immediately)', async () => {
    await enable();
    const api = new FakeApi(ok);
    const out = await CreateItemWriter.submit(db, api, CreateItemForm.toRequest(draft(), 'cmid-000002'), 77);
    expect(out).toEqual({ kind: 'created', itemId: 'NEW1', warnings: [], replayed: false });
    expect(await ItemRepo.byId(db, 'NEW1', 5)).toMatchObject({ name: 'Mango Lassi', price_cents: 349, stock_qty: 12, code: '012345678905' });
    expect((await ItemRepo.findByCodes(db, ['012345678905'], 5)).map((i) => i.id)).toEqual(['NEW1']);
  });

  it.each([
    new ApiError('NETWORK', 'Network request failed', true),
    new ApiError('UPSTREAM', 'Lost connection to Clover during a write', false, 502),
    new ApiError('CONFLICT', 'in progress', false, 409),
  ])('unknown outcome (%p) is reported, never retried', async (err) => {
    await enable();
    const api = new FakeApi(() => err);
    const out = await CreateItemWriter.submit(db, api, CreateItemForm.toRequest(draft(), 'cmid-000003'));
    expect(out.kind).toBe('unknown');
    expect(api.calls).toHaveLength(1);
    expect(await ItemRepo.count(db)).toBe(0);
  });

  it('403 from the server clears the cached device flag', async () => {
    await enable();
    const api = new FakeApi(() => new ApiError('AUTH', 'not allowed', false, 403));
    expect(await CreateItemWriter.submit(db, api, CreateItemForm.toRequest(draft(), 'cmid-000004'))).toMatchObject({ kind: 'failed', forbidden: true });
    expect((await CreateGate.load(db)).allowed).toBe(false);
  });

  it('validation errors are failures (not unknown)', async () => {
    await enable();
    const api = new FakeApi(() => new ApiError('VALIDATION', 'bad', false, 422));
    expect(await CreateItemWriter.submit(db, api, CreateItemForm.toRequest(draft(), 'cmid-000005'))).toMatchObject({ kind: 'failed', forbidden: false });
  });

  it('only CreateItemWriter calls ProxyClient.createItem, and only the create screen calls the writer', () => {
    const root = join(__dirname, '../../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules' || name === '__tests__') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'app'));
    const callers = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1)).sort();
    expect(callers(/\.createItem\(/)).toEqual(['src/features/create/CreateItem.ts']);
    expect(callers(/CreateItemWriter\.submit\(/)).toEqual(['src/features/create/CreateItemScreen.tsx']);
  });
});
