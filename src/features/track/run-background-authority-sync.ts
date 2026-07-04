import { Query } from 'node-appwrite';
import {
  buildTrackerResolvedRunReference,
  evaluateTrackerCloudRunAuthority,
  fetchTrackerRunCloudDocumentCount,
  hydrateTrackerCloudRun,
  hydrateTrackerRunEntryFromDocument,
  reconcileTrackerRunIds,
  TRACKER_RUN_MAIN_COLLECTION_ID,
} from '@tmrxjd/platform/tools';
import { ID } from 'node-appwrite';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { logger } from '../../core/logger';
import { getLocalRunCount, invalidateBotLocalRunsCache } from '../../rxdb/run-rxdb-store';
import { resolveBotRunCloudIdentity } from './run-cloud-identity';
import {
  bulkUpsertLocalRuns,
  getLocalRuns,
  getLocalSettings,
  getQueueItems,
  removeLocalRun,
} from './local-run-store';
import { fetchBotStitchedRunCloudDocumentsByIds } from './run-cloud-pair-client';
import { bulkImportAllRunsFromCloud, syncUserRunDeltaPageForMenu } from './run-delta-sync';
import { clearMenuPrimedSummary } from './run-menu-cloud-prime';
import {
  filterOutTombstonedRunIds,
  filterOutTombstonedRuns,
  getPermanentlyDeletedRunIds,
} from './run-deletion-tombstones';
import { getAppConfig } from '../../config';

const RUNS_DATABASE_ID = 'run-tracker-data';
const RUN_DOCUMENTS_PAGE_SIZE = 500;
const IMPORT_BATCH = 100;

type RunRecord = Record<string, unknown>;

const backgroundAuthoritySyncByUser = new Map<string, Promise<void>>();

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function collectLocalCloudRunIds(localRuns: RunRecord[]): Set<string> {
  const localIds = new Set<string>();
  for (const run of localRuns) {
    const reference = buildTrackerResolvedRunReference({ runData: run });
    if (reference.runId) {
      localIds.add(reference.runId);
    }
  }
  return localIds;
}

function collectPendingQueueIds(userId: string, queueItems: Awaited<ReturnType<typeof getQueueItems>>) {
  const pendingUploadIds = new Set<string>();
  const pendingDeleteIds = new Set<string>();
  for (const item of queueItems) {
    const runId = pickString(item.runId);
    if (!runId) continue;
    if (item.op === 'upsert') pendingUploadIds.add(runId);
    if (item.op === 'delete') pendingDeleteIds.add(runId);
  }
  return { pendingUploadIds, pendingDeleteIds };
}

async function fetchCloudRunIdManifest(userId: string, lookupUserIds: string[]) {
  const { databases } = createAppwriteClient();
  const localRuns = await getLocalRuns(userId);
  const localIds = collectLocalCloudRunIds(localRuns as RunRecord[]);
  const queueItems = await getQueueItems(userId);
  const tombstones = await getPermanentlyDeletedRunIds(userId);
  const { pendingUploadIds, pendingDeleteIds } = collectPendingQueueIds(userId, queueItems);

  for (const runId of tombstones) {
    pendingDeleteIds.add(runId);
  }

  let reportedCloudCount = 0;
  let requestSucceeded = true;
  let paginationIncomplete = false;

  for (const lookupUserId of lookupUserIds) {
    try {
      const count = await fetchTrackerRunCloudDocumentCount({
        databases,
        databaseId: RUNS_DATABASE_ID,
        collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
        userId: lookupUserId,
        buildUserCountQueries: (uid) => [Query.equal('userId', uid), Query.limit(1)],
      });
      reportedCloudCount += count;
    } catch (error) {
      requestSucceeded = false;
      logger.warn('[authority-sync] cloud count query failed', { userId, lookupUserId, error });
    }
  }

  let reconcileResult = {
    allCloudIds: new Set<string>(),
    localOnlyIds: [] as string[],
    cloudOnlyIds: [] as string[],
  };

  try {
    reconcileResult = await reconcileTrackerRunIds({
      databases,
      databaseId: RUNS_DATABASE_ID,
      collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
      userIds: lookupUserIds,
      pageSize: RUN_DOCUMENTS_PAGE_SIZE,
      localIds,
      pendingUploadIds,
      pendingDeleteIds,
      buildQueries: (uid, cursorAfter, pageSize) => [
        Query.equal('userId', uid),
        Query.select(['$id']),
        Query.limit(pageSize),
        ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
      ],
    });
  } catch (error) {
    requestSucceeded = false;
    logger.warn('[authority-sync] cloud id reconcile failed', { userId, error });
  }

  const cloudIds = Array.from(reconcileResult.allCloudIds);
  if (
    requestSucceeded
    && reportedCloudCount > 0
    && cloudIds.length < reportedCloudCount
  ) {
    paginationIncomplete = true;
  }

  return {
    requestSucceeded,
    cloudIds,
    reportedCloudCount,
    localCloudBackedCount: localIds.size,
    paginationIncomplete,
    localOnlyIds: reconcileResult.localOnlyIds,
    cloudOnlyIds: filterOutTombstonedRunIds(reconcileResult.cloudOnlyIds, tombstones),
    localIds,
  };
}

async function importCloudOnlyRunIds(
  userId: string,
  cloudOnlyIds: string[],
  ownerUserId: string,
): Promise<number> {
  if (cloudOnlyIds.length === 0) {
    return 0;
  }

  const localRuns = (await getLocalRuns(userId)) as RunRecord[];
  const defaultUsername = pickString(localRuns[0]?.username) ?? 'unknown';
  const importedDocs: RunRecord[] = [];

  for (let i = 0; i < cloudOnlyIds.length; i += IMPORT_BATCH) {
    const batchIds = cloudOnlyIds.slice(i, i + IMPORT_BATCH);
    try {
      const stitched = await fetchBotStitchedRunCloudDocumentsByIds(batchIds);
      importedDocs.push(...stitched as RunRecord[]);
    } catch (error) {
      logger.warn('[authority-sync] batch import fetch failed', { userId, batchStart: i, error });
    }
  }

  const tombstones = await getPermanentlyDeletedRunIds(userId);
  const filteredDocs = filterOutTombstonedRuns(importedDocs, tombstones);
  if (filteredDocs.length === 0) {
    return 0;
  }

  const hydratedImports = filteredDocs.map(doc => {
    const entry = hydrateTrackerRunEntryFromDocument(doc, { fallbackId: ID.unique() }) as RunRecord;
    const username = pickString(doc.username) ?? defaultUsername;
    return hydrateTrackerCloudRun(entry, ownerUserId, username) as RunRecord;
  });

  const { added, updated } = await bulkUpsertLocalRuns(
    userId,
    hydratedImports.map(run => ({
      username: pickString(run.username) ?? defaultUsername,
      runData: run,
    })),
  );

  return added + updated;
}

/**
 * Canonical background sync pipeline.
 * Never blocks UI. Deletes locally only when cloud authority is verified.
 */
export async function runBackgroundAuthoritySync(userId: string): Promise<void> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return;
  }

  const appConfig = getAppConfig();
  if (!appConfig.appwrite.apiKey?.trim()) {
    return;
  }

  const identity = await resolveBotRunCloudIdentity(userId);
  const localRunCount = await getLocalRunCount(userId);
  let reportedCloudCount = 0;
  const { databases } = createAppwriteClient();

  for (const lookupUserId of identity.lookupUserIds) {
    try {
      reportedCloudCount += await fetchTrackerRunCloudDocumentCount({
        databases,
        databaseId: RUNS_DATABASE_ID,
        collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
        userId: lookupUserId,
        buildUserCountQueries: (uid) => [Query.equal('userId', uid), Query.limit(1)],
      });
    } catch (error) {
      logger.warn('[authority-sync] cloud count query failed before bulk import', { userId, lookupUserId, error });
    }
  }

  const needsBulkImport = localRunCount === 0
    || (reportedCloudCount > 0 && localRunCount < reportedCloudCount);

  let bulkSucceeded = false;
  if (needsBulkImport) {
    const bulk = await bulkImportAllRunsFromCloud(userId).catch((error) => {
      logger.warn('[authority-sync] bulk import failed', { userId, error });
      return { totalImported: 0, lastSyncedAtMs: 0, success: false };
    });
    bulkSucceeded = bulk.success;
    if (bulk.totalImported > 0) {
      invalidateBotLocalRunsCache(userId);
    }
    if (bulk.success) {
      clearMenuPrimedSummary(userId);
    }
    logger.info('[authority-sync] bulk import', {
      userId,
      localRunCount,
      reportedCloudCount,
      totalImported: bulk.totalImported,
      lastSyncedAtMs: bulk.lastSyncedAtMs,
      success: bulk.success,
    });
  }

  if (!bulkSucceeded) {
    await syncUserRunDeltaPageForMenu(userId).catch((error) => {
      logger.warn('[authority-sync] delta page failed', { userId, error });
    });
  }

  const manifest = await fetchCloudRunIdManifest(userId, identity.lookupUserIds);
  const authority = evaluateTrackerCloudRunAuthority({
    requestSucceeded: manifest.requestSucceeded,
    cloudIds: manifest.cloudIds,
    reportedCloudCount: manifest.reportedCloudCount,
    localCloudBackedCount: manifest.localCloudBackedCount,
    paginationIncomplete: manifest.paginationIncomplete,
  });

  if (!authority.isAuthoritative) {
    logger.warn('[authority-sync] cloud authority false — skipping local deletes', {
      userId,
      reasons: authority.reasons,
      cloudIds: manifest.cloudIds.length,
      reportedCloudCount: manifest.reportedCloudCount,
      localCloudBackedCount: manifest.localCloudBackedCount,
    });

    if (manifest.cloudOnlyIds.length > 0 && manifest.cloudIds.length > 0) {
      const imported = await importCloudOnlyRunIds(
        userId,
        manifest.cloudOnlyIds,
        identity.cloudWriteUserId ?? identity.activeUserId ?? userId,
      );
      if (imported > 0) {
        invalidateBotLocalRunsCache(userId);
      }
      logger.info('[authority-sync] imported cloud-only runs without authority delete', { userId, imported });
    }
    return;
  }

  let deleted = 0;
  for (const runId of manifest.localOnlyIds) {
    try {
      await removeLocalRun(userId, runId);
      deleted += 1;
    } catch (error) {
      logger.warn('[authority-sync] verified local delete failed', { userId, runId, error });
    }
  }

  const imported = await importCloudOnlyRunIds(
    userId,
    manifest.cloudOnlyIds,
    identity.cloudWriteUserId ?? identity.activeUserId ?? userId,
  );

  if (deleted > 0 || imported > 0) {
    invalidateBotLocalRunsCache(userId);
  }

  logger.info('[authority-sync] verified reconcile complete', {
    userId,
    deleted,
    imported,
    cloudCount: manifest.cloudIds.length,
  });
}

export function beginBackgroundAuthoritySync(userId: string): void {
  if (backgroundAuthoritySyncByUser.has(userId)) {
    return;
  }

  const task = runBackgroundAuthoritySync(userId)
    .catch((error) => {
      logger.warn('[authority-sync] background sync failed', { userId, error });
    })
    .finally(() => {
      backgroundAuthoritySyncByUser.delete(userId);
    });

  backgroundAuthoritySyncByUser.set(userId, task);
}

export async function awaitBackgroundAuthoritySync(userId: string): Promise<void> {
  const task = backgroundAuthoritySyncByUser.get(userId);
  if (!task) {
    return;
  }
  await task;
}
