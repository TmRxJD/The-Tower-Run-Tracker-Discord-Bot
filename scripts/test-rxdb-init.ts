import './../src/rxdb/ensure-node-storage';
import { initBotRunTrackerRxDatabase } from '../src/rxdb/init-database';

async function main() {
  const userId = process.argv[2] || '371914184822095873';
  const db = await initBotRunTrackerRxDatabase(userId);
  const count = await db.run_part_1.count().exec();
  console.log(JSON.stringify({ ok: true, userId, runPart1Count: count }, null, 2));
  await db.close();
}

void main().catch((error) => {
  console.error('rxdb init failed', error);
  process.exitCode = 1;
});
