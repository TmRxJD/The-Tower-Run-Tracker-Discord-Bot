import {
  mergeBotsTrackerCloudBundleToLocal,
  normalizeBotsTrackerLocalSnapshot,
  parseIsoTimestampToMillis,
  splitBotsTrackerLocalStateToCloudBundle,
  TRACKER_BOTS_CLOUD_COLLECTION_ID,
  TRACKER_BOTS_CLOUD_DATABASE_ID,
} from '@tmrxjd/platform/tools';
import { mutateCloudJsonBlobDocument, resolveCloudJsonBlobDocument } from '@tmrxjd/platform/node';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import { createAppwriteClient } from '../persistence/appwrite-client';
import { resolveAppwriteIdForDiscordUser } from './discord-identity-resolver';

export type BotsTrackerCloudLoadResult = {
  state: Record<string, unknown>;
  updatedAt: number | null;
};

async function resolveCloudUserIdCandidates(userId: string): Promise<string[]> {
  const appwriteId = await resolveAppwriteIdForDiscordUser(userId);
  return Array.from(new Set([
    appwriteId ?? '',
    userId.trim(),
  ].filter(Boolean)));
}

function resolveBotsTrackerCloudIds(): { databaseId: string; collectionId: string } {
  const cfg = getAppConfig();
  return {
    databaseId: cfg.appwrite.botsTrackerDatabaseId ?? TRACKER_BOTS_CLOUD_DATABASE_ID,
    collectionId: cfg.appwrite.botsTrackerCollectionId ?? TRACKER_BOTS_CLOUD_COLLECTION_ID,
  };
}

export async function loadBotsTrackerCloud(userId: string): Promise<BotsTrackerCloudLoadResult | null> {
  try {
    const client = createAppwriteClient();
    if (!client?.databases) {
      return null;
    }

    const { databaseId, collectionId } = resolveBotsTrackerCloudIds();
    const resolved = await resolveCloudJsonBlobDocument({
      databases: client.databases,
      databaseId,
      collectionId,
      candidateDocumentIds: await resolveCloudUserIdCandidates(userId),
    });
    if (!resolved) {
      return null;
    }

    const local = mergeBotsTrackerCloudBundleToLocal({
      progress: resolved.blob.progress as never,
      settings: resolved.blob.settings as never,
    });

    return {
      state: normalizeBotsTrackerLocalSnapshot(local),
      updatedAt: parseIsoTimestampToMillis(resolved.document.$updatedAt ?? resolved.document.updatedAt),
    };
  } catch (error) {
    logger.warn('Failed loading bots tracker cloud state', error);
    return null;
  }
}

export async function saveBotsTrackerCloud(userId: string, localState: Record<string, unknown>): Promise<boolean> {
  try {
    const client = createAppwriteClient();
    if (!client?.databases) {
      return false;
    }

    const { databaseId, collectionId } = resolveBotsTrackerCloudIds();
    const candidates = await resolveCloudUserIdCandidates(userId);
    const fallbackDocumentId = candidates[0] ?? userId;
    const bundle = splitBotsTrackerLocalStateToCloudBundle(localState);

    await mutateCloudJsonBlobDocument({
      databases: client.databases,
      databaseId,
      collectionId,
      candidateDocumentIds: candidates,
      fallbackDocumentId,
      mutate: () => ({
        progress: bundle.progress,
        settings: bundle.settings,
      }),
    });
    return true;
  } catch (error) {
    logger.warn('Failed saving bots tracker cloud state', error);
    return false;
  }
}
