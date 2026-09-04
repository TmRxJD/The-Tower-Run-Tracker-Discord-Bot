import { describe, expect, it, vi } from 'vitest';
import { invalidateBotRunQueryCaches } from './query-cache-invalidation';
import type { BotRunTrackerRxDatabase } from './init-database';

function makeCollection(withCache = true) {
  const map = new Map<string, unknown>([['query-a', {}], ['query-b', {}]]);
  return withCache ? { _queryCache: { _map: map }, map } : { map };
}

describe('invalidateBotRunQueryCaches', () => {
  /**
   * After the index files are repaired underneath RxDB, its cached queries still describe
   * the pre-repair view. Dropping them is what makes the repair visible — without closing
   * the database, which would break every concurrent read with COL21.
   */
  it('clears the cached queries of both run collections', () => {
    const run_part_1 = makeCollection();
    const run_part_2 = makeCollection();

    const result = invalidateBotRunQueryCaches(
      { run_part_1, run_part_2 } as unknown as BotRunTrackerRxDatabase,
    );

    expect(result).toBe(true);
    expect(run_part_1.map.size).toBe(0);
    expect(run_part_2.map.size).toBe(0);
  });

  it('degrades quietly if RxDB no longer exposes the cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run_part_1 = makeCollection(true);
    const run_part_2 = makeCollection(false);

    const result = invalidateBotRunQueryCaches(
      { run_part_1, run_part_2 } as unknown as BotRunTrackerRxDatabase,
    );

    // One cache cleared is still progress; the caller's fallback covers the rest.
    expect(result).toBe(true);
    expect(run_part_1.map.size).toBe(0);
    warn.mockRestore();
  });

  it('reports failure when no cache could be cleared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = invalidateBotRunQueryCaches(
      { run_part_1: makeCollection(false), run_part_2: makeCollection(false) } as unknown as BotRunTrackerRxDatabase,
    );
    expect(result).toBe(false);
    warn.mockRestore();
  });
});
