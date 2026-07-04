require('dotenv/config');
const { getLocalRuns } = require('../src/features/track/local-run-store');
const { ensureBotRunTrackerRxDatabase } = require('../src/rxdb/run-rxdb-store');
const { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } = require('../src/rxdb/bot-run-schemas');
const { stitchTrackerRunCollections } = require('@tmrxjd/platform/tools');

async function main() {
  const userId = process.argv[2] || '371914184822095873';
  const db = await ensureBotRunTrackerRxDatabase(userId);
  const selector = { [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: userId };

  const [part1Docs, part2Docs] = await Promise.all([
    db.run_part_1.find({ selector }).exec(),
    db.run_part_2.find({ selector }).exec(),
  ]);

  const extendedById = new Map();
  for (const doc of part2Docs) {
    if (doc?.id) extendedById.set(doc.id, doc);
  }

  let stitched = 0;
  let deleted = 0;
  let stitchNull = 0;
  let missingRunId = 0;
  const samples = [];

  for (const part1 of part1Docs) {
    const stitchedRun = stitchTrackerRunCollections(part1, part1.id ? extendedById.get(part1.id) : null);
    if (!stitchedRun) {
      stitchNull += 1;
      if (samples.length < 3) samples.push({ reason: 'stitchNull', id: part1.id, keys: Object.keys(part1.toJSON?.() ?? part1) });
      continue;
    }
    if (typeof stitchedRun.deletedAt === 'string' && stitchedRun.deletedAt.trim().length > 0) {
      deleted += 1;
      continue;
    }
    const runId = stitchedRun.runId ?? stitchedRun.id;
    if (!runId) {
      missingRunId += 1;
      if (samples.length < 5) samples.push({ reason: 'missingRunId', id: part1.id, stitchedKeys: Object.keys(stitchedRun) });
      continue;
    }
    stitched += 1;
  }

  const localRuns = await getLocalRuns(userId);
  console.log('part1', part1Docs.length, 'part2', part2Docs.length);
  console.log('stitchedActive', stitched, 'deleted', deleted, 'stitchNull', stitchNull, 'missingRunId', missingRunId);
  console.log('getLocalRuns', localRuns.length);
  console.log('samples', JSON.stringify(samples, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
