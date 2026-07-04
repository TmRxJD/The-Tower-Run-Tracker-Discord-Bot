import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import '../src/rxdb/ensure-node-storage';
import { loadConfig } from '../src/config';
import { syncUserRunDeltas } from '../src/features/track/run-delta-sync';
import { countRunsInBotRxDB } from '../src/rxdb/persistence';
import { ensureBotRunTrackerRxDatabase } from '../src/rxdb/run-rxdb-store';

loadEnv({ path: resolve(process.cwd(), '.env.dev') });
loadEnv({ path: resolve(process.cwd(), '.env') });

process.env.DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'dev';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.BOT_LOG_LEVEL = process.env.BOT_LOG_LEVEL || 'debug';

async function main() {
  loadConfig();
  const userId = process.argv[2] || '371914184822095873';
  const result = await syncUserRunDeltas(userId, 100);
  const db = await ensureBotRunTrackerRxDatabase(userId);
  const runCount = await countRunsInBotRxDB(db, userId);
  console.log(JSON.stringify({ userId, ...result, runPart1Count: runCount }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
