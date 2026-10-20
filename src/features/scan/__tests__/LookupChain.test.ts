import type { LookupResult, RemoteItem } from '../../../api/schemas';
import { ItemRepo } from '../../../db/items';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { Barcode, DEFAULT_VARIABLE_WEIGHT_RULE } from '../../../lib/barcode';
import { ApiError } from '../../../lib/errors';
import { LookupChain, ScanDebouncer, type RemoteLookup } from '../LookupChain';

const item = (over: Partial<RemoteItem> & { id: string }): RemoteItem => ({
  name: over.id, sku: null, code: null, priceCents: 100, costCents: null, categoryId: null,
  stockQty: 5, modifiedTime: 1, deleted: false, ...over,
});

class FakeRemote implements RemoteLookup {
  calls: string[] = [];
  constructor(private readonly respond: (code: string) => LookupResult | Error) {}
  async lookup(code: string): Promise<LookupResult> {
    this.calls.push(code);
    const r = this.respond(code);
    if (r instanceof Error) throw r;
    return r;
  }
}

const none = () => ({ match: null, candidates: [] });
const opts = { rule: DEFAULT_VARIABLE_WEIGHT_RULE, globalThreshold: 5, now: 99 };

describe('LookupChain', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
    await ItemRepo.upsertItems(
      db,
      [
        item({ id: 'RICE', name: 'Jasmine Rice', code: '036000291452', sku: 'RICE-JAS-20' }),
        item({ id: 'UPCE', name: 'Gum', code: '042100005264' }),
        item({ id: 'PORK', name: 'Pork Belly', code: '201234000000', sku: 'DELI-PORK' }),
        item({ id: 'DUP1', name: 'Pocky A', code: '073141150019' }),
        item({ id: 'DUP2', name: 'Pocky B', code: '073141150019' }),
        item({ id: 'NOCODE', name: 'Gift Bag', sku: 'MISC-GIFTBAG' }),
      ],
      1,
    );
  });
  afterEach(() => db.close());

  it('1. local code (also matches iOS EAN-13 form of a UPC-A)', async () => {
    const remote = new FakeRemote(none);
    const a = await LookupChain.resolve(db, remote, '036000291452', opts);
    const b = await LookupChain.resolve(db, remote, '0036000291452', { ...opts, type: 'ean13' });
    expect(a).toMatchObject({ kind: 'found', source: 'code', item: { id: 'RICE' } });
    expect(b).toMatchObject({ kind: 'found', source: 'code', item: { id: 'RICE' } });
    expect(remote.calls).toEqual([]);
  });

  it('UPC-E scan finds item stored as UPC-A', async () => {
    const out = await LookupChain.resolve(db, new FakeRemote(none), '04252614', { ...opts, type: 'upc_e' });
    expect(out).toMatchObject({ kind: 'found', item: { id: 'UPCE' } });
  });

  it('variable-weight scan finds the item by its item portion', async () => {
    const scanned = Barcode.withCheckDigit('20123401299');
    const out = await LookupChain.resolve(db, new FakeRemote(none), scanned, opts);
    expect(out).toMatchObject({ kind: 'found', source: 'code', item: { id: 'PORK' } });
    expect(out.kind === 'found' && out.barcode.variableWeight?.itemCode).toBe('201234');
  });

  it('2. falls back to sku (case-insensitive)', async () => {
    const out = await LookupChain.resolve(db, new FakeRemote(none), 'misc-giftbag', opts);
    expect(out).toMatchObject({ kind: 'found', source: 'sku', item: { id: 'NOCODE' } });
  });

  it('3. falls back to local barcode aliases', async () => {
    await ItemRepo.addAlias(db, '4006381333931', 'NOCODE');
    const remote = new FakeRemote(none);
    const out = await LookupChain.resolve(db, remote, '4006381333931', opts);
    expect(out).toMatchObject({ kind: 'found', source: 'alias', item: { id: 'NOCODE' } });
    expect(remote.calls).toEqual([]);
  });

  it('duplicate local codes are ambiguous', async () => {
    const out = await LookupChain.resolve(db, new FakeRemote(none), '073141150019', opts);
    expect(out.kind).toBe('ambiguous');
    expect(out.kind === 'ambiguous' && out.candidates.map((c) => c.id)).toEqual(['DUP1', 'DUP2']);
  });

  it('4. proxy lookup on local miss; hit is cached into SQLite', async () => {
    const remoteItem = item({ id: 'NEW', name: 'New Item', code: '4006381333931', modifiedTime: 7 });
    const remote = new FakeRemote(() => ({ match: remoteItem, candidates: [] }));
    const out = await LookupChain.resolve(db, remote, '4006381333931', opts);
    expect(remote.calls).toEqual(['4006381333931']);
    expect(out).toMatchObject({ kind: 'found', source: 'remote', item: { id: 'NEW', synced_at: 99 } });
    // Next scan is served locally.
    const again = await LookupChain.resolve(db, new FakeRemote(none), '4006381333931', opts);
    expect(again).toMatchObject({ kind: 'found', source: 'code' });
  });

  it('proxy gets the canonical form (UPC-A for EAN-13-wrapped, item code for weighted)', async () => {
    const remote = new FakeRemote(none);
    await LookupChain.resolve(db, remote, '0012345678905', opts);
    await LookupChain.resolve(db, remote, Barcode.withCheckDigit('29999901299'), opts);
    expect(remote.calls).toEqual(['012345678905', '299999']);
  });

  it('proxy candidates become ambiguous', async () => {
    const remote = new FakeRemote(() => ({ match: null, candidates: [item({ id: 'X1', code: '1' }), item({ id: 'X2', code: '1' })] }));
    const out = await LookupChain.resolve(db, remote, '96385074', opts);
    expect(out.kind).toBe('ambiguous');
  });

  it('5. not found everywhere', async () => {
    const out = await LookupChain.resolve(db, new FakeRemote(none), '96385074', opts);
    expect(out).toMatchObject({ kind: 'not_found', remoteError: null });
  });

  it('offline/proxy error is reported, not thrown', async () => {
    const remote = new FakeRemote(() => new ApiError('NETWORK', 'Network request failed', true));
    const out = await LookupChain.resolve(db, remote, '96385074', opts);
    expect(out.kind).toBe('not_found');
    expect(out.kind === 'not_found' && out.remoteError?.code).toBe('NETWORK');
  });

  it('empty input does not hit the network', async () => {
    const remote = new FakeRemote(none);
    expect((await LookupChain.resolve(db, remote, '  ', opts)).kind).toBe('not_found');
    expect(remote.calls).toEqual([]);
  });
});

describe('ItemRepo aliases', () => {
  it('relinking moves the alias', async () => {
    const db = await WasmSqlDb.migrated();
    await ItemRepo.addAlias(db, '111', 'A');
    await ItemRepo.addAlias(db, '111', 'B');
    expect(await ItemRepo.aliases(db, 'A')).toEqual([]);
    expect(await ItemRepo.aliases(db, 'B')).toEqual(['111']);
    await expect(ItemRepo.addAlias(db, '', 'B')).rejects.toThrow(RangeError);
    db.close();
  });
});

describe('ScanDebouncer', () => {
  it('drops identical codes within 1.2 s, sliding while held', () => {
    const d = new ScanDebouncer();
    expect(d.accept('A', 0)).toBe(true);
    expect(d.accept('A', 1000)).toBe(false);
    expect(d.accept('A', 2100)).toBe(false); // still held in view: window slides
    expect(d.accept('A', 3400)).toBe(true);
    expect(d.accept('B', 3500)).toBe(true);
    expect(d.accept('A', 3600)).toBe(false); // per identical code: B in between doesn't reset A's window
    expect(d.accept('A', 4700)).toBe(false); // still sliding (last A read at 3600)
    expect(d.accept('A', 5900)).toBe(true);
  });

  it('two codes alternating in the frame are each counted once per window', () => {
    const d = new ScanDebouncer();
    const reads = [0, 100, 200, 300, 400, 500].map((t, i) => d.accept(i % 2 ? 'B' : 'A', t));
    expect(reads).toEqual([true, true, false, false, false, false]);
  });
});
