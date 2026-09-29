import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCloudSyncEnabledUserIds: vi.fn(),
  listTrackerUserIdsSeenSince: vi.fn(),
  runBackgroundAuthoritySync: vi.fn(),
  releaseBotRunTrackerRxDatabase: vi.fn(),
}));

vi.mock('./local-run-store', () => ({ listCloudSyncEnabledUserIds: mocks.listCloudSyncEnabledUserIds }));
vi.mock('../../services/idb', () => ({ listTrackerUserIdsSeenSince: mocks.listTrackerUserIdsSeenSince }));
vi.mock('./run-background-authority-sync', () => ({ runBackgroundAuthoritySync: mocks.runBackgroundAuthoritySync }));
vi.mock('../../rxdb/database-manager', () => ({ releaseBotRunTrackerRxDatabase: mocks.releaseBotRunTrackerRxDatabase }));

import { runBackgroundSyncPass } from './run-background-sync-scheduler';

const users = (count: number) => Array.from({ length: count }, (_, index) => `user-${index}`);

describe('runBackgroundSyncPass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRACKER_BACKGROUND_SYNC_ACTIVE_DAYS;
    mocks.releaseBotRunTrackerRxDatabase.mockResolvedValue(undefined);
    mocks.runBackgroundAuthoritySync.mockResolvedValue({ cloudReachable: true });
  });

  afterEach(() => {
    delete process.env.TRACKER_BACKGROUND_SYNC_ACTIVE_DAYS;
  });

  it('only syncs cloud-sync users who were seen recently', async () => {
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(['active-1', 'inactive-1', 'active-2']);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue(['active-1', 'active-2', 'not-a-sync-user']);

    const result = await runBackgroundSyncPass();

    expect(result).toMatchObject({ users: 2, synced: 2, failed: 0, abortedForOutage: false });
    expect(mocks.runBackgroundAuthoritySync.mock.calls.map(([id]) => id)).toEqual(['active-1', 'active-2']);
  });

  it('uses a 7 day activity window unless configured', async () => {
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(['u']);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue([]);
    const before = Date.now();

    await runBackgroundSyncPass();
    const defaultSince = Date.parse(mocks.listTrackerUserIdsSeenSince.mock.calls[0][0]);
    expect(before - defaultSince).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(before - defaultSince).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000);

    process.env.TRACKER_BACKGROUND_SYNC_ACTIVE_DAYS = '2';
    await runBackgroundSyncPass();
    const configuredSince = Date.parse(mocks.listTrackerUserIdsSeenSince.mock.calls[1][0]);
    expect(Date.now() - configuredSince).toBeLessThan(2 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('skips the activity lookup entirely when nobody has sync enabled', async () => {
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue([]);

    const result = await runBackgroundSyncPass();

    expect(result).toMatchObject({ users: 0 });
    expect(mocks.listTrackerUserIdsSeenSince).not.toHaveBeenCalled();
  });

  it('gives up after repeated cloud failures instead of walking every user', async () => {
    const all = users(50);
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(all);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue(all);
    mocks.runBackgroundAuthoritySync.mockResolvedValue({ cloudReachable: false });

    const result = await runBackgroundSyncPass();

    expect(result).toMatchObject({ users: 50, synced: 0, failed: 5, abortedForOutage: true });
    expect(mocks.runBackgroundAuthoritySync).toHaveBeenCalledTimes(5);
  });

  it('keeps going when failures are not consecutive', async () => {
    const all = users(12);
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(all);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue(all);
    // Fails on every third user; the streak never reaches the abort threshold.
    mocks.runBackgroundAuthoritySync.mockImplementation(async (id: string) => ({
      cloudReachable: Number(id.split('-')[1]) % 3 !== 0,
    }));

    const result = await runBackgroundSyncPass();

    expect(result).toMatchObject({ users: 12, synced: 8, failed: 4, abortedForOutage: false });
  });

  it('counts a thrown error as a failure and still releases the user\'s handle', async () => {
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(['boom', 'fine']);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue(['boom', 'fine']);
    mocks.runBackgroundAuthoritySync.mockImplementation(async (id: string) => {
      if (id === 'boom') throw new Error('unexpected');
      return { cloudReachable: true };
    });

    const result = await runBackgroundSyncPass();

    expect(result).toMatchObject({ synced: 1, failed: 1 });
    expect(mocks.releaseBotRunTrackerRxDatabase.mock.calls.map(([id]) => id)).toEqual(['boom', 'fine']);
  });

  it('refuses to run two passes at once', async () => {
    mocks.listCloudSyncEnabledUserIds.mockResolvedValue(['slow']);
    mocks.listTrackerUserIdsSeenSince.mockResolvedValue(['slow']);
    let release: () => void = () => {};
    mocks.runBackgroundAuthoritySync.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ cloudReachable: true });
    }));

    const first = runBackgroundSyncPass();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await runBackgroundSyncPass()).toBeNull();

    release();
    await first;
  });
});
