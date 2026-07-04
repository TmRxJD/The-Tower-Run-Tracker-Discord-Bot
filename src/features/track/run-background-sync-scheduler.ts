import { TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS } from '@tmrxjd/platform/tools';
import type { TrackerBotClient } from '../../core/tracker-bot-client';
import { logger } from '../../core/logger';
import { releaseBotRunTrackerRxDatabase } from '../../rxdb/database-manager';
import { listCloudSyncEnabledUserIds } from './local-run-store';
import { runBackgroundAuthoritySync } from './run-background-authority-sync';

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runBackgroundSyncPass(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
    const userIds = await listCloudSyncEnabledUserIds();
    if (userIds.length === 0) {
      return;
    }

    let changedUsers = 0;
    for (const userId of userIds) {
      let result = { changed: false };
      try {
        result = await runBackgroundAuthoritySync(userId).then(() => ({ changed: true })).catch(() => ({ changed: false }));
      } catch (error) {
        logger.warn('[background-sync] delta sync failed', { userId, error });
      } finally {
        await releaseBotRunTrackerRxDatabase(userId).catch(() => {});
      }

      if (result.changed) {
        changedUsers += 1;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }

    logger.info('[background-sync] completed run delta pass', {
      users: userIds.length,
      changedUsers,
    });
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

  void runBackgroundSyncPass();
  interval = setInterval(() => {
    void runBackgroundSyncPass();
  }, TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS);

  logger.info('Tracker run background sync scheduler started', {
    intervalMs: TRACKER_RUN_BACKGROUND_SYNC_INTERVAL_MS,
  });
}

export function stopTrackerRunBackgroundSyncScheduler(): void {
  if (!interval) {
    return;
  }

  clearInterval(interval);
  interval = null;
}
