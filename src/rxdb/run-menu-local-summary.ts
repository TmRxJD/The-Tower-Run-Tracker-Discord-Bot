import {
  estimateTrackerRunTimestamp,
  parseTrackerRunDateTimeTimestamp,
  stitchTrackerRunCollections,
  type TrackerRunPartDocument,
} from '@tmrxjd/platform/tools';
import { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } from './bot-run-schemas';
import { toRunPartPlainDocument } from './run-part-documents';
import { ensureBotRunTrackerRxDatabase, seedBotRunRxDBFromLegacyKvIfNeeded } from './run-rxdb-store';
import { destroySharedBotRunTrackerRxDatabase } from './database-manager';
import { logger } from '../core/logger';
import type { BotRunTrackerRxDatabase } from './init-database';

export const MENU_ANALYTICS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const ANALYTICS_LOOKBACK_MS = MENU_ANALYTICS_LOOKBACK_MS;

export type BotMenuRunSummary = {
  totalRuns: number;
  lastRun: Record<string, unknown> | null;
  runTypeCounts: Record<string, number>;
  /** Stitched recent runs for chart + delta baseline (not full history). */
  recentRunsForAnalytics: Record<string, unknown>[];
};

function normalizeScopeUserId(scopeUserId: string): string {
  const normalized = scopeUserId.trim();
  if (!normalized) {
    throw new Error('Bot menu run summary requires a scope user id.');
  }
  return normalized;
}

function buildScopeSelector(scopeUserId: string) {
  return {
    [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: normalizeScopeUserId(scopeUserId),
  };
}

function toCloudType(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || 'Farming';
}

function normalizeDateStrForSort(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return `${iso[1]}-${String(parseInt(iso[2], 10)).padStart(2, '0')}-${String(parseInt(iso[3], 10)).padStart(2, '0')}`;
  }
  const mdy = trimmed.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year}-${String(parseInt(mdy[1], 10)).padStart(2, '0')}-${String(parseInt(mdy[2], 10)).padStart(2, '0')}`;
  }
  return trimmed;
}

export function compareTrackerRunsForMenuSort(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftRecord = left;
  const rightRecord = right;

  const leftRunDate = normalizeDateStrForSort(String(left.runDate ?? left.date ?? ''));
  const rightRunDate = normalizeDateStrForSort(String(right.runDate ?? right.date ?? ''));
  const runDateCompare = rightRunDate.localeCompare(leftRunDate);
  if (runDateCompare !== 0) return runDateCompare;

  const leftRunTime = String(left.runTime ?? left.time ?? '');
  const rightRunTime = String(right.runTime ?? right.time ?? '');
  const runTimeCompare = rightRunTime.localeCompare(leftRunTime);
  if (runTimeCompare !== 0) return runTimeCompare;

  const leftDate = normalizeDateStrForSort(String(left.date ?? left.runDate ?? ''));
  const rightDate = normalizeDateStrForSort(String(right.date ?? right.runDate ?? ''));
  const dateCompare = rightDate.localeCompare(leftDate);
  if (dateCompare !== 0) return dateCompare;

  const leftTime = String(left.time ?? left.runTime ?? '');
  const rightTime = String(right.time ?? right.runTime ?? '');
  const timeCompare = rightTime.localeCompare(leftTime);
  if (timeCompare !== 0) return timeCompare;

  return estimateTrackerRunTimestamp(rightRecord) - estimateTrackerRunTimestamp(leftRecord);
}

function comparePart1ForMenuSort(left: TrackerRunPartDocument, right: TrackerRunPartDocument): number {
  return compareTrackerRunsForMenuSort(left as Record<string, unknown>, right as Record<string, unknown>);
}

function resolveAnalyticsRunTimestamp(run: Record<string, unknown>): number {
  const gameDateTs = parseTrackerRunDateTimeTimestamp(run);
  if (gameDateTs > 0) return gameDateTs;
  return estimateTrackerRunTimestamp(run);
}

export function pickRecentRunsForMenuAnalytics(
  runs: Record<string, unknown>[],
  lastRun: Record<string, unknown> | null,
  lookbackMs = ANALYTICS_LOOKBACK_MS,
): Record<string, unknown>[] {
  const recentCutoff = Date.now() - lookbackMs;
  const recentRunsForAnalytics: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();

  for (const run of runs) {
    const id = String(run.runId ?? run.id ?? run.localId ?? '').trim();
    if (!id || seenIds.has(id)) {
      continue;
    }
    const ts = resolveAnalyticsRunTimestamp(run);
    if (ts < recentCutoff) {
      continue;
    }
    seenIds.add(id);
    recentRunsForAnalytics.push(run);
  }

  if (lastRun) {
    const lastId = String(lastRun.runId ?? lastRun.id ?? lastRun.localId ?? '').trim();
    if (lastId && !seenIds.has(lastId)) {
      recentRunsForAnalytics.push(lastRun);
    }
  }

  return recentRunsForAnalytics;
}

function isDeletedPart1(part1: TrackerRunPartDocument): boolean {
  return typeof part1.deletedAt === 'string' && part1.deletedAt.trim().length > 0;
}

async function loadPart2ByIdMap(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
): Promise<Map<string, TrackerRunPartDocument>> {
  const part2Docs = await db.run_part_2.find({ selector: buildScopeSelector(scopeUserId) }).exec();
  const extendedById = new Map<string, TrackerRunPartDocument>();
  for (const document of part2Docs) {
    const plainPart2 = toRunPartPlainDocument(document);
    if (plainPart2?.id) {
      extendedById.set(plainPart2.id, plainPart2);
    }
  }
  return extendedById;
}

function stitchPart1WithMap(
  part1: TrackerRunPartDocument | null,
  extendedById: Map<string, TrackerRunPartDocument>,
): Record<string, unknown> | null {
  if (!part1?.id || isDeletedPart1(part1)) {
    return null;
  }
  const plainPart1 = toRunPartPlainDocument(part1);
  if (!plainPart1) {
    return null;
  }
  const plainPart2 = extendedById.get(plainPart1.id) ?? null;
  const stitched = stitchTrackerRunCollections(plainPart1, plainPart2);
  if (!stitched || (typeof stitched.deletedAt === 'string' && stitched.deletedAt.trim().length > 0)) {
    return null;
  }
  return stitched;
}

/**
 * Menu-fast local summary: one part1 scan, part2 map load, stitch only last + recent window.
 * Avoids stitching the full run history on every menu open.
 */
export async function loadBotMenuRunSummary(userId: string): Promise<BotMenuRunSummary> {
  try {
    return await loadBotMenuRunSummaryFromRxDB(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('ensureNotFalsy')) {
      throw error;
    }
    logger.warn('[menu-summary] resetting corrupt RxDB cache after query failure', { userId, error });
    await destroySharedBotRunTrackerRxDatabase();
    return await loadBotMenuRunSummaryFromRxDB(userId);
  }
}

async function loadBotMenuRunSummaryFromRxDB(userId: string): Promise<BotMenuRunSummary> {
  const scopeUserId = normalizeScopeUserId(userId);
  await seedBotRunRxDBFromLegacyKvIfNeeded(scopeUserId);
  const db = await ensureBotRunTrackerRxDatabase(scopeUserId);

  const part1Docs = await db.run_part_1.find({ selector: buildScopeSelector(scopeUserId) }).exec();
  const part1Plain = part1Docs
    .map((document) => toRunPartPlainDocument(document))
    .filter((document): document is TrackerRunPartDocument => document !== null)
    .filter((document) => !isDeletedPart1(document));

  const runTypeCounts: Record<string, number> = {};
  for (const part1 of part1Plain) {
    const type = toCloudType(part1.type);
    runTypeCounts[type] = (runTypeCounts[type] ?? 0) + 1;
  }

  const sortedPart1 = [...part1Plain].sort(comparePart1ForMenuSort);
  const extendedById = await loadPart2ByIdMap(db, scopeUserId);
  const lastRun = stitchPart1WithMap(sortedPart1[0] ?? null, extendedById);

  const recentCutoff = Date.now() - ANALYTICS_LOOKBACK_MS;
  const recentRunsForAnalytics: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();

  for (const part1 of part1Plain) {
    const id = part1.id;
    if (!id || seenIds.has(id)) {
      continue;
    }
    const ts = resolveAnalyticsRunTimestamp(part1 as Record<string, unknown>);
    if (ts < recentCutoff) {
      continue;
    }
    const stitched = stitchPart1WithMap(part1, extendedById);
    if (!stitched) {
      continue;
    }
    seenIds.add(id);
    recentRunsForAnalytics.push(stitched);
  }

  if (lastRun) {
    const lastId = String(lastRun.runId ?? lastRun.id ?? lastRun.localId ?? '').trim();
    if (lastId && !seenIds.has(lastId)) {
      recentRunsForAnalytics.push(lastRun);
    }
  }

  return {
    totalRuns: part1Plain.length,
    lastRun,
    runTypeCounts,
    recentRunsForAnalytics,
  };
}
