import '../src/rxdb/ensure-node-storage';
import { initSharedBotRunTrackerRxDatabase } from '../src/rxdb/init-database';
import { countRunsInBotRxDB } from '../src/rxdb/persistence';
import { getBotRxStorageDirectory } from '../src/rxdb/bot-rx-storage';

const TEST_USER_ID = process.argv[2] || '371914184822095873';

async function main(): Promise<void> {
  const storageDirectory = getBotRxStorageDirectory();
  const db = await initSharedBotRunTrackerRxDatabase();
  const runCount = await countRunsInBotRxDB(db, TEST_USER_ID);
  const totalCount = await db.run_part_1.count().exec();

  console.log(JSON.stringify({
    ok: true,
    storageDirectory,
    testUserId: TEST_USER_ID,
    scopedRunCount: runCount,
    totalRunPart1Count: totalCount,
  }, null, 2));

  await db.close();
}

void main().catch((error) => {
  console.error('rxdb persistence probe failed', error);
  process.exitCode = 1;
});
