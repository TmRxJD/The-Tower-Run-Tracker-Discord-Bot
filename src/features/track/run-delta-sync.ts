import { Query } from 'node-appwrite';
import {
  syncTrackerRunCloudDeltas,
  TRACKER_RUN_DELTA_PAGINATION_ATTRIBUTE,
  TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
  TRACKER_RUN_EXTENDED_COLLECTION_ID,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import { logger } from '../../core/logger';
import { resolveBotRunCloudIdentity } from './run-cloud-identity';
import { bindBotRunTrackerRxDBInboundSync } from '../../rxdb/reactive-sync';
import { ensureBotRunTrackerRxDatabase, loadLocalRunsFromBotRxDB } from '../../rxdb/run-rxdb-store';
import { getMaxUpdatedAtMsForBotScopeUser } from '../../rxdb/persistence';
import { getLocalSettings } from './local-run-store';
import { fetchTrackerRunDeltasFromFunction, type TrackerRunDeltaFunctionResult } from './run-delta-function-client';
import { ingestMergedRunsIntoBotStore } from './run-sync-ingest';

const RUNS_DATABASE_ID = 'run-tracker-data';
const BULK_IMPORT_PARALLEL_PAGES = 10;

type DeltaSyncOptions = {
  maxPages?: number;
};

function buildUpdatedAtQueries(input: {
  userId: string;
  updatedAtMs: number;
  limit: number;
}): string[] {
  const cursor = input.updatedAtMs > 0
    ? new Date(input.updatedAtMs).toISOString()
    : new Date(0).toISOString();
  return [
    Query.equal('userId', input.userId),
    Query.greaterThan(TRACKER_RUN_DELTA_PAGINATION_ATTRIBUTE, cursor),
    Query.orderDesc(TRACKER_RUN_DELTA_PAGINATION_ATTRIBUTE),
    Query.limit(input.limit),
  ];
}

function createSyncCursorStore() {
  return {
    getSyncTimestamp: async (cursorUserId: string) => {
      return getTrackerKv<number>(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorUserId}`).catch(() => null);
    },
    setSyncTimestamp: async (cursorUserId: string, timestampMs: number) => {
      await setTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorUserId}`, timestampMs).catch(() => {});
    },
  };
}

async function syncUserRunDeltasViaSdk(
  userId: string,
  cloudUserId: string,
  lookupUserIds: string[],
  limit: number,
): Promise<{ changed: boolean }> {
  const { databases } = createAppwriteClient();

  const result = await syncTrackerRunCloudDeltas({
    databases,
    databaseId: RUNS_DATABASE_ID,
    mainCollectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    extendedCollectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
    userId: cloudUserId,
    lookupUserIds,
    syncCursorUserId: userId,
    limit,
    buildUpdatedAtQueries,
    syncCursorStore: createSyncCursorStore(),
    repairHooks: {
      onRepaired: ({ docId, reason }: { docId: string; reason: string }) => {
        logger.info('[delta-sync] repaired cloud run document', { userId, docId, reason });
      },
      onSkipped: ({ reason }: { reason: string }) => {
        logger.warn('[delta-sync] skipped unrepairable cloud run document', { userId, reason });
      },
    },
    onNoChanges: ({ userId: cursorUserId, lastSyncedAtMs }: { userId: string; lastSyncedAtMs: number }) => {
      logger.info('[delta-sync] no modified run documents since cursor', { userId: cursorUserId, lastSyncedAtMs });
    },
    onApplied: ({ userId: cursorUserId, count }: { userId: string; count: number }) => {
      logger.info('[delta-sync] applied run deltas to RxDB', { userId: cursorUserId, count });
    },
    applyMergedRuns: async (mergedRuns: Record<string, unknown>[]) => {
      await ingestMergedRunsIntoBotStore(userId, mergedRuns);
    },
  });

  return { changed: result.changed };
}

async function resolveFunctionSyncCursorMs(userId: string, cursorStore: ReturnType<typeof createSyncCursorStore>): Promise<number> {
  const storedCursorMs = (await cursorStore.getSyncTimestamp(userId)) ?? 0;
  const db = await ensureBotRunTrackerRxDatabase(userId);
  const runCount = (await loadLocalRunsFromBotRxDB(userId)).length;

  if (runCount === 0) {
    if (storedCursorMs > 0) {
      logger.info('[delta-function] resetting sync cursor for empty RxDB store', {
        userId,
        storedCursorMs,
      });
      await cursorStore.setSyncTimestamp(userId, 0);
    }
    return 0;
  }

  if (storedCursorMs <= 0) {
    const maxLocalUpdatedAtMs = await getMaxUpdatedAtMsForBotScopeUser(db, userId);
    if (maxLocalUpdatedAtMs > 0) {
      logger.info('[delta-function] bootstrapping sync cursor from local run timestamps', {
        userId,
        maxLocalUpdatedAtMs,
        runCount,
      });
      await cursorStore.setSyncTimestamp(userId, maxLocalUpdatedAtMs);
      return maxLocalUpdatedAtMs;
    }
  }

  return storedCursorMs;
}

async function syncUserRunDeltasViaFunction(
  userId: string,
  cloudUserId: string,
  lookupUserIds: string[],
  limit: number,
  options?: DeltaSyncOptions,
): Promise<{ changed: boolean }> {
  const maxPages = options?.maxPages ?? Number.POSITIVE_INFINITY;
  const cursorStore = createSyncCursorStore();
  const kvCursorMs = await resolveFunctionSyncCursorMs(userId, cursorStore);
  let pageOffset = 0;
  let changed = false;
  let maxSyncedAtMs = kvCursorMs;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const remote = await fetchTrackerRunDeltasFromFunction({
      userId,
      cloudUserId,
      lookupUserIds,
      lastSyncedAtMs: kvCursorMs,
      pageOffset: pageOffset > 0 ? pageOffset : undefined,
      limit,
    });

    pagesFetched += 1;

    if (remote.count === 0 || remote.runs.length === 0) {
      if (!changed && pagesFetched === 1) {
        logger.info('[delta-function] no modified run documents since cursor', { userId, lastSyncedAtMs: kvCursorMs });
      } else if (changed && maxSyncedAtMs > kvCursorMs) {
        await cursorStore.setSyncTimestamp(userId, maxSyncedAtMs);
      }
      return { changed };
    }

    const isFinalPage = !remote.nextPage || pagesFetched >= maxPages;
    await ingestMergedRunsIntoBotStore(userId, remote.runs, remote.syncedAtMs, {
      persistSyncCursor: isFinalPage,
    });
    changed = true;
    maxSyncedAtMs = Math.max(maxSyncedAtMs, remote.syncedAtMs);
    logger.info('[delta-function] applied run deltas to RxDB', {
      userId,
      count: remote.runs.length,
      syncedAtMs: remote.syncedAtMs,
      page: pagesFetched,
      maxPages: Number.isFinite(maxPages) ? maxPages : 'all',
    });

    if (isFinalPage) {
      return { changed };
    }

    pageOffset = remote.nextPage!.pageOffset;
  }

  return { changed };
}

/** Menu-blocking delta check: one page (100 runs), never full-history pagination. */
export async function syncUserRunDeltaPageForMenu(userId: string): Promise<{ changed: boolean }> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return { changed: false };
  }

  const identity = await resolveBotRunCloudIdentity(userId);
  const cloudUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? userId;

  await ensureBotRunTrackerRxDatabase(userId);

  try {
    return await syncUserRunDeltasViaFunction(
      userId,
      cloudUserId,
      identity.lookupUserIds,
      TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
      { maxPages: 1 },
    );
  } catch (functionError) {
    logger.warn('[delta-function] menu delta page failed; falling back to SDK single page', {
      userId,
      error: functionError,
    });
    return syncUserRunDeltasViaSdk(
      userId,
      cloudUserId,
      identity.lookupUserIds,
      TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
    );
  }
}

async function fetchDeltaPageSafe(input: {
  userId: string;
  cloudUserId: string;
  lookupUserIds: string[];
  lastSyncedAtMs: number;
  pageOffset: number;
  limit: number;
}): Promise<TrackerRunDeltaFunctionResult | null> {
  try {
    return await fetchTrackerRunDeltasFromFunction({
      userId: input.userId,
      cloudUserId: input.cloudUserId,
      lookupUserIds: input.lookupUserIds,
      lastSyncedAtMs: input.lastSyncedAtMs,
      pageOffset: input.pageOffset > 0 ? input.pageOffset : undefined,
      limit: input.limit,
    });
  } catch (error) {
    logger.warn('[bulk-import] parallel page fetch failed', {
      userId: input.userId,
      pageOffset: input.pageOffset,
      error,
    });
    return null;
  }
}

/** Full historical cloud pull via tracker-run-delta-patch (lastSyncedAtMs = 0). Background only. */
export async function bulkImportAllRunsFromCloud(
  userId: string,
  limit = TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
): Promise<{ totalImported: number; lastSyncedAtMs: number; success: boolean }> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return { totalImported: 0, lastSyncedAtMs: 0, success: true };
  }

  const identity = await resolveBotRunCloudIdentity(userId);
  const cloudUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? userId;
  const cursorStore = createSyncCursorStore();
  const lastSyncedAtMs = 0;
  let pageOffset = 0;
  let totalImported = 0;
  let maxSyncedAtMs = 0;

  try {
    await ensureBotRunTrackerRxDatabase(userId);
    await bindBotRunTrackerRxDBInboundSync(userId);

    while (true) {
      const offsets = Array.from(
        { length: BULK_IMPORT_PARALLEL_PAGES },
        (_, index) => pageOffset + index * limit,
      );

      const remotes = await Promise.all(offsets.map((offset) => fetchDeltaPageSafe({
        userId,
        cloudUserId,
        lookupUserIds: identity.lookupUserIds,
        lastSyncedAtMs,
        pageOffset: offset,
        limit,
      })));

      let batchImported = 0;
      let batchHadFullPage = false;

      for (const remote of remotes) {
        if (!remote || remote.runs.length === 0) {
          continue;
        }

        await ingestMergedRunsIntoBotStore(userId, remote.runs, remote.syncedAtMs, {
          persistSyncCursor: false,
        });
        batchImported += remote.runs.length;
        totalImported += remote.runs.length;
        maxSyncedAtMs = Math.max(maxSyncedAtMs, remote.syncedAtMs);
        if (remote.runs.length >= limit) {
          batchHadFullPage = true;
        }
      }

      if (batchImported === 0) {
        break;
      }

      logger.info('[bulk-import] ingested parallel batch', {
        userId,
        batchImported,
        totalImported,
        pageOffset,
        parallelPages: BULK_IMPORT_PARALLEL_PAGES,
        limit,
      });

      if (!batchHadFullPage) {
        break;
      }

      pageOffset += BULK_IMPORT_PARALLEL_PAGES * limit;
    }

    if (maxSyncedAtMs > 0) {
      await cursorStore.setSyncTimestamp(userId, maxSyncedAtMs);
    }

    logger.info('[bulk-import] complete', { userId, totalImported, lastSyncedAtMs: maxSyncedAtMs });
    return { totalImported, lastSyncedAtMs: maxSyncedAtMs, success: true };
  } catch (error) {
    logger.warn('[bulk-import] aborted — ingest-only, no local deletes', { userId, totalImported, error });
    return { totalImported, lastSyncedAtMs: maxSyncedAtMs, success: false };
  }
}

export async function syncUserRunDeltas(
  userId: string,
  limit = TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
  options?: DeltaSyncOptions,
): Promise<{ changed: boolean }> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return { changed: false };
  }

  const identity = await resolveBotRunCloudIdentity(userId);
  const cloudUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? userId;

  try {
    await ensureBotRunTrackerRxDatabase(userId);
    await bindBotRunTrackerRxDBInboundSync(userId);

    try {
      return await syncUserRunDeltasViaFunction(userId, cloudUserId, identity.lookupUserIds, limit, options);
    } catch (functionError) {
      logger.warn('[delta-function] remote delta sync failed; falling back to direct SDK queries', {
        userId,
        error: functionError,
      });
      return await syncUserRunDeltasViaSdk(userId, cloudUserId, identity.lookupUserIds, limit);
    }
  } catch (error) {
    logger.warn('[delta-sync] run delta sync failed', { userId, error });
    return { changed: false };
  }
}
