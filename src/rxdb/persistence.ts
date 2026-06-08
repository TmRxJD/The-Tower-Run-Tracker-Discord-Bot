import {
  splitTrackerRunForCollections,
  stitchTrackerRunCollections,
  withTrackerRunUpdatedAtEpoch,
} from '@tmrxjd/platform/tools';
import type { BotRunTrackerRxDatabase } from './init-database';
import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

export async function batchUpsertRunPartsToBotRxDB(
  db: BotRunTrackerRxDatabase,
  part1Documents: TrackerRunPartDocument[],
  part2Documents: TrackerRunPartDocument[],
): Promise<void> {
  if (part1Documents.length === 0 && part2Documents.length === 0) {
    return;
  }

  await Promise.all([
    ...part1Documents.map((document) => db.run_part_1.upsert(document)),
    ...part2Documents.map((document) => db.run_part_2.upsert(document)),
  ]);
}

export async function upsertMergedRunsToBotRxDB(
  db: BotRunTrackerRxDatabase,
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

  await batchUpsertRunPartsToBotRxDB(db, part1Documents, part2Documents);
}

export async function loadStitchedRunsFromBotRxDB(
  db: BotRunTrackerRxDatabase,
): Promise<Record<string, unknown>[]> {
  const [part1Docs, part2Docs] = await Promise.all([
    db.run_part_1.find().exec(),
    db.run_part_2.find().exec(),
  ]);

  const extendedById = new Map<string, TrackerRunPartDocument>();
  for (const document of part2Docs) {
    if (document?.id) {
      extendedById.set(document.id, document);
    }
  }

  const runs: Record<string, unknown>[] = [];
  for (const part1 of part1Docs) {
    const stitched = stitchTrackerRunCollections(part1, part1.id ? extendedById.get(part1.id) : null);
    if (!stitched) continue;
    if (typeof stitched.deletedAt === 'string' && stitched.deletedAt.trim().length > 0) {
      continue;
    }
    runs.push(stitched);
  }

  return runs;
}
