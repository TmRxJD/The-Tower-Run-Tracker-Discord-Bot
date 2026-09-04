import {

  splitTrackerRunForCollections,

  stitchTrackerRunCollections,

  trackerRunReferencesSameEntry,

  withTrackerRunUpdatedAtEpoch,

} from '@tmrxjd/platform/tools';

import { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } from './bot-run-schemas';
import { toRunPartPlainDocument } from './run-part-documents';

import type { BotRunTrackerRxDatabase } from './init-database';

import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';



function normalizeScopeUserId(scopeUserId: string): string {

  const normalized = scopeUserId.trim();

  if (!normalized) {

    throw new Error('Bot run RxDB scope user id is required.');

  }

  return normalized;

}



function stampBotScopeUserId(

  scopeUserId: string,

  document: TrackerRunPartDocument,

): TrackerRunPartDocument {

  return {

    ...document,

    [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: normalizeScopeUserId(scopeUserId),

  };

}



function buildScopeSelector(scopeUserId: string) {

  return {

    [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: normalizeScopeUserId(scopeUserId),

  };

}



/**
 * The localstorage storage engine writes each document with a synchronous fs call and
 * rewrites every index of the collection per bulkWrite, so one large bulkUpsert blocks the
 * event loop for as long as it takes — measured at ~13s for 3200 documents. Nothing else
 * runs during that, including another user's deferReply(), which Discord abandons after
 * ~3s with "Unknown interaction" (10062).
 *
 * Splitting the write bounds how long any single burst can hold the loop. The batch size is
 * a trade: smaller means shorter stalls but more index rewrites, since each bulkWrite
 * re-serialises every index of the collection.
 */
const BULK_UPSERT_CHUNK_SIZE = 50;

function chunkDocuments<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Hand the loop back so queued interactions can be acknowledged between chunks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

export async function batchUpsertRunPartsToBotRxDB(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
  part1Documents: TrackerRunPartDocument[],
  part2Documents: TrackerRunPartDocument[],
): Promise<void> {
  if (part1Documents.length === 0 && part2Documents.length === 0) {
    return;
  }

  const part1Chunks = chunkDocuments(
    part1Documents.map((doc) => stampBotScopeUserId(scopeUserId, doc)),
    BULK_UPSERT_CHUNK_SIZE,
  );
  const part2Chunks = chunkDocuments(
    part2Documents.map((doc) => stampBotScopeUserId(scopeUserId, doc)),
    BULK_UPSERT_CHUNK_SIZE,
  );

  // Sequential, not Promise.all: the storage engine is synchronous, so writing both
  // collections "concurrently" only runs two blocking bursts back to back with no yield.
  const batches = Math.max(part1Chunks.length, part2Chunks.length);
  for (let index = 0; index < batches; index += 1) {
    const part1Chunk = part1Chunks[index];
    if (part1Chunk && part1Chunk.length > 0) {
      await db.run_part_1.bulkUpsert(part1Chunk);
      await yieldToEventLoop();
    }
    const part2Chunk = part2Chunks[index];
    if (part2Chunk && part2Chunk.length > 0) {
      await db.run_part_2.bulkUpsert(part2Chunk);
      await yieldToEventLoop();
    }
  }
}



export async function upsertMergedRunsToBotRxDB(

  db: BotRunTrackerRxDatabase,

  scopeUserId: string,

  mergedRuns: Record<string, unknown>[],

): Promise<void> {

  if (mergedRuns.length === 0) {

    return;

  }



  const part1Documents: TrackerRunPartDocument[] = [];

  const part2Documents: TrackerRunPartDocument[] = [];



  for (const run of mergedRuns) {

    const { fieldsForPart1, fieldsForPart2 } = splitTrackerRunForCollections(

      withTrackerRunUpdatedAtEpoch(run),

    );

    part1Documents.push(fieldsForPart1 as TrackerRunPartDocument);

    part2Documents.push(fieldsForPart2 as TrackerRunPartDocument);

  }



  await batchUpsertRunPartsToBotRxDB(db, scopeUserId, part1Documents, part2Documents);

}



export async function loadStitchedRunsFromBotRxDB(

  db: BotRunTrackerRxDatabase,

  scopeUserId: string,

): Promise<Record<string, unknown>[]> {

  const selector = buildScopeSelector(scopeUserId);

  const [part1Docs, part2Docs] = await Promise.all([

    db.run_part_1.find({ selector }).exec(),

    db.run_part_2.find({ selector }).exec(),

  ]);



  const extendedById = new Map<string, TrackerRunPartDocument>();

  for (const document of part2Docs) {
    const plainPart2 = toRunPartPlainDocument(document);
    if (plainPart2?.id) {
      extendedById.set(plainPart2.id, plainPart2);
    }
  }

  const runs: Record<string, unknown>[] = [];

  for (const part1 of part1Docs) {
    const plainPart1 = toRunPartPlainDocument(part1);
    const plainPart2 = plainPart1?.id ? extendedById.get(plainPart1.id) ?? null : null;
    const stitched = stitchTrackerRunCollections(plainPart1, plainPart2);

    if (!stitched) continue;

    if (typeof stitched.deletedAt === 'string' && stitched.deletedAt.trim().length > 0) {

      continue;

    }

    runs.push(stitched);

  }



  return runs;

}



export async function countRunsInBotRxDB(

  db: BotRunTrackerRxDatabase,

  scopeUserId: string,

): Promise<number> {

  const docs = await db.run_part_1.find({ selector: buildScopeSelector(scopeUserId) }).exec().catch(() => []);
  return docs.length;

}

export async function getMaxUpdatedAtMsForBotScopeUser(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
): Promise<number> {
  const docs = await db.run_part_1.find({ selector: buildScopeSelector(scopeUserId) }).exec().catch(() => []);
  let maxUpdatedAtMs = 0;
  for (const doc of docs) {
    const updatedAt = Number(doc.updatedAt);
    if (Number.isFinite(updatedAt) && updatedAt > maxUpdatedAtMs) {
      maxUpdatedAtMs = updatedAt;
    }
  }
  return maxUpdatedAtMs;
}

function resolveRunDocumentId(reference: { runId?: string; localId?: string }): string | null {

  const runId = typeof reference.runId === 'string' ? reference.runId.trim() : '';

  if (runId) return runId;

  const localId = typeof reference.localId === 'string' ? reference.localId.trim() : '';

  return localId || null;

}



export async function removeRunFromBotRxDB(

  db: BotRunTrackerRxDatabase,

  scopeUserId: string,

  reference: { runId?: string; localId?: string },

): Promise<boolean> {

  const stitchedRuns = await loadStitchedRunsFromBotRxDB(db, scopeUserId);

  const target = stitchedRuns.find((run) => trackerRunReferencesSameEntry({

    left: reference,

    right: {

      runId: typeof run.runId === 'string' ? run.runId : undefined,

      localId: typeof run.localId === 'string' ? run.localId : undefined,

    },

  }));



  const docId = target

    ? resolveRunDocumentId({

        runId: typeof target.runId === 'string' ? target.runId : undefined,

        localId: typeof target.localId === 'string' ? target.localId : undefined,

      })

    : resolveRunDocumentId(reference);



  if (!docId) {

    return false;

  }



  const selector = {

    ...buildScopeSelector(scopeUserId),

    id: docId,

  };



  await Promise.all([

    db.run_part_1.findOne({ selector }).remove().catch(() => null),

    db.run_part_2.findOne({ selector }).remove().catch(() => null),

  ]);



  return true;

}


