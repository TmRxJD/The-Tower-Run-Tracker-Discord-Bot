import {
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
  type TrackerRunSyncMetadataStore,
} from '@tmrxjd/platform/tools';
import { getTrackerKv, setTrackerKv } from '../services/idb';
import type { LocalRunRecord } from '../features/track/local-run-store';
import { getOrInitBotRunTrackerRxDatabase } from './database-manager';
import { batchUpsertRunPartsToBotRxDB, loadStitchedRunsFromBotRxDB, upsertMergedRunsToBotRxDB } from './persistence';
import type { BotRunTrackerRxDatabase } from './init-database';
import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

function toLocalRunRecord(userId: string, run: Record<string, unknown>): LocalRunRecord | null {
  const runId = typeof run.runId === 'string' && run.runId.trim().length > 0
    ? run.runId.trim()
    : typeof run.id === 'string' && run.id.trim().length > 0
      ? run.id.trim()
      : null;
  const localId = typeof run.localId === 'string' && run.localId.trim().length > 0
    ? run.localId.trim()
    : runId;
  if (!localId) {
    return null;
  }

  const username = typeof run.username === 'string' && run.username.trim().length > 0
    ? run.username.trim()
    : 'unknown';
  const createdAt = Number.isFinite(Number(run.createdAt))
    ? Number(run.createdAt)
    : Date.now();
  const updatedAt = Number.isFinite(Number(run.updatedAt))
    ? Number(run.updatedAt)
    : createdAt;

  return {
    ...run,
    localId,
    userId,
    username,
    runId: runId ?? undefined,
    createdAt,
    updatedAt,
  };
}

export async function ensureBotRunTrackerRxDatabase(userId: string): Promise<BotRunTrackerRxDatabase> {
  return getOrInitBotRunTrackerRxDatabase(userId);
}

export function createBotRunRxSyncStore(_userId: string, db: BotRunTrackerRxDatabase): TrackerRunSyncMetadataStore {
  return {
    getSyncTimestamp: async (cursorId) => {
      return getTrackerKv<number>(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorId}`).catch(() => null);
    },
    setSyncTimestamp: async (cursorId, timestampMs) => {
      await setTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorId}`, timestampMs).catch(() => {});
    },
    batchUpsertPart1: async (documents) => {
      await batchUpsertRunPartsToBotRxDB(
        db,
        documents as TrackerRunPartDocument[],
        [],
      );
    },
    batchUpsertPart2: async (documents) => {
      await batchUpsertRunPartsToBotRxDB(
        db,
        [],
        documents as TrackerRunPartDocument[],
      );
    },
  };
}

export async function loadLocalRunsFromBotRxDB(userId: string): Promise<LocalRunRecord[]> {
  const db = await ensureBotRunTrackerRxDatabase(userId);
  const stitchedRuns = await loadStitchedRunsFromBotRxDB(db);
  return stitchedRuns
    .map((run) => toLocalRunRecord(userId, run))
    .filter((run): run is LocalRunRecord => run !== null);
}

export async function upsertMergedRunsIntoBotRxDB(
  userId: string,
  mergedRuns: Record<string, unknown>[],
): Promise<void> {
  if (mergedRuns.length === 0) {
    return;
  }
  const db = await ensureBotRunTrackerRxDatabase(userId);
  await upsertMergedRunsToBotRxDB(db, mergedRuns);
}
