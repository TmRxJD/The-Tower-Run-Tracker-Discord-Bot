import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { fetchTrackerRunDeltasFromFunction } from '../src/features/track/run-delta-function-client';
import { resolveAppwriteIdForDiscordUser } from '../src/services/discord-identity-resolver';

loadEnv({ path: resolve(process.cwd(), '.env.dev') });
loadEnv({ path: resolve(process.cwd(), '.env') });

process.env.DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'dev';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.BOT_LOG_LEVEL = process.env.BOT_LOG_LEVEL || 'debug';

async function main() {
  loadConfig();

  const userId = process.argv[2] || '371914184822095873';
  const lastSyncedAtMs = Number(process.argv[3] || 0);
  const cloudUserId = (await resolveAppwriteIdForDiscordUser(userId)) || userId;

  const result = await fetchTrackerRunDeltasFromFunction({
    userId,
    cloudUserId,
    lastSyncedAtMs,
    limit: 5,
  });

  console.log(JSON.stringify({
    success: true,
    userId,
    count: result.count,
    syncedAtMs: result.syncedAtMs,
    sampleRunIds: result.runs.slice(0, 3).map((run) => String(run.$id || run.runId || '')),
    sampleUpdatedAt: result.runs.slice(0, 3).map((run) => run.updatedAt),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
