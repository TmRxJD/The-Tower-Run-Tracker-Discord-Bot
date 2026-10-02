import { logger } from '../core/logger';
import { isTrackerCloudAddressableUserId } from '@tmrxjd/platform/tools';
import { getPermanentlyDeletedRunIds } from '../features/track/run-deletion-tombstones';
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
  restoreForUnsupportedIdentity?: boolean;
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
const backupTails = new Map<string, Promise<unknown>>();

export async function backupLocalOnlyRunsNow(userId: string, options: { force?: boolean } = {}): Promise<boolean> {
  const previous = backupTails.get(userId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeLocalOnlySnapshot(userId, options.force === true));
  backupTails.set(userId, pending);
  try { return await pending; }
  finally { if (backupTails.get(userId) === pending) backupTails.delete(userId); }
}

async function writeLocalOnlySnapshot(userId: string, force: boolean): Promise<boolean> {
  if (!force && !await isLocalOnlyUser(userId)) {
    return false;
  }

  const db = await getOrInitBotRunTrackerRxDatabase(userId);
  const runs = await loadStitchedRunsFromBotRxDB(db, userId);
  await setTrackerKv(backupKey(userId), { savedAt: Date.now(), runs, restoreForUnsupportedIdentity: force && !isTrackerCloudAddressableUserId(userId) } satisfies LocalOnlyBackup, { requirePersistent: true });
  return true;
}

/** Preserve acknowledged offline records while cloud sync is enabled but unfinished. */
export async function refreshExistingLocalOnlyBackup(userId: string): Promise<void> {
  if (await getTrackerKv<LocalOnlyBackup>(backupKey(userId))) await backupLocalOnlyRunsNow(userId, { force: true });
}

/** A confirmed cloud write retires only its local snapshot entry, never a whole user's history. */
export async function retireLocalOnlyBackupRun(userId: string, localId: unknown): Promise<void> {
  if (typeof localId !== 'string' || !localId.trim()) return;
  const pending = (backupTails.get(userId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const backup = await getTrackerKv<LocalOnlyBackup>(backupKey(userId));
    if (!backup) return;
    const runs = backup.runs.filter(run => run.localId !== localId);
    if (runs.length !== backup.runs.length) await setTrackerKv(backupKey(userId), { ...backup, runs, savedAt: Date.now() }, { requirePersistent: true });
  });
  backupTails.set(userId, pending);
  try { await pending; }
  finally { if (backupTails.get(userId) === pending) backupTails.delete(userId); }
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
      const backup = await getTrackerKv<LocalOnlyBackup>(key);
      if (!backup?.runs?.length) {
        continue;
      }

      const offline = await isLocalOnlyUser(userId);
      const unsupported = backup.restoreForUnsupportedIdentity && !isTrackerCloudAddressableUserId(userId);
      const tombstones = await getPermanentlyDeletedRunIds(userId);
      const restorable = backup.runs.filter(run => {
        if (!offline && !unsupported && run.runId) return false;
        return ![run.runId, run.id, run.$id, run.localId].some(id => typeof id === 'string' && tombstones.has(id));
      });
      if (!restorable.length) continue;

      const db = await getOrInitBotRunTrackerRxDatabase(userId);
      await upsertMergedRunsToBotRxDB(db, userId, restorable);
      users += 1;
      runs += restorable.length;
    } catch (error) {
      logger.error('[local-only-backup] restore failed for user', { userId, error });
    }
  }

  if (users > 0) {
    logger.warn('[local-only-backup] restored local-only runs into the cache', { users, runs });
  }
  return { users, runs };
}
