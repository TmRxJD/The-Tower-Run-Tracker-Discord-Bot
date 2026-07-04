import {
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
  type TrackerRunSyncMetadataStore,
  repairTrackerRunDateTimeRecord,
} from '@tmrxjd/platform/tools';
import { logger } from '../core/logger';
import { getTrackerKv, setTrackerKv } from '../services/idb';
import {
  clearLegacyKvRuns,
  getLegacyKvRuns,
  type LocalRunRecord,
  upsertRunInRunList,
} from '../features/track/local-run-store';
import { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } from './bot-run-schemas';
import { getOrInitBotRunTrackerRxDatabase } from './database-manager';
import { toRunPartPlainDocument } from './run-part-documents';
import {
  batchUpsertRunPartsToBotRxDB,
  countRunsInBotRxDB,
  loadStitchedRunsFromBotRxDB,
  removeRunFromBotRxDB,
  upsertMergedRunsToBotRxDB,
} from './persistence';
import type { BotRunTrackerRxDatabase } from './init-database';
import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

const LEGACY_RXDB_SEED_MARKER_PREFIX = 'tracker-rxdb-legacy-seeded:';
const localRunsReadCache = new Map<string, LocalRunRecord[]>();

export function invalidateBotLocalRunsCache(userId: string): void {
  localRunsReadCache.delete(userId.trim());
}

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

function buildLegacySeedMarker(userId: string): string {
  return `${LEGACY_RXDB_SEED_MARKER_PREFIX}${userId}`;
}

export async function ensureBotRunTrackerRxDatabase(userId: string): Promise<BotRunTrackerRxDatabase> {
  return getOrInitBotRunTrackerRxDatabase(userId);
}

export async function seedBotRunRxDBFromLegacyKvIfNeeded(userId: string): Promise<void> {
  const seedMarker = buildLegacySeedMarker(userId);
  if (await getTrackerKv<boolean>(seedMarker).catch(() => null)) {
    return;
  }

  const db = await ensureBotRunTrackerRxDatabase(userId);
  const legacyRuns = await getLegacyKvRuns(userId);
  const existingCount = await countRunsInBotRxDB(db, userId);

  if (existingCount > 0) {
    if (legacyRuns.length > existingCount) {
      await upsertMergedRunsToBotRxDB(db, userId, legacyRuns as Record<string, unknown>[]);
      logger.info('[rxdb] backfilled legacy KV runs into partially seeded RxDB', {
        userId,
        legacyCount: legacyRuns.length,
        existingCount,
      });
      await clearLegacyKvRuns(userId);
      invalidateBotLocalRunsCache(userId);
    } else if (legacyRuns.length === 0 || existingCount >= legacyRuns.length) {
      await clearLegacyKvRuns(userId);
    }
    await setTrackerKv(seedMarker, true).catch(() => {});
    return;
  }

  if (legacyRuns.length === 0) {
    await setTrackerKv(seedMarker, true).catch(() => {});
    return;
  }

  await upsertMergedRunsToBotRxDB(db, userId, legacyRuns as Record<string, unknown>[]);
  await clearLegacyKvRuns(userId);
  await setTrackerKv(seedMarker, true).catch(() => {});
  invalidateBotLocalRunsCache(userId);
  logger.info('[rxdb] seeded legacy KV runs into RxDB', { userId, count: legacyRuns.length });
}

export function createBotRunRxSyncStore(userId: string, db: BotRunTrackerRxDatabase): TrackerRunSyncMetadataStore {
  return {
    getSyncTimestamp: async (cursorId) => {
      return getTrackerKv<number>(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorId}`).catch(() => null);
    },
    setSyncTimestamp: async (cursorId, timestampMs) => {
      await setTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorId}`, timestampMs).catch(() => {});
    },
    batchUpsertRunParts: async (part1Documents, part2Documents) => {
      await batchUpsertRunPartsToBotRxDB(
        db,
        userId,
        part1Documents as TrackerRunPartDocument[],
        part2Documents as TrackerRunPartDocument[],
      );
    },
    batchUpsertPart1: async (documents) => {
      await batchUpsertRunPartsToBotRxDB(
        db,
        userId,
        documents as TrackerRunPartDocument[],
        [],
      );
    },
    batchUpsertPart2: async (documents) => {
      await batchUpsertRunPartsToBotRxDB(
        db,
        userId,
        [],
        documents as TrackerRunPartDocument[],
      );
    },
  };
}

export async function getLocalRunCount(userId: string): Promise<number> {
  const normalized = userId.trim();
  const cached = localRunsReadCache.get(normalized);
  if (cached) {
    return cached.length;
  }

  await seedBotRunRxDBFromLegacyKvIfNeeded(normalized);
  const db = await ensureBotRunTrackerRxDatabase(normalized);
  return countRunsInBotRxDB(db, normalized);
}

export async function loadLocalRunsFromBotRxDB(userId: string): Promise<LocalRunRecord[]> {
  const normalized = userId.trim();
  const cached = localRunsReadCache.get(normalized);
  if (cached) {
    return cached;
  }

  await seedBotRunRxDBFromLegacyKvIfNeeded(normalized);
  const db = await ensureBotRunTrackerRxDatabase(normalized);
  const stitchedRuns = await loadStitchedRunsFromBotRxDB(db, normalized);
  const records = stitchedRuns
    .map((run) => toLocalRunRecord(normalized, run))
    .filter((run): run is LocalRunRecord => run !== null);

  if (records.length === 0) {
    const rawCount = await countRunsInBotRxDB(db, normalized);
    if (rawCount > 0) {
      const part1Docs = await db.run_part_1.find({
        selector: { [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: normalized },
      }).exec();
      for (const part1 of part1Docs) {
        const plainPart1 = toRunPartPlainDocument(part1);
        if (!plainPart1?.id) continue;
        const fallbackRun = repairTrackerRunDateTimeRecord({
          ...plainPart1,
          id: plainPart1.id,
          runId: typeof plainPart1.runId === 'string' && plainPart1.runId.trim()
            ? plainPart1.runId
            : plainPart1.id,
        });
        const record = toLocalRunRecord(normalized, fallbackRun);
        if (record) records.push(record);
      }
      logger.warn('[rxdb] stitch produced zero runs; using part1-only fallback for local reads', {
        userId: normalized,
        rawCount,
        recovered: records.length,
      });
    }
  }

  localRunsReadCache.set(normalized, records);
  return records;
}

export async function upsertLocalRunIntoBotRxDB(
  userId: string,
  username: string,
  runData: Record<string, unknown>,
): Promise<LocalRunRecord> {
  await seedBotRunRxDBFromLegacyKvIfNeeded(userId);
  const db = await ensureBotRunTrackerRxDatabase(userId);
  const existingRuns = await loadLocalRunsFromBotRxDB(userId);
  const merged = upsertRunInRunList(existingRuns, userId, username, runData, Date.now());
  await upsertMergedRunsToBotRxDB(db, userId, [merged.record]);
  localRunsReadCache.set(userId.trim(), merged.runs);
  return merged.record;
}

export async function bulkUpsertLocalRunsIntoBotRxDB(
  userId: string,
  runs: Array<{ username: string; runData: Record<string, unknown> }>,
): Promise<{ added: number; updated: number; records: LocalRunRecord[]; wasUpdates: boolean[] }> {
  if (runs.length === 0) {
    return { added: 0, updated: 0, records: [], wasUpdates: [] };
  }

  await seedBotRunRxDBFromLegacyKvIfNeeded(userId);
  const db = await ensureBotRunTrackerRxDatabase(userId);
  let nextRuns = await loadLocalRunsFromBotRxDB(userId);
  const now = Date.now();
  let added = 0;
  let updated = 0;
  const records: LocalRunRecord[] = [];
  const wasUpdates: boolean[] = [];

  for (const { username, runData } of runs) {
    const merged = upsertRunInRunList(nextRuns, userId, username, runData, now);
    nextRuns = merged.runs;
    records.push(merged.record);
    wasUpdates.push(merged.wasUpdate);
    if (merged.wasUpdate) updated += 1;
    else added += 1;
  }

  await upsertMergedRunsToBotRxDB(db, userId, records as Record<string, unknown>[]);
  localRunsReadCache.set(userId.trim(), nextRuns);
  return { added, updated, records, wasUpdates };
}

export async function upsertMergedRunsIntoBotRxDB(
  userId: string,
  mergedRuns: Record<string, unknown>[],
): Promise<void> {
  if (mergedRuns.length === 0) {
    return;
  }
  await seedBotRunRxDBFromLegacyKvIfNeeded(userId);
  const db = await ensureBotRunTrackerRxDatabase(userId);
  await upsertMergedRunsToBotRxDB(db, userId, mergedRuns);
  invalidateBotLocalRunsCache(userId);
}

export async function removeLocalRunFromBotRxDB(
  userId: string,
  reference: { runId?: string; localId?: string },
): Promise<void> {
  await seedBotRunRxDBFromLegacyKvIfNeeded(userId);
  const db = await ensureBotRunTrackerRxDatabase(userId);
  await removeRunFromBotRxDB(db, userId, reference);
  invalidateBotLocalRunsCache(userId);
}

export { countRunsInBotRxDB } from './persistence';
