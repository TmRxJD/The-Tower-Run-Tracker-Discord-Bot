require('dotenv/config');
const { getTrackerKv } = require('../src/services/idb');
const {
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
  reconcileTrackerRunIds,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  buildTrackerRunIdentityContext,
} = require('@tmrxjd/platform/tools');
const { getLocalRuns, getLegacyKvRuns } = require('../src/features/track/local-run-store');
const { countRunsInBotRxDB } = require('../src/rxdb/persistence');
const { ensureBotRunTrackerRxDatabase } = require('../src/rxdb/run-rxdb-store');
const { Query } = require('node-appwrite');
const { createAppwriteClient } = require('../src/persistence/appwrite-client');
const { resolveAppwriteIdForDiscordUser } = require('../src/services/discord-identity-resolver');

async function main() {
  const userId = process.argv[2] || '371914184822095873';

  const cursor = await getTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${userId}`).catch(() => null);
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
