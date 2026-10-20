import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { IntentQueueRepo } from '../../../db/intentQueue';
import { WasmSqlDb } from '../../../db/testing/wasmDb';

describe('Offline intent queue (spec §4.4)', () => {
  let db: WasmSqlDb;
  beforeEach(async () => {
    db = await WasmSqlDb.migrated();
  });
  afterEach(() => db.close());

  it('stores deltas only: the table has no absolute-quantity column', async () => {
    const cols = (await db.all<{ name: string }>('PRAGMA table_info(queued_intents)')).map((c) => c.name);
    expect(cols).toEqual(['id', 'item_id', 'item_name', 'action', 'delta', 'reason', 'note', 'status', 'created_at', 'resolved_at']);
    for (const absolute of ['expected_quantity', 'new_quantity', 'before_qty', 'after_qty', 'quantity']) expect(cols).not.toContain(absolute);
  });

  it('refuses Count (an absolute value) at the API and at the schema', async () => {
    await expect(
      IntentQueueRepo.enqueue(db, { itemId: 'A', itemName: 'A', action: 'count' as 'receive', delta: 9 }),
    ).rejects.toThrow(/Only Receive and Adjust/);
    await expect(
      db.run("INSERT INTO queued_intents (item_id, action, delta, created_at) VALUES ('A', 'count', 9, 1)"),
    ).rejects.toThrow(/CHECK/);
  });

  it('validates intents', async () => {
    expect(IntentQueueRepo.check({ action: 'receive', delta: 0 })).toMatch(/non-zero/);
    expect(IntentQueueRepo.check({ action: 'receive', delta: -1 })).toMatch(/positive/);
    expect(IntentQueueRepo.check({ action: 'receive', delta: 1.5 })).toMatch(/whole/);
    expect(IntentQueueRepo.check({ action: 'adjust', delta: -1 })).toMatch(/reason/);
    expect(IntentQueueRepo.check({ action: 'adjust', delta: -1, reason: 'theft_loss' })).toBeNull();
  });

  it('pending → close (applied / sent / discarded) is one-way', async () => {
    await IntentQueueRepo.enqueue(db, { itemId: 'A', itemName: 'Rice', action: 'receive', delta: 24, note: 'INV-1', now: 5 });
    await IntentQueueRepo.enqueue(db, { itemId: 'B', itemName: 'Ramen', action: 'adjust', delta: -1, reason: 'damaged', now: 6 });
    const [a, b] = await IntentQueueRepo.pending(db);
    expect(a).toMatchObject({ item_id: 'A', action: 'receive', delta: 24, note: 'INV-1', status: 'queued' });
    expect(await IntentQueueRepo.count(db)).toBe(2);
    await IntentQueueRepo.close(db, a!.id, 'discarded', 10);
    await IntentQueueRepo.close(db, a!.id, 'applied', 11); // no effect: already closed
    expect((await db.first<{ status: string }>('SELECT status FROM queued_intents WHERE id = ?', [a!.id]))?.status).toBe('discarded');
    expect((await IntentQueueRepo.pending(db)).map((q) => q.id)).toEqual([b!.id]);
  });

  it('never auto-flushes: only user-driven screens read the queue or run a batch', () => {
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
    // Queue is read only by Activity (display) and the batch confirmation screen.
    expect(callers(/IntentQueueRepo\.pending\(/)).toEqual(['src/features/activity/ActivityScreen.tsx', 'src/features/batch/BatchScreen.tsx']);
    // Batch writes run only from the confirmation screen's Apply button; sync/connectivity code never touches the queue.
    expect(callers(/BatchRunner\.run\(/)).toEqual(['src/features/batch/BatchScreen.tsx']);
    expect(callers(/IntentQueueRepo|queued_intents/).filter((f) => f.startsWith('src/sync'))).toEqual([]);
  });
});
