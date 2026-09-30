import {
  splitTrackerRunForCollections,
  stitchTrackerRunCollections,
  trackerRunReferencesSameEntry,
  withTrackerRunUpdatedAtEpoch,
} from '@tmrxjd/platform/tools';

import { forEachChunkYielding } from '../utils/event-loop';
import { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } from './bot-run-schemas';
import { toRunPartPlainDocument } from './run-part-documents';

import type { BotRunTrackerRxDatabase } from './init-database';

import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

/**
 * Documents written per storage call. The localstorage engine does synchronous file I/O
 * and rewrites whole index blobs per call, and RxDB's promise chain never yields to the
 * event loop mid-call, so one large bulkUpsert froze the bot for seconds (7.2s measured
 * for a 1,359-run import). Small slices bound each stall; the loop is serviced between them.
 */
export const RXDB_UPSERT_CHUNK_SIZE = 25;

type RunWriteListener = (scopeUserId: string) => void;
let runWriteListener: RunWriteListener | null = null;

/** Notified after a user's runs are written or removed (used to back up local-only users). */
export function setBotRunWriteListener(listener: RunWriteListener | null): void {
  runWriteListener = listener;
}

function notifyRunWrite(scopeUserId: string): void {
  try {
    runWriteListener?.(scopeUserId);
  } catch {
    // A listener must never fail the write it observes.
  }
}

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

export async function batchUpsertRunPartsToBotRxDB(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
  part1Documents: TrackerRunPartDocument[],
  part2Documents: TrackerRunPartDocument[],
): Promise<void> {
  if (part1Documents.length === 0 && part2Documents.length === 0) {
    return;
  }

  const stampedPart1 = part1Documents.map((doc) => stampBotScopeUserId(scopeUserId, doc));
  const stampedPart2 = part2Documents.map((doc) => stampBotScopeUserId(scopeUserId, doc));

  // Slice by index so a run's two parts land in the same pass and a partial write stays as
  // close to consistent as the previous single-call version.
  const indexes = Array.from({ length: Math.max(stampedPart1.length, stampedPart2.length) }, (_, index) => index);
  await forEachChunkYielding(indexes, RXDB_UPSERT_CHUNK_SIZE, async (chunk) => {
    const first = chunk[0];
    const end = chunk[chunk.length - 1] + 1;
    await Promise.all([
      db.run_part_1.bulkUpsert(stampedPart1.slice(first, end)),
      db.run_part_2.bulkUpsert(stampedPart2.slice(first, end)),
    ]);
  });
  notifyRunWrite(scopeUserId);
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

/**
 * Finds the stored document id for a run without reading the user's whole history: the
 * reference's own ids are tried as document ids first. Returns null when neither matches,
 * in which case the caller falls back to scanning for a same-entry match.
 */
async function findRunDocumentIdDirect(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
  reference: { runId?: string; localId?: string },
): Promise<string | null> {
  const candidates = [reference.runId, reference.localId]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

  for (const candidate of candidates) {
    const match = await db.run_part_1.findOne({
      selector: { ...buildScopeSelector(scopeUserId), id: candidate },
    }).exec();
    if (match) {
      return candidate;
    }
  }
  return null;
}

export async function removeRunFromBotRxDB(
  db: BotRunTrackerRxDatabase,
  scopeUserId: string,
  reference: { runId?: string; localId?: string },
): Promise<boolean> {
  let docId = await findRunDocumentIdDirect(db, scopeUserId, reference);

  if (!docId) {
    // Stored under a different id than the reference carries (e.g. a local id that was
    // later assigned a cloud id), so match it the slow way.
    const stitchedRuns = await loadStitchedRunsFromBotRxDB(db, scopeUserId);
    const target = stitchedRuns.find((run) => trackerRunReferencesSameEntry({
      left: reference,
      right: {
        runId: typeof run.runId === 'string' ? run.runId : undefined,
        localId: typeof run.localId === 'string' ? run.localId : undefined,
      },
    }));

    docId = target
      ? resolveRunDocumentId({
          runId: typeof target.runId === 'string' ? target.runId : undefined,
          localId: typeof target.localId === 'string' ? target.localId : undefined,
        })
      : resolveRunDocumentId(reference);
  }

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

  notifyRunWrite(scopeUserId);
  return true;
}
