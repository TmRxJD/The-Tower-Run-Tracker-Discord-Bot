import { Query } from 'node-appwrite';
import {
  buildTrackerRunIdentityContext,
  hydrateTrackerCloudRun,
  syncTrackerRunCloudDeltas,
  TRACKER_RUN_EXTENDED_COLLECTION_ID,
  TRACKER_RUN_MAIN_COLLECTION_ID,
  TRACKER_RUN_SYNC_CURSOR_KV_PREFIX,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import { logger } from '../../core/logger';
import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';
import { bindBotRunTrackerRxDBInboundSync } from '../../rxdb/reactive-sync';
import {
  ensureBotRunTrackerRxDatabase,
  upsertMergedRunsIntoBotRxDB,
} from '../../rxdb/run-rxdb-store';
import { bulkUpsertLocalRuns, getLocalSettings, mergeCloudRuns } from './local-run-store';

const RUNS_DATABASE_ID = 'run-tracker-data';

function buildUpdatedAtQueries(input: { userId: string; updatedAtMs: number; limit: number }): string[] {
  return [
    Query.equal('userId', input.userId),
    Query.greaterThan('updatedAt', input.updatedAtMs),
    Query.orderDesc('updatedAt'),
    Query.limit(input.limit),
  ];
}

function createSyncCursorStore() {
  return {
    getSyncTimestamp: async (cursorUserId: string) => {
      return getTrackerKv<number>(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorUserId}`).catch(() => null);
    },
    setSyncTimestamp: async (cursorUserId: string, timestampMs: number) => {
      await setTrackerKv(`${TRACKER_RUN_SYNC_CURSOR_KV_PREFIX}${cursorUserId}`, timestampMs).catch(() => {});
    },
  };
}

async function mirrorMergedRunsToLegacyStore(
  userId: string,
  ownerUserId: string,
  username: string,
  mergedRuns: Record<string, unknown>[],
): Promise<void> {
  const hydrated = mergedRuns.map((document) => hydrateTrackerCloudRun(document, ownerUserId, username));
  await mergeCloudRuns(userId, hydrated);
  await bulkUpsertLocalRuns(userId, hydrated.map((run) => ({
    username,
    runData: run,
  })));
}

export async function syncUserRunDeltas(userId: string, limit = 100): Promise<{ changed: boolean }> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return { changed: false };
  }

  const appwriteUserId = await resolveAppwriteIdForDiscordUser(userId);
  const identity = buildTrackerRunIdentityContext({
    appwriteUserId,
    discordUserId: userId,
  });
  const cloudUserId = identity.ownerUserId ?? identity.activeUserId ?? userId;
  const { databases } = createAppwriteClient();
  const username = 'unknown';

  const syncInput = {
    databases,
    databaseId: RUNS_DATABASE_ID,
    mainCollectionId: TRACKER_RUN_MAIN_COLLECTION_ID,
    extendedCollectionId: TRACKER_RUN_EXTENDED_COLLECTION_ID,
    userId: cloudUserId,
    syncCursorUserId: userId,
    limit,
    buildUpdatedAtQueries,
    syncCursorStore: createSyncCursorStore(),
    repairHooks: {
      onRepaired: ({ docId, reason }: { docId: string; reason: string }) => {
        logger.info('[delta-sync] repaired cloud run document', { userId, docId, reason });
      },
      onSkipped: ({ reason }: { reason: string }) => {
        logger.warn('[delta-sync] skipped unrepairable cloud run document', { userId, reason });
      },
    },
    onNoChanges: ({ userId: cursorUserId, lastSyncedAtMs }: { userId: string; lastSyncedAtMs: number }) => {
      logger.info('[delta-sync] no modified run documents since cursor', { userId: cursorUserId, lastSyncedAtMs });
    },
    onApplied: ({ userId: cursorUserId, count }: { userId: string; count: number }) => {
      logger.info('[delta-sync] applied run deltas', { userId: cursorUserId, count });
    },
  };

  try {
    await ensureBotRunTrackerRxDatabase(userId);
    await bindBotRunTrackerRxDBInboundSync(userId);

    const result = await syncTrackerRunCloudDeltas({
      ...syncInput,
      onApplied: ({ userId: cursorUserId, count }) => {
        logger.info('[delta-sync] applied run deltas to RxDB', { userId: cursorUserId, count });
      },
      applyMergedRuns: async (mergedRuns) => {
        await upsertMergedRunsIntoBotRxDB(userId, mergedRuns);
        await mirrorMergedRunsToLegacyStore(userId, cloudUserId, username, mergedRuns);
      },
    });

    return { changed: result.changed };
  } catch (error) {
    logger.warn('[delta-sync] RxDB delta sync failed; falling back to legacy local store', { userId, error });
  }

  const legacyResult = await syncTrackerRunCloudDeltas({
    ...syncInput,
    applyMergedRuns: async (mergedRuns) => {
      await mirrorMergedRunsToLegacyStore(userId, cloudUserId, username, mergedRuns);
      await upsertMergedRunsIntoBotRxDB(userId, mergedRuns).catch(() => {});
    },
  });

  return { changed: legacyResult.changed };
}
