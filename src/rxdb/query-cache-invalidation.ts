import { logger } from '../core/logger';
import type { BotRunTrackerRxDatabase } from './init-database';

/**
 * Makes RxDB re-read from storage after the index files were repaired underneath it.
 *
 * RxDB caches an RxQuery per selector and only re-executes when it believes the collection
 * changed. A repair applied at the storage layer is invisible to that bookkeeping, so the
 * cached query keeps serving the pre-repair view — including rows for documents that no
 * longer exist.
 *
 * Closing the database also clears the caches, but it closes it for *everyone*: any query a
 * concurrent user already has in flight fails with COL21 ("collection is closed"), and a
 * concurrent reopen can collide with the close and fail with DB8. Dropping just the cached
 * queries leaves every in-flight read working.
 *
 * `_queryCache` is RxDB-internal, so this is written to degrade quietly rather than throw if
 * a future version reshapes it — the caller's fallback still handles the unrecovered case.
 */
type CollectionWithQueryCache = {
  _queryCache?: { _map?: Map<unknown, unknown> };
};

export function invalidateBotRunQueryCaches(db: BotRunTrackerRxDatabase): boolean {
  const collections: CollectionWithQueryCache[] = [
    db.run_part_1 as unknown as CollectionWithQueryCache,
    db.run_part_2 as unknown as CollectionWithQueryCache,
  ];

  let cleared = 0;
  for (const collection of collections) {
    const map = collection?._queryCache?._map;
    if (map && typeof map.clear === 'function') {
      map.clear();
      cleared += 1;
    }
  }

  if (cleared !== collections.length) {
    logger.warn('[rxdb] could not clear every RxDB query cache; RxDB internals may have changed', {
      clearedCollections: cleared,
      expectedCollections: collections.length,
    });
  }

  return cleared > 0;
}
