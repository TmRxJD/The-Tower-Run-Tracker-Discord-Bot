import { logger } from '../core/logger';
import { getTrackerKv, listTrackerKvKeys, setTrackerKv } from '../services/idb';
import { getOrInitBotRunTrackerRxDatabase } from './database-manager';
import { loadStitchedRunsFromBotRxDB, setBotRunWriteListener, upsertMergedRunsToBotRxDB } from './persistence';

/**
 * The run cache is normally a rebuildable mirror of Appwrite, and the memory engine loses it
 * on every restart. Users who switched cloud sync off are the exception: their runs exist
 * only here. Those users are snapshotted to the persistent KV after each change and put back
 * into the cache on startup.
 */
export const LOCAL_ONLY_BACKUP_KEY_PREFIX = 'tracker-local-only-runs:v1:';
const BACKUP_DEBOUNCE_MS = 2_000;

interface LocalOnlyBackup {
  savedAt: number;
  runs: Record<string, unknown>[];
}

const pendingBackups = new Map<string, ReturnType<typeof setTimeout>>();

function backupKey(userId: string): string {
  return `${LOCAL_ONLY_BACKUP_KEY_PREFIX}${userId}`;
}

async function isLocalOnlyUser(userId: string): Promise<boolean> {
  // Imported lazily: local-run-store and the rxdb layer already depend on each other.
  const { getLocalSettings } = await import('../features/track/local-run-store.js');
  return (await getLocalSettings(userId)).cloudSyncEnabled === false;
}

/** Snapshots the user's runs if (and only if) they are a cloud-sync-off user. */
export async function backupLocalOnlyRunsNow(userId: string): Promise<boolean> {
  if (!await isLocalOnlyUser(userId)) {
    return false;
  }

  const db = await getOrInitBotRunTrackerRxDatabase(userId);
  const runs = await loadStitchedRunsFromBotRxDB(db, userId);
  await setTrackerKv(backupKey(userId), { savedAt: Date.now(), runs } satisfies LocalOnlyBackup);
  return true;
}

function scheduleBackup(userId: string): void {
  const existing = pendingBackups.get(userId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    pendingBackups.delete(userId);
    backupLocalOnlyRunsNow(userId).catch((error: unknown) => {
      logger.error('[local-only-backup] snapshot failed; runs exist only in memory until the next change', { userId, error });
    });
  }, BACKUP_DEBOUNCE_MS);
  timer.unref?.();
  pendingBackups.set(userId, timer);
}

/** Starts snapshotting cloud-sync-off users whenever their runs change. */
export function registerLocalOnlyRunBackup(): void {
  setBotRunWriteListener((userId) => {
    // Only users that could be local-only need the settings lookup; it is cached and cheap.
    scheduleBackup(userId);
  });
}

/** Writes any snapshot still waiting on its debounce timer. Call before exiting. */
export async function flushLocalOnlyRunBackups(): Promise<void> {
  const userIds = [...pendingBackups.keys()];
  for (const userId of userIds) {
    clearTimeout(pendingBackups.get(userId));
    pendingBackups.delete(userId);
  }
  await Promise.all(userIds.map((userId) => backupLocalOnlyRunsNow(userId).catch((error: unknown) => {
    logger.error('[local-only-backup] final snapshot failed', { userId, error });
  })));
}

/**
 * Puts each cloud-sync-off user's snapshot back into the cache. Snapshots belonging to a
 * user who has since re-enabled cloud sync are ignored: the cloud is authoritative for them
 * and an old snapshot could resurrect runs they deleted.
 */
export async function restoreLocalOnlyRuns(): Promise<{ users: number; runs: number }> {
  const keys = await listTrackerKvKeys(LOCAL_ONLY_BACKUP_KEY_PREFIX);
  let users = 0;
  let runs = 0;

  for (const key of keys) {
    const userId = key.slice(LOCAL_ONLY_BACKUP_KEY_PREFIX.length);
    try {
      if (!await isLocalOnlyUser(userId)) {
        continue;
      }
      const backup = await getTrackerKv<LocalOnlyBackup>(key);
      if (!backup?.runs?.length) {
        continue;
      }

      const db = await getOrInitBotRunTrackerRxDatabase(userId);
      await upsertMergedRunsToBotRxDB(db, userId, backup.runs);
      users += 1;
      runs += backup.runs.length;
    } catch (error) {
      logger.error('[local-only-backup] restore failed for user', { userId, error });
    }
  }

  if (users > 0) {
    logger.warn('[local-only-backup] restored local-only runs into the cache', { users, runs });
  }
  return { users, runs };
}
