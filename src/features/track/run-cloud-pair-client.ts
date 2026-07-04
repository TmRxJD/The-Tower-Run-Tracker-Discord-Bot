import { Permission, Query, Role } from 'node-appwrite';
import {
  buildTrackerRunDocumentPermissions,
  fetchTrackerRunCloudDocumentsByIds,
  loadTrackerRunCloudDocumentPairBatch,
  parseTrackerRunExtendedDocumentRecord,
  resolveTrackerRunCloudDocumentId,
  stitchTrackerRunCloudLoadDocuments,
  TRACKER_RUN_CLOUD_PAIR_BY_ID_BATCH_SIZE,
  TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE,
  TRACKER_RUN_EXTENDED_COLLECTION_ID,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  trackerRunCloudDocumentReadSchema,
  writeTrackerRunCloudDocumentPair,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { resolveBotRunCloudIdentity } from './run-cloud-identity';

const RUNS_DATABASE_ID = 'run-tracker-data';

export function buildBotRunCloudUserIdQueries(
  userId: string,
  cursorAfter: string | null,
  pageSize: number,
): string[] {
  return [
    Query.equal('userId', userId),
    Query.limit(pageSize),
    ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
  ];
}

export async function loadBotRunCloudDocumentPairBatch(userId: string) {
  const { databases } = createAppwriteClient();
  const identity = await resolveBotRunCloudIdentity(userId);

  return loadTrackerRunCloudDocumentPairBatch({
    databases,
    databaseId: RUNS_DATABASE_ID,
    mainCollectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    extendedCollectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
    userIds: identity.lookupUserIds,
    pageSize: TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE,
    buildQueries: buildBotRunCloudUserIdQueries,
  });
}

export async function listBotStitchedRunCloudDocuments(userId: string): Promise<Record<string, unknown>[]> {
  const batch = await loadBotRunCloudDocumentPairBatch(userId);
  return batch.stitchedDocuments;
}

/** Same merge path as platform pair batch: listed extended + by-id fallback, then stitch. */
export async function stitchBotCloudRunsWithExtendedFallback(
  mainDocuments: ReadonlyArray<Record<string, unknown>>,
  listedExtendedDocuments: ReadonlyArray<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  if (mainDocuments.length === 0) {
    return [];
  }

  const { databases } = createAppwriteClient();
  const extendedById = new Map<string, Record<string, unknown>>();
  for (const doc of listedExtendedDocuments) {
    const runId = resolveTrackerRunCloudDocumentId(doc);
    if (runId) {
      extendedById.set(runId, doc);
    }
  }

  const missingExtendedRunIds = mainDocuments
    .map(doc => resolveTrackerRunCloudDocumentId(doc))
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0)
    .filter(runId => !extendedById.has(runId));

  if (missingExtendedRunIds.length > 0) {
    const fallbackExtendedDocuments = await fetchTrackerRunCloudDocumentsByIds({
      databases,
      databaseId: RUNS_DATABASE_ID,
      collectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
      runIds: missingExtendedRunIds,
      batchSize: TRACKER_RUN_CLOUD_PAIR_BY_ID_BATCH_SIZE,
      parseDocument: raw => parseTrackerRunExtendedDocumentRecord(raw),
    });
    for (const doc of fallbackExtendedDocuments) {
      const runId = resolveTrackerRunCloudDocumentId(doc);
      if (runId) {
        extendedById.set(runId, doc);
      }
    }
  }

  return stitchTrackerRunCloudLoadDocuments({
    mainDocuments: [...mainDocuments],
    extendedDocuments: Array.from(extendedById.values()),
  }).stitchedDocuments;
}

export async function fetchBotStitchedRunCloudDocumentsByIds(
  runIds: ReadonlyArray<string>,
): Promise<Record<string, unknown>[]> {
  const uniqueIds = Array.from(new Set(
    runIds.map(id => id.trim()).filter(id => id.length > 0),
  ));
  if (!uniqueIds.length) {
    return [];
  }

  const { databases } = createAppwriteClient();
  const mainDocuments = await fetchTrackerRunCloudDocumentsByIds({
    databases,
    databaseId: RUNS_DATABASE_ID,
    collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    runIds: uniqueIds,
    batchSize: TRACKER_RUN_CLOUD_PAIR_BY_ID_BATCH_SIZE,
    parseDocument: raw => {
      const parsed = trackerRunCloudDocumentReadSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
  });

  return stitchBotCloudRunsWithExtendedFallback(mainDocuments, []);
}

export async function writeBotRunCloudDocumentPair(params: {
  userId: string;
  username: string;
  runId: string;
  run: Record<string, unknown>;
}): Promise<{ mainWritten: boolean; extendedWritten: boolean }> {
  const { databases } = createAppwriteClient();
  const identity = await resolveBotRunCloudIdentity(params.userId);
  const ownerUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? params.userId;
  const permissions = buildTrackerRunDocumentPermissions({
    userIds: identity.permissionUserIds,
    permissionFactory: Permission,
    roleFactory: Role,
  });

  return writeTrackerRunCloudDocumentPair({
    databases,
    databaseId: RUNS_DATABASE_ID,
    mainCollectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    extendedCollectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
    runId: params.runId,
    userId: ownerUserId,
    username: params.username,
    run: params.run,
    permissions,
  });
}
