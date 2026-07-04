import 'dotenv/config';
import { getTrackerKv } from '../src/services/idb';
import {
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
  reconcileTrackerRunIds,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  buildTrackerRunIdentityContext,
} from '@tmrxjd/platform/tools';
import { getLocalRuns, getLegacyKvRuns } from '../src/features/track/local-run-store';
import { countRunsInBotRxDB } from '../src/rxdb/persistence';
import { ensureBotRunTrackerRxDatabase } from '../src/rxdb/run-rxdb-store';
import { Query } from 'node-appwrite';
import { createAppwriteClient } from '../src/persistence/appwrite-client';
import { resolveAppwriteIdForDiscordUser } from '../src/services/discord-identity-resolver';

async function main() {
  const userId = process.argv[2] || '371914184822095873';

  const cursor = await getTrackerKv<number>(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${userId}`).catch(() => null);
  console.log('cursor', cursor, cursor ? new Date(cursor).toISOString() : 'none');

  const runs = await getLocalRuns(userId);
  console.log('getLocalRuns', runs.length);

  const db = await ensureBotRunTrackerRxDatabase(userId);
  console.log('rxdbCount', await countRunsInBotRxDB(db, userId));
  console.log('legacyKv', (await getLegacyKvRuns(userId)).length);

  const appwriteUserId = await resolveAppwriteIdForDiscordUser(userId);
  const identity = buildTrackerRunIdentityContext({
    appwriteUserId,
    discordUserId: userId,
    extraUserIds: [userId, appwriteUserId],
  });
  console.log('appwriteUserId', appwriteUserId);
  console.log('lookupUserIds', identity.lookupUserIds);

  const localIds = new Set(
    runs
      .map((r) => (typeof r.runId === 'string' ? r.runId.trim() : ''))
      .filter(Boolean),
  );
  const { databases } = createAppwriteClient();
  const result = await reconcileTrackerRunIds({
    databases,
    databaseId: 'run-tracker-data',
    collectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    userIds: identity.lookupUserIds,
    pageSize: 100,
    localIds,
    buildQueries: (uid, cursorAfter, pageSize) => [
      Query.equal('userId', uid),
      Query.select(['$id']),
      Query.limit(pageSize),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ],
  });

  console.log('cloudIds', result.allCloudIds.size);
  console.log('cloudOnly', result.cloudOnlyIds.length);
  console.log('localOnly', result.localOnlyIds.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
