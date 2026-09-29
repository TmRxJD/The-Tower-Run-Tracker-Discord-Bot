import { TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS } from '@tmrxjd/platform/tools';
import type { TrackerBotClient } from '../../core/tracker-bot-client';
import { logger } from '../../core/logger';
import { releaseBotRunTrackerRxDatabase } from '../../rxdb/database-manager';
import { listTrackerUserIdsSeenSince } from '../../services/idb';
import { listCloudSyncEnabledUserIds } from './local-run-store';
import { runBackgroundAuthoritySync } from './run-background-authority-sync';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_WINDOW_DAYS = 7;

/**
 * Consecutive users whose cloud could not be reached before a pass gives up. During an
 * outage every user fails the same way; walking the remaining thousand only floods the
 * logs (42k warnings in 90 minutes on 2026-09-29) and ties up sockets and the threadpool.
 */
const MAX_CONSECUTIVE_CLOUD_FAILURES = 5;

/** Pause between users so a pass never monopolises the event loop. */
const BETWEEN_USERS_DELAY_MS = 5;

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function resolveActiveWindowMs(): number {
  const days = Number(process.env.TRACKER_BACKGROUND_SYNC_ACTIVE_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_ACTIVE_WINDOW_DAYS) * DAY_MS;
}

/**
 * Cloud-sync users seen recently. The pass used to cover every user in the local store
 * (1,124 in prod, of whom 108 had been seen in the last week), re-reading and re-fetching
 * histories nobody was looking at. Anyone else is synced on demand: opening the menu already
 * primes or delta-syncs that user before rendering.
 */
async function listUsersForBackgroundPass(): Promise<string[]> {
  const cloudSyncUserIds = await listCloudSyncEnabledUserIds();
  if (cloudSyncUserIds.length === 0) {
    return [];
  }

  const seenSince = new Date(Date.now() - resolveActiveWindowMs()).toISOString();
  const recentlySeen = new Set(await listTrackerUserIdsSeenSince(seenSince));
  return cloudSyncUserIds.filter((userId) => recentlySeen.has(userId));
}

export interface BackgroundSyncPassResult {
  users: number;
  synced: number;
  failed: number;
  abortedForOutage: boolean;
}

export async function runBackgroundSyncPass(): Promise<BackgroundSyncPassResult | null> {
  if (running) {
    return null;
  }

  running = true;
  try {
    const userIds = await listUsersForBackgroundPass();
    const result: BackgroundSyncPassResult = { users: userIds.length, synced: 0, failed: 0, abortedForOutage: false };
    if (userIds.length === 0) {
      return result;
    }

    let consecutiveCloudFailures = 0;
    for (const userId of userIds) {
      try {
        const { cloudReachable } = await runBackgroundAuthoritySync(userId);
        if (cloudReachable) {
          consecutiveCloudFailures = 0;
          result.synced += 1;
        } else {
          consecutiveCloudFailures += 1;
          result.failed += 1;
        }
      } catch (error) {
        consecutiveCloudFailures += 1;
        result.failed += 1;
        logger.warn('[background-sync] authority sync failed', { userId, error });
      } finally {
        await releaseBotRunTrackerRxDatabase(userId).catch(() => {});
      }

      if (consecutiveCloudFailures >= MAX_CONSECUTIVE_CLOUD_FAILURES) {
        result.abortedForOutage = true;
        logger.warn('[background-sync] cloud unreachable; aborting pass until the next interval', {
          consecutiveCloudFailures,
          users: result.users,
          synced: result.synced,
        });
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, BETWEEN_USERS_DELAY_MS);
      });
    }

    logger.info('[background-sync] completed run delta pass', result);
    return result;
  } finally {
    running = false;
  }
}

export function startTrackerRunBackgroundSyncScheduler(client: TrackerBotClient): void {
  void client;
  if (interval) {
    return;
  }

  if (process.env.DEPLOYMENT_MODE !== 'prod') {
    logger.info('Tracker run background sync scheduler disabled in dev mode');
    return;
  }

  void runBackgroundSyncPass().catch((error) => {
    logger.warn('[background-sync] pass failed', error);
  });
  interval = setInterval(() => {
    void runBackgroundSyncPass().catch((error) => {
      logger.warn('[background-sync] pass failed', error);
    });
  }, TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS);

  logger.info('Tracker run background sync scheduler started', {
    intervalMs: TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS,
    activeWindowDays: resolveActiveWindowMs() / DAY_MS,
  });
}

export function stopTrackerRunBackgroundSyncScheduler(): void {
  if (!interval) {
    return;
  }

  clearInterval(interval);
  interval = null;
}
