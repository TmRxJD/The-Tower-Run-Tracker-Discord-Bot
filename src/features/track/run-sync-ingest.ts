import {
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
  TRACKER_RUN_SYNC_INGEST_CHUNK_SIZE,
  TRACKER_RUN_SYNC_INGEST_YIELD_MS,
  hydrateTrackerCloudRun,
} from '@tmrxjd/platform/tools';
import { setTrackerKv } from '../../services/idb';
import { logger } from '../../core/logger';
import { unbindBotRunTrackerRxDBInboundSync } from '../../rxdb/reactive-sync';
import { ensureBotRunTrackerRxDatabase, invalidateBotLocalRunsCache, removeLocalRunFromBotRxDB, upsertMergedRunsIntoBotRxDB } from '../../rxdb/run-rxdb-store';
import { filterOutTombstonedRuns, getPermanentlyDeletedRunIds } from './run-deletion-tombstones';

function yieldEventLoop(ms = TRACKER_RUN_SYNC_INGEST_YIELD_MS): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRunSoftDeleted(run: Record<string, unknown>): boolean {
  const deletedAt = run.deletedAt;
  return typeof deletedAt === 'string' && deletedAt.trim().length > 0;
}

function resolveRunId(run: Record<string, unknown>): string | undefined {
  const runId = run.runId ?? run.id ?? run.$id;
  return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : undefined;
}

function pickIngestUsername(run: Record<string, unknown>): string {
  const username = run.username;
  return typeof username === 'string' && username.trim().length > 0 ? username.trim() : 'unknown';
}

export async function ingestMergedRunsIntoBotStore(
  userId: string,
  runs: Record<string, unknown>[],
  syncedAtMs = Date.now(),
  options?: { persistSyncCursor?: boolean },
): Promise<{ ingested: number }> {
  if (runs.length === 0) {
    return { ingested: 0 };
  }

  await ensureBotRunTrackerRxDatabase(userId);
  unbindBotRunTrackerRxDBInboundSync(userId);

  const tombstones = await getPermanentlyDeletedRunIds(userId);
  const visibleRuns = filterOutTombstonedRuns(runs, tombstones);

  // Split incoming runs: soft-deleted ones must be removed locally, active ones upserted.
  const activeRuns: Record<string, unknown>[] = [];
  const deletedRuns: Record<string, unknown>[] = [];
  for (const run of visibleRuns) {
    if (isRunSoftDeleted(run)) {
      deletedRuns.push(run);
    } else {
      activeRuns.push(run);
    }
  }

  // Remove soft-deleted runs from local store so they don't come back after site/other-device delete.
  for (const run of deletedRuns) {
    const runId = resolveRunId(run);
    if (runId) {
      await removeLocalRunFromBotRxDB(userId, { runId }).catch(() => {});
    }
  }

  let ingested = 0;
  const hydratedActiveRuns = activeRuns.map(run => hydrateTrackerCloudRun(run, userId, pickIngestUsername(run)));
  for (let index = 0; index < hydratedActiveRuns.length; index += TRACKER_RUN_SYNC_INGEST_CHUNK_SIZE) {
    const chunk = hydratedActiveRuns.slice(index, index + TRACKER_RUN_SYNC_INGEST_CHUNK_SIZE);
    await upsertMergedRunsIntoBotRxDB(userId, chunk);
    ingested += chunk.length;

    if (index + TRACKER_RUN_SYNC_INGEST_CHUNK_SIZE < hydratedActiveRuns.length) {
      await yieldEventLoop();
    }
  }

  if (options?.persistSyncCursor !== false) {
    await setTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${userId}`, syncedAtMs).catch(() => {});
  }
  invalidateBotLocalRunsCache(userId);
  logger.info('[run-sync-ingest] applied merged runs', { userId, ingested, deleted: deletedRuns.length, syncedAtMs });
  return { ingested };
}
