import { Query } from 'node-appwrite';
import {
  fetchTrackerRunCloudDocumentCount,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { logger } from '../../core/logger';
import { getLocalRunCount, invalidateBotLocalRunsCache } from '../../rxdb/run-rxdb-store';
import {
  compareTrackerRunsForMenuSort,
  pickRecentRunsForMenuAnalytics,
} from '../../rxdb/run-menu-local-summary';
import { resolveBotRunCloudIdentity } from './run-cloud-identity';
import { fetchTrackerRunDeltasFromFunction } from './run-delta-function-client';
import { listBotStitchedRunCloudDocuments } from './run-cloud-pair-client';
import { ingestMergedRunsIntoBotStore } from './run-sync-ingest';
import { getLocalSettings } from './local-run-store';
import { getAppConfig } from '../../config';

const RUNS_DATABASE_ID = 'run-tracker-data';
const MENU_PRIME_FETCH_LIMIT = TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT;

export type MenuPrimedSummary = {
  totalRuns: number;
  lastRun: Record<string, unknown> | null;
  runTypeCounts: Record<string, number>;
  recentRunsForAnalytics: Record<string, unknown>[];
};

const menuCloudTotalCountByUser = new Map<string, number>();
const menuPrimedSummaryByUser = new Map<string, MenuPrimedSummary>();

export function peekMenuCloudTotalCountOverride(userId: string): number | undefined {
  return menuCloudTotalCountByUser.get(userId.trim());
}

export function peekMenuPrimedSummary(userId: string): MenuPrimedSummary | undefined {
  return menuPrimedSummaryByUser.get(userId.trim());
}

export function clearMenuCloudTotalCountOverride(userId: string): void {
  menuCloudTotalCountByUser.delete(userId.trim());
}

export function clearMenuPrimedSummary(userId: string): void {
  menuPrimedSummaryByUser.delete(userId.trim());
  clearMenuCloudTotalCountOverride(userId);
}

function isSoftDeletedRun(run: Record<string, unknown>): boolean {
  const deletedAt = run.deletedAt;
  return typeof deletedAt === 'string' && deletedAt.trim().length > 0;
}

async function fetchCloudRunTotalCount(lookupUserIds: string[]): Promise<number> {
  const { databases } = createAppwriteClient();
  let total = 0;

  for (const lookupUserId of lookupUserIds) {
    const count = await fetchTrackerRunCloudDocumentCount({
      databases,
      databaseId: RUNS_DATABASE_ID,
      collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
      userId: lookupUserId,
      buildUserCountQueries: (uid) => [Query.equal('userId', uid), Query.limit(1)],
    });
    total += count;
  }

  return total;
}

function buildRunTypeCounts(runs: Record<string, unknown>[]): Record<string, number> {
  const runTypeCounts: Record<string, number> = {};
  for (const run of runs) {
    const type = typeof run.type === 'string' && run.type.trim() ? run.type.trim() : 'Farming';
    runTypeCounts[type] = (runTypeCounts[type] ?? 0) + 1;
  }
  return runTypeCounts;
}

/**
 * Empty-local menu prime: cloud total count + stitched recent batch for last run / chart.
 * Ingests the batch locally but does not advance the full-sync cursor.
 */
export async function primeMenuCriticalRunsFromCloud(userId: string): Promise<MenuPrimedSummary | null> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return null;
  }

  const appConfig = getAppConfig();
  if (!appConfig.appwrite.apiKey?.trim()) {
    return null;
  }

  const identity = await resolveBotRunCloudIdentity(userId);
  const cloudUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? userId;

  const [cloudTotalCount, visibleRuns] = await Promise.all([
    fetchCloudRunTotalCount(identity.lookupUserIds),
    (async () => {
      try {
        const remote = await fetchTrackerRunDeltasFromFunction({
          userId,
          cloudUserId,
          lookupUserIds: identity.lookupUserIds,
          lastSyncedAtMs: 0,
          limit: MENU_PRIME_FETCH_LIMIT,
        });
        return remote.runs.filter(run => !isSoftDeletedRun(run));
      } catch (error) {
        logger.warn('[menu-prime] delta function failed; falling back to cloud pair batch', { userId, error });
        const stitched = await listBotStitchedRunCloudDocuments(userId);
        return stitched
          .slice(0, MENU_PRIME_FETCH_LIMIT)
          .filter(run => !isSoftDeletedRun(run));
      }
    })(),
  ]);

  if (visibleRuns.length === 0 && cloudTotalCount === 0) {
    clearMenuPrimedSummary(userId);
    return null;
  }

  const sortedRuns = [...visibleRuns].sort(compareTrackerRunsForMenuSort);
  const lastRun = sortedRuns[0] ?? null;
  const summary: MenuPrimedSummary = {
    totalRuns: cloudTotalCount > 0 ? cloudTotalCount : visibleRuns.length,
    lastRun,
    runTypeCounts: buildRunTypeCounts(sortedRuns),
    recentRunsForAnalytics: pickRecentRunsForMenuAnalytics(sortedRuns, lastRun),
  };

  menuPrimedSummaryByUser.set(userId.trim(), summary);
  if (cloudTotalCount > 0) {
    menuCloudTotalCountByUser.set(userId.trim(), cloudTotalCount);
  }

  logger.info('[menu-prime] cloud menu-critical data ready', {
    userId,
    cloudTotalCount,
    primedRuns: visibleRuns.length,
    hasLastRun: Boolean(lastRun),
    recentForAnalytics: summary.recentRunsForAnalytics.length,
    runTypeCounts: summary.runTypeCounts,
  });

  // Ingest after caching the menu snapshot so render never depends on a fragile local read.
  void ingestMergedRunsIntoBotStore(userId, visibleRuns, Date.now(), {
    persistSyncCursor: false,
  }).then(() => {
    invalidateBotLocalRunsCache(userId);
  }).catch((error) => {
    logger.warn('[menu-prime] deferred local ingest failed', { userId, error });
  });

  return summary;
}

export async function shouldPrimeMenuFromCloud(userId: string): Promise<boolean> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return false;
  }
  const localCount = await getLocalRunCount(userId).catch(() => 0);
  if (localCount === 0) {
    return true;
  }

  const cloudOverride = peekMenuCloudTotalCountOverride(userId);
  if (cloudOverride !== undefined && localCount < cloudOverride) {
    return true;
  }

  return false;
}
