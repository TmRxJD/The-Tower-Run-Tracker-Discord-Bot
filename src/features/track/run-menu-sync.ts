import { logger } from '../../core/logger';
import { invalidateBotLocalRunsCache } from '../../rxdb/run-rxdb-store';
import { getLocalSettings } from './local-run-store';
import { syncUserRunDeltaPageForMenu } from './run-delta-sync';
import {
  clearMenuPrimedSummary,
  primeMenuCriticalRunsFromCloud,
  shouldPrimeMenuFromCloud,
} from './run-menu-cloud-prime';

const menuBlockingSyncByUser = new Map<string, Promise<void>>();

/**
 * Blocks menu render only for data the main menu needs:
 * - Returning users: delta sync for latest changes (no full history).
 * - Empty local store: cloud total count + recent stitched batch for last run / chart.
 */
export async function ensureMenuRunDataBeforeRender(userId: string): Promise<void> {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) {
    return;
  }

  const inFlight = menuBlockingSyncByUser.get(userId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const task = (async () => {
    if (await shouldPrimeMenuFromCloud(userId)) {
      const primed = await primeMenuCriticalRunsFromCloud(userId);
      if (!primed?.lastRun && (primed?.totalRuns ?? 0) === 0) {
        throw new Error('Menu cloud prime returned no run data');
      }
      return;
    }

    const { changed } = await syncUserRunDeltaPageForMenu(userId);
    if (changed) {
      invalidateBotLocalRunsCache(userId);
    }
    clearMenuPrimedSummary(userId);
  })().catch((error) => {
    logger.warn('[menu-sync] blocking menu sync failed', { userId, error });
    throw error;
  }).finally(() => {
    menuBlockingSyncByUser.delete(userId);
  });

  menuBlockingSyncByUser.set(userId, task);
  await task;
}

/** @deprecated Use ensureMenuRunDataBeforeRender */
export const ensureLatestRunsBeforeMenu = ensureMenuRunDataBeforeRender;

export {
  beginBackgroundAuthoritySync,
  awaitBackgroundAuthoritySync,
  beginBackgroundAuthoritySync as beginCanonicalMenuRunSync,
  runBackgroundAuthoritySync as runCanonicalMenuRunSync,
  awaitBackgroundAuthoritySync as awaitCanonicalMenuRunSync,
} from './run-background-authority-sync';
