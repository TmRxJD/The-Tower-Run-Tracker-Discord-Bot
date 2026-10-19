import { Permission, Query, Role, type Models } from 'node-appwrite';
import {
  buildTrackerRunDocumentPermissions,
  assertTrackerRunSubmission,
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
import { isNotFoundAppwriteError } from '../../persistence/appwrite-error-utils';
import { retireLocalOnlyBackupRun } from '../../rxdb/local-only-backup';
import { randomUUID } from 'node:crypto';
import { annotateHistoryFailure, getKnownHistoryFailure, historyFailureError, type HistoryFailureDiagnostic, type HistoryFailureStage } from './history-failure-diagnostic';

const RUNS_DATABASE_ID = 'run-tracker-data';
// Measured against a 1,360-run account: avoid 100-row round trips without unbounded requests.
const COMPLETE_HISTORY_MAIN_PAGE_SIZE = 500;
const COMPLETE_HISTORY_EXTENDED_CONCURRENCY = 4;

/** Read-only, all-or-nothing history for upload numbering and duplicate checks.
 * Unlike a menu prime, a short page is not evidence of a complete history.
 * Validate before ingestion; an error never becomes an empty account.
 */
export async function loadBotCompleteRunCloudDocuments(userId: string, options: { signal?: AbortSignal; includeExtended?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const correlation = randomUUID();
  const deadline = Date.now() + 45_000;
  for (let attempt = 0; ; attempt++) {
    try { return await loadCompleteHistoryAttempt(userId, deadline, correlation, options.signal, options.includeExtended !== false); }
    catch (error) {
      const failure = getKnownHistoryFailure(error);
      const retryable = failure?.cause === 'count_consistency'
        || failure?.cause === 'pagination' && failure.stage === 'main_page' && failure.pagination !== undefined;
      if (attempt !== 0 || !retryable
        || !['main_page', 'main_count'].includes(failure.stage) || Date.now() >= deadline || options.signal?.aborted) throw error;
      // Retry the entire verified read, never pages from different observations.
    }
  }
}

async function loadCompleteHistoryAttempt(userId: string, deadline: number, correlation: ReturnType<typeof randomUUID>, signal?: AbortSignal, includeExtended = true): Promise<Record<string, unknown>[]> {
  let stage: HistoryFailureStage = 'identity';
  const failure = (cause: Parameters<typeof historyFailureError>[1], message: string) => historyFailureError(message, cause, stage, correlation);
  try {
    const checkDeadline = () => {
      if (signal?.aborted) throw failure('unknown', 'Run history lookup cancelled.');
      if (Date.now() >= deadline) throw failure('timeout', 'Run history lookup timed out. Please retry.');
    };
    checkDeadline();
    const { databases } = createAppwriteClient();
    const identity = await resolveBotRunCloudIdentity(userId);
    checkDeadline();
    if (!identity.lookupUserIds.length) throw failure('identity', 'Run history identity is unavailable. Please retry.');
    const documents = new Map<string, Record<string, unknown>>();
    const ownerIdsToRead = [...new Set(identity.lookupUserIds)];
    // Linked and legacy owners are independent. Keep at most two requests active,
    // and drain a failed wave before retrying the whole verified observation.
    for (let wave = 0; wave < ownerIdsToRead.length; wave += 2) {
      const ownerResults = await Promise.allSettled(ownerIdsToRead.slice(wave, wave + 2).map(async ownerId => {
        const ownerDocuments = new Map<string, Record<string, unknown>>();
        let ownerStage: HistoryFailureStage = 'main_page';
        const failure = (cause: Parameters<typeof historyFailureError>[1], message: string, details: Pick<HistoryFailureDiagnostic, 'pagination'> = {}) => historyFailureError(message, cause, ownerStage, correlation, details);
        const checkDeadline = () => {
          if (signal?.aborted) throw failure('unknown', 'Run history lookup cancelled.');
          if (Date.now() >= deadline) throw failure('timeout', 'Run history lookup timed out. Please retry.');
        };
        try {
          let cursor: string | null = null;
          let expectedTotal: number | null = null;
          const ownerIds = new Set<string>();
          let pageIndex = 0;
          for (;;) {
            ownerStage = 'main_page';
            checkDeadline();
            const page: Models.DocumentList<Models.Document & { userId?: unknown }> = await databases.listDocuments(RUNS_DATABASE_ID, TRACKER_RUN_MAIN_COLLECTION_ID, [
              ...buildBotRunCloudUserIdQueries(ownerId, cursor, COMPLETE_HISTORY_MAIN_PAGE_SIZE),
              Query.orderAsc('$id'),
            ]);
            checkDeadline();
            pageIndex++;
            if (!Array.isArray(page.documents) || !Number.isSafeInteger(page.total) || page.total < 0
              || (expectedTotal !== null && expectedTotal !== page.total)) {
              throw failure(!Array.isArray(page.documents) || !Number.isSafeInteger(page.total) || page.total < 0 ? 'schema' : 'count_consistency', 'Run history changed or could not be verified. Please retry.');
            }
            expectedTotal = page.total;
            for (const raw of page.documents) {
              const parsed = trackerRunCloudDocumentReadSchema.safeParse(raw);
              if (!parsed.success || raw.userId !== ownerId || !raw.$id || ownerIds.has(raw.$id)) {
                throw failure(!parsed.success || !raw.$id ? 'schema' : raw.userId !== ownerId ? 'ownership' : 'pagination', 'Run history contains an unreadable or repeated record. Please retry.');
              }
              ownerIds.add(raw.$id);
              ownerDocuments.set(raw.$id, parsed.data);
            }
            if (ownerIds.size === expectedTotal) break;
            if (!page.documents.length || ownerIds.size > expectedTotal) {
              throw failure('pagination', 'Run history is incomplete. Please retry.', { pagination: {
                reason: ownerIds.size > expectedTotal ? 'records_exceed_total' : 'empty_before_total',
                pageIndex, returnedCount: page.documents.length, collectedCount: ownerIds.size, expectedTotal,
              } });
            }
            cursor = page.documents[page.documents.length - 1].$id;
          }
          // Detect concurrent additions/deletions after the last page, before trusting counts.
          ownerStage = 'main_count';
          checkDeadline();
          const check = await databases.listDocuments(RUNS_DATABASE_ID, TRACKER_RUN_MAIN_COLLECTION_ID, [
            Query.equal('userId', ownerId), Query.limit(1), Query.select(['$id']),
          ]);
          checkDeadline();
          if (check.total !== expectedTotal) throw failure('count_consistency', 'Run history changed. Please retry.');
          return ownerDocuments;
        } catch (error) { throw annotateHistoryFailure(error, ownerStage, correlation); }
      }));
      const failedOwner = ownerResults.find(result => result.status === 'rejected');
      if (failedOwner?.status === 'rejected') throw failedOwner.reason;
      for (const result of ownerResults) {
        if (result.status === 'fulfilled') for (const [id, document] of result.value) documents.set(id, document);
      }
    }
    const mainDocuments = [...documents.values()];
    // Duplicate review uses only main-record identity fields; never fetch unused statistics.
    if (!includeExtended) return mainDocuments;
    const extendedDocuments: Record<string, unknown>[] = [];
    // Complete bot history already verified the owning main records. Query their
    // exact IDs in bulk rather than issuing one extended GET per historical run.
    const ids = [...documents.keys()];
    const offsets = Array.from({ length: Math.ceil(ids.length / TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE) }, (_, i) => i * TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE);
    for (let wave = 0; wave < offsets.length; wave += COMPLETE_HISTORY_EXTENDED_CONCURRENCY) {
      // Drain the current wave on failure before releasing the coalesced history read.
      // Later waves never start after failure, cancellation, or the shared deadline.
      const results = await Promise.allSettled(offsets.slice(wave, wave + COMPLETE_HISTORY_EXTENDED_CONCURRENCY).map(async offset => {
        const batch = ids.slice(offset, offset + TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE);
        const requested = new Set(batch);
        const seen = new Set<string>();
        let cursor: string | null = null;
        let expectedTotal: number | null = null;
        for (;;) {
          stage = 'extended_page';
          checkDeadline();
          const page: Models.DocumentList<Models.Document> = await databases.listDocuments(RUNS_DATABASE_ID, TRACKER_RUN_EXTENDED_COLLECTION_ID, [
            Query.equal('$id', batch), Query.limit(TRACKER_RUN_CLOUD_PAIR_PAGE_SIZE), Query.orderAsc('$id'),
            ...(cursor ? [Query.cursorAfter(cursor)] : []),
          ]);
          checkDeadline();
          if (!Array.isArray(page.documents) || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > batch.length
            || (expectedTotal !== null && expectedTotal !== page.total)) throw failure(!Array.isArray(page.documents) || !Number.isSafeInteger(page.total) || page.total < 0 ? 'schema' : 'count_consistency', 'Extended run history could not be verified. Please retry.');
          expectedTotal = page.total;
          for (const raw of page.documents) {
            const parsed = parseTrackerRunExtendedDocumentRecord(raw);
            const id = parsed ? resolveTrackerRunCloudDocumentId(parsed) : null;
            if (!parsed || !id || !requested.has(id) || seen.has(id)) throw failure(!parsed || !id ? 'schema' : 'pagination', 'Extended run history contains an unreadable or repeated record. Please retry.');
            const main = documents.get(id)!;
            if (parsed.userId !== undefined && parsed.userId !== main.userId) throw failure('ownership', 'Extended run history ownership could not be verified. Please retry.');
            if (parsed.profileId !== undefined && (parsed.profileId || null) !== (main.profileId || null)) throw failure('ownership', 'Extended run history profile could not be verified. Please retry.');
            seen.add(id); extendedDocuments.push(parsed);
          }
          if (seen.size === expectedTotal) break;
          if (!page.documents.length || seen.size > expectedTotal) throw failure('pagination', 'Extended run history is incomplete. Please retry.');
          cursor = page.documents[page.documents.length - 1].$id;
        }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    stage = 'stitch';
    checkDeadline();
    return stitchTrackerRunCloudLoadDocuments({ mainDocuments, extendedDocuments }).stitchedDocuments;
  } catch (error) { throw annotateHistoryFailure(error, stage, correlation); }
}


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
  uploadProfileId?: string | null;
}): Promise<{ mainWritten: boolean; extendedWritten: boolean }> {
  const { databases } = createAppwriteClient();
  const identity = await resolveBotRunCloudIdentity(params.userId);
  const ownerUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? params.userId;
  let uploadProfileId = params.uploadProfileId;
  // Authorization belongs at the bot boundary. A missing target on an old queued
  // entry never authorizes guessing Main; only a verified existing run may update.
  try {
    const existing = await databases.getDocument(RUNS_DATABASE_ID, TRACKER_RUN_MAIN_COLLECTION_ID, params.runId);
    if (!identity.lookupUserIds.includes(String(existing.userId ?? ''))) throw new Error('Run owner does not match this Discord account.');
    uploadProfileId = typeof existing.profileId === 'string' && existing.profileId.trim() ? existing.profileId.trim() : null;
  } catch (error) {
    if (!isNotFoundAppwriteError(error)) throw error;
    if (uploadProfileId === undefined) throw new Error('Queued new run needs an explicit target profile; entry retained.');
    assertTrackerRunSubmission(params.run);
  }
  const permissions = buildTrackerRunDocumentPermissions({
    userIds: identity.permissionUserIds,
    permissionFactory: Permission,
    roleFactory: Role,
  });

  const result = await writeTrackerRunCloudDocumentPair({
    databases,
    databaseId: RUNS_DATABASE_ID,
    mainCollectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    extendedCollectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
    runId: params.runId,
    userId: ownerUserId,
    username: params.username,
    run: params.run,
    permissions,
    // Target profile for this /track upload (null = Main). NEW runs take it; the
    // pair-writer never re-stamps an existing run, so a Main run is never moved.
    profileId: uploadProfileId,
  });
  await retireLocalOnlyBackupRun(params.userId, params.run.localId);
  return result;
}
