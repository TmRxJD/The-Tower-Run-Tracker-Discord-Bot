import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSharedBotRunTrackerRxDatabase } from './init-database';
import {
  RXDB_UPSERT_CHUNK_SIZE,
  countRunsInBotRxDB,
  loadStitchedRunsFromBotRxDB,
  removeRunFromBotRxDB,
  upsertMergedRunsToBotRxDB,
} from './persistence';

function makeRun(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runId: id,
    localId: id,
    username: 'tester',
    type: 'Farming',
    runDate: '2026-07-01',
    runTime: '10:00',
    tier: '10',
    wave: '1000',
    totalCoins: '100',
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
    ...overrides,
  };
}

describe('bot run RxDB persistence (memory engine)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes every run when a large batch is split into chunks', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    const total = RXDB_UPSERT_CHUNK_SIZE * 3 + 7;
    const runs = Array.from({ length: total }, (_, index) => makeRun(`chunked-${index}`));

    await upsertMergedRunsToBotRxDB(db, 'scope-chunked', runs);

    expect(await countRunsInBotRxDB(db, 'scope-chunked')).toBe(total);
    const stitched = await loadStitchedRunsFromBotRxDB(db, 'scope-chunked');
    expect(stitched.map((run) => run.id).sort()).toEqual(runs.map((run) => run.id).sort());
  });

  it('yields to the event loop between chunks instead of running one long stall', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    const immediates = vi.spyOn(globalThis, 'setImmediate');
    const runs = Array.from({ length: RXDB_UPSERT_CHUNK_SIZE * 4 }, (_, index) => makeRun(`yielding-${index}`));

    await upsertMergedRunsToBotRxDB(db, 'scope-yield', runs);

    // Four chunks means three hand-backs to the event loop.
    expect(immediates.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a small write in a single pass', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    const immediates = vi.spyOn(globalThis, 'setImmediate');

    await upsertMergedRunsToBotRxDB(db, 'scope-small', [makeRun('small-1'), makeRun('small-2')]);

    expect(immediates).not.toHaveBeenCalled();
    expect(await countRunsInBotRxDB(db, 'scope-small')).toBe(2);
  });

  it('removes a run by its own id without disturbing the user\'s other runs', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    await upsertMergedRunsToBotRxDB(db, 'scope-remove', [makeRun('keep-1'), makeRun('drop-1'), makeRun('keep-2')]);

    expect(await removeRunFromBotRxDB(db, 'scope-remove', { runId: 'drop-1' })).toBe(true);

    const remaining = (await loadStitchedRunsFromBotRxDB(db, 'scope-remove')).map((run) => run.id).sort();
    expect(remaining).toEqual(['keep-1', 'keep-2']);
  });

  it('finds a run through its local id when the stored document id differs', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    await upsertMergedRunsToBotRxDB(db, 'scope-fallback', [
      makeRun('cloud-id-1', { localId: 'local-abc' }),
      makeRun('other-1'),
    ]);

    // The reference only knows the local id, so the direct id lookup misses and the
    // same-entry scan has to resolve it.
    expect(await removeRunFromBotRxDB(db, 'scope-fallback', { localId: 'local-abc' })).toBe(true);

    const remaining = (await loadStitchedRunsFromBotRxDB(db, 'scope-fallback')).map((run) => run.id);
    expect(remaining).toEqual(['other-1']);
  });

  it('does not delete another user\'s run that shares an id', async () => {
    const db = await initSharedBotRunTrackerRxDatabase();
    await upsertMergedRunsToBotRxDB(db, 'scope-owner', [makeRun('shared-id')]);

    await removeRunFromBotRxDB(db, 'scope-stranger', { runId: 'shared-id' });

    expect(await countRunsInBotRxDB(db, 'scope-owner')).toBe(1);
  });
});
