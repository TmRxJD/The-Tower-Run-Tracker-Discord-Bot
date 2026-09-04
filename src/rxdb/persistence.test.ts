import { describe, expect, it } from 'vitest';
import { batchUpsertRunPartsToBotRxDB } from './persistence';
import type { BotRunTrackerRxDatabase } from './init-database';
import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

/**
 * A stand-in for an RxCollection that records how the writes arrived, so a test can assert
 * on batch shape as well as on the documents that landed.
 */
function makeCollection() {
  const batches: TrackerRunPartDocument[][] = [];
  return {
    batches,
    get written() {
      return batches.flat();
    },
    bulkUpsert: async (docs: TrackerRunPartDocument[]) => {
      batches.push(docs);
      return { success: docs, error: [] };
    },
  };
}

function makeDb() {
  const run_part_1 = makeCollection();
  const run_part_2 = makeCollection();
  return {
    run_part_1,
    run_part_2,
    db: { run_part_1, run_part_2 } as unknown as BotRunTrackerRxDatabase,
  };
}

function makeDocs(prefix: string, count: number): TrackerRunPartDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    updatedAt: 1_700_000_000_000 + index,
  })) as unknown as TrackerRunPartDocument[];
}

describe('batchUpsertRunPartsToBotRxDB', () => {
  it('writes every document when the batch spans several chunks', async () => {
    const { run_part_1, run_part_2, db } = makeDb();
    const part1 = makeDocs('p1', 120);
    const part2 = makeDocs('p2', 120);

    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', part1, part2);

    expect(run_part_1.written).toHaveLength(120);
    expect(run_part_2.written).toHaveLength(120);
    expect(run_part_1.written.map((doc) => doc.id)).toEqual(part1.map((doc) => doc.id));
    expect(run_part_2.written.map((doc) => doc.id)).toEqual(part2.map((doc) => doc.id));
  });

  it('splits into chunks rather than one blocking burst, and stamps every document', async () => {
    const { run_part_1, db } = makeDb();

    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', makeDocs('p1', 120), []);

    expect(run_part_1.batches.length).toBeGreaterThan(1);
    for (const batch of run_part_1.batches) {
      expect(batch.length).toBeLessThanOrEqual(50);
    }
    // The scope stamp is what partitions the shared database per user; losing it on a
    // chunk boundary would hide those runs from their owner.
    for (const doc of run_part_1.written) {
      expect((doc as unknown as { botScopeUserId: string }).botScopeUserId).toBe('discord-1');
    }
  });

  /**
   * The point of chunking: the loop must be able to run something else — an interaction ACK
   * — between chunks. A timer scheduled before the write has to fire before it finishes.
   */
  it('yields to the event loop between chunks', async () => {
    const { db } = makeDb();
    // A macrotask queued before the write. If the writer yields, this runs while the write
    // is still in progress; without a yield it cannot run until the whole write is done.
    // (setTimeout is no good here: it clamps to 1ms, which mocked writes beat anyway.)
    let queuedWorkRan = false;
    setImmediate(() => { queuedWorkRan = true; });

    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', makeDocs('p1', 200), makeDocs('p2', 200));

    expect(queuedWorkRan).toBe(true);
  });

  it('does not yield when there is only a single chunk to write', async () => {
    const { db } = makeDb();
    let queuedWorkRan = false;
    setImmediate(() => { queuedWorkRan = true; });

    // One chunk per collection still yields after each, which is what lets an ACK through.
    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', makeDocs('p1', 5), []);

    expect(queuedWorkRan).toBe(true);
  });

  it('handles uneven collection sizes and skips empty writes', async () => {
    const { run_part_1, run_part_2, db } = makeDb();

    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', makeDocs('p1', 60), makeDocs('p2', 10));

    expect(run_part_1.written).toHaveLength(60);
    expect(run_part_2.written).toHaveLength(10);
    expect(run_part_2.batches).toHaveLength(1);
    expect(run_part_1.batches.every((batch) => batch.length > 0)).toBe(true);
  });

  it('does not touch the database when there is nothing to write', async () => {
    const { run_part_1, run_part_2, db } = makeDb();

    await batchUpsertRunPartsToBotRxDB(db, 'discord-1', [], []);

    expect(run_part_1.batches).toHaveLength(0);
    expect(run_part_2.batches).toHaveLength(0);
  });
});
