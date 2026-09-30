import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, unknown>();
const settings = new Map<string, { cloudSyncEnabled: boolean }>();

vi.mock('../services/idb', () => ({
  getTrackerKv: vi.fn(async (key: string) => kv.get(key) ?? null),
  setTrackerKv: vi.fn(async (key: string, value: unknown) => { kv.set(key, value); }),
  listTrackerKvKeys: vi.fn(async (prefix: string) => [...kv.keys()].filter((key) => key.startsWith(prefix))),
}));
vi.mock('../features/track/local-run-store', () => ({
  getLocalSettings: vi.fn(async (userId: string) => settings.get(userId) ?? { cloudSyncEnabled: true }),
  getLegacyKvRuns: vi.fn(async () => []),
  clearLegacyKvRuns: vi.fn(async () => {}),
}));

import { initSharedBotRunTrackerRxDatabase } from './init-database';
import { countRunsInBotRxDB, removeRunFromBotRxDB, upsertMergedRunsToBotRxDB } from './persistence';
import {
  LOCAL_ONLY_BACKUP_KEY_PREFIX,
  backupLocalOnlyRunsNow,
  flushLocalOnlyRunBackups,
  registerLocalOnlyRunBackup,
  restoreLocalOnlyRuns,
} from './local-only-backup';

const makeRun = (id: string) => ({
  id, runId: id, localId: id, username: 'tester', type: 'Farming', runDate: '2026-07-01', runTime: '10:00',
  tier: '10', wave: '1000', totalCoins: '100', createdAt: 1_780_000_000_000, updatedAt: 1_780_000_000_000,
});

describe('local-only run backup', () => {
  beforeEach(() => {
    kv.clear();
    settings.clear();
  });

  it('snapshots a cloud-sync-off user and skips everyone else', async () => {
    settings.set('off-user', { cloudSyncEnabled: false });
    const db = await initSharedBotRunTrackerRxDatabase();
    await upsertMergedRunsToBotRxDB(db, 'off-user', [makeRun('a'), makeRun('b')]);
    await upsertMergedRunsToBotRxDB(db, 'cloud-user', [makeRun('c')]);

    expect(await backupLocalOnlyRunsNow('off-user')).toBe(true);
    expect(await backupLocalOnlyRunsNow('cloud-user')).toBe(false);

    const saved = kv.get(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}off-user`) as { runs: { id: string }[] };
    expect(saved.runs.map((run) => run.id).sort()).toEqual(['a', 'b']);
    expect(kv.has(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}cloud-user`)).toBe(false);
  });

  it('restores a snapshot into an empty cache', async () => {
    settings.set('restore-user', { cloudSyncEnabled: false });
    kv.set(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}restore-user`, { savedAt: 1, runs: [makeRun('r1'), makeRun('r2'), makeRun('r3')] });

    const result = await restoreLocalOnlyRuns();

    expect(result).toEqual({ users: 1, runs: 3 });
    const db = await initSharedBotRunTrackerRxDatabase();
    expect(await countRunsInBotRxDB(db, 'restore-user')).toBe(3);
  });

  it('ignores the snapshot of a user who turned cloud sync back on', async () => {
    settings.set('back-online', { cloudSyncEnabled: true });
    kv.set(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}back-online`, { savedAt: 1, runs: [makeRun('stale')] });

    expect(await restoreLocalOnlyRuns()).toEqual({ users: 0, runs: 0 });
    const db = await initSharedBotRunTrackerRxDatabase();
    expect(await countRunsInBotRxDB(db, 'back-online')).toBe(0);
  });

  it('backs up automatically after writes and removals, and flushes on demand', async () => {
    settings.set('auto-user', { cloudSyncEnabled: false });
    registerLocalOnlyRunBackup();
    const db = await initSharedBotRunTrackerRxDatabase();

    await upsertMergedRunsToBotRxDB(db, 'auto-user', [makeRun('x1'), makeRun('x2')]);
    await flushLocalOnlyRunBackups();
    expect((kv.get(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}auto-user`) as { runs: unknown[] }).runs).toHaveLength(2);

    await removeRunFromBotRxDB(db, 'auto-user', { runId: 'x1' });
    await flushLocalOnlyRunBackups();
    expect((kv.get(`${LOCAL_ONLY_BACKUP_KEY_PREFIX}auto-user`) as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual(['x2']);
  });

  it('survives a simulated restart: snapshot, wipe the cache, restore', async () => {
    settings.set('restart-user', { cloudSyncEnabled: false });
    const db = await initSharedBotRunTrackerRxDatabase();
    await upsertMergedRunsToBotRxDB(db, 'restart-user', [makeRun('k1'), makeRun('k2')]);
    await backupLocalOnlyRunsNow('restart-user');

    await removeRunFromBotRxDB(db, 'restart-user', { runId: 'k1' });
    await removeRunFromBotRxDB(db, 'restart-user', { runId: 'k2' });
    expect(await countRunsInBotRxDB(db, 'restart-user')).toBe(0);

    await restoreLocalOnlyRuns();
    expect(await countRunsInBotRxDB(db, 'restart-user')).toBe(2);
  });
});
