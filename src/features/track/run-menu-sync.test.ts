import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLocalSettings: vi.fn(),
  shouldPrimeMenuFromCloud: vi.fn(),
  primeMenuCriticalRunsFromCloud: vi.fn(),
  syncUserRunDeltaPageForMenu: vi.fn(),
  clearMenuPrimedSummary: vi.fn(),
  invalidateBotLocalRunsCache: vi.fn(),
}));

vi.mock('./local-run-store', () => ({ getLocalSettings: mocks.getLocalSettings }));
vi.mock('./run-delta-sync', () => ({ syncUserRunDeltaPageForMenu: mocks.syncUserRunDeltaPageForMenu }));
vi.mock('./run-menu-cloud-prime', () => ({
  clearMenuPrimedSummary: mocks.clearMenuPrimedSummary,
  primeMenuCriticalRunsFromCloud: mocks.primeMenuCriticalRunsFromCloud,
  shouldPrimeMenuFromCloud: mocks.shouldPrimeMenuFromCloud,
}));
vi.mock('../../rxdb/run-rxdb-store', () => ({ invalidateBotLocalRunsCache: mocks.invalidateBotLocalRunsCache }));
vi.mock('./run-background-authority-sync', () => ({
  beginBackgroundAuthoritySync: vi.fn(),
  awaitBackgroundAuthoritySync: vi.fn(),
  runBackgroundAuthoritySync: vi.fn(),
}));

import { ensureMenuRunDataBeforeRender } from './run-menu-sync';

describe('ensureMenuRunDataBeforeRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocalSettings.mockResolvedValue({ cloudSyncEnabled: true });
    mocks.syncUserRunDeltaPageForMenu.mockResolvedValue({ changed: false });
  });

  it('does not fail the menu for an account with no runs yet', async () => {
    mocks.shouldPrimeMenuFromCloud.mockResolvedValue(true);
    // The prime reports "nothing in the cloud" as null.
    mocks.primeMenuCriticalRunsFromCloud.mockResolvedValue(null);

    await expect(ensureMenuRunDataBeforeRender('new-user')).resolves.toBeUndefined();
    expect(mocks.primeMenuCriticalRunsFromCloud).toHaveBeenCalledWith('new-user');
  });

  it('still surfaces a real cloud failure so the menu can fall back', async () => {
    mocks.shouldPrimeMenuFromCloud.mockResolvedValue(true);
    mocks.primeMenuCriticalRunsFromCloud.mockRejectedValue(new Error('appwrite unreachable'));

    await expect(ensureMenuRunDataBeforeRender('user-a')).rejects.toThrow('appwrite unreachable');
  });

  it('runs a delta sync for returning users and drops the local cache when it changed', async () => {
    mocks.shouldPrimeMenuFromCloud.mockResolvedValue(false);
    mocks.syncUserRunDeltaPageForMenu.mockResolvedValue({ changed: true });

    await ensureMenuRunDataBeforeRender('user-b');

    expect(mocks.syncUserRunDeltaPageForMenu).toHaveBeenCalledWith('user-b');
    expect(mocks.invalidateBotLocalRunsCache).toHaveBeenCalledWith('user-b');
    expect(mocks.clearMenuPrimedSummary).toHaveBeenCalledWith('user-b');
  });

  it('skips everything when cloud sync is off', async () => {
    mocks.getLocalSettings.mockResolvedValue({ cloudSyncEnabled: false });

    await ensureMenuRunDataBeforeRender('user-c');

    expect(mocks.shouldPrimeMenuFromCloud).not.toHaveBeenCalled();
    expect(mocks.syncUserRunDeltaPageForMenu).not.toHaveBeenCalled();
  });

  it('shares one in-flight sync between concurrent opens of the same user', async () => {
    mocks.shouldPrimeMenuFromCloud.mockResolvedValue(false);
    let release: () => void = () => {};
    mocks.syncUserRunDeltaPageForMenu.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ changed: false });
    }));

    const first = ensureMenuRunDataBeforeRender('user-d');
    const second = ensureMenuRunDataBeforeRender('user-d');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);

    expect(mocks.syncUserRunDeltaPageForMenu).toHaveBeenCalledTimes(1);
  });
});
