import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListFirstDocument = vi.fn();
const mockGetTrackerUserSettings = vi.fn();
const mockUpsertTrackerUserSettings = vi.fn();

vi.mock('@tmrxjd/platform/node', () => ({
  listFirstDocument: (...args: unknown[]) => mockListFirstDocument(...args),
}));

vi.mock('../config', () => ({
  getAppConfig: () => ({
    appwrite: {
      databaseId: 'tracker',
      userSettingsCollectionId: 'users',
    },
  }),
}));

vi.mock('../services/idb', () => ({
  getTrackerUserSettings: (...args: unknown[]) => mockGetTrackerUserSettings(...args),
  upsertTrackerUserSettings: (...args: unknown[]) => mockUpsertTrackerUserSettings(...args),
}));

vi.mock('../core/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('node-appwrite', () => ({
  ID: {
    unique: () => 'generated-id',
  },
  Query: {
    equal: (field: string, value: unknown) => ({ field, value, op: 'equal' }),
    limit: (value: number) => ({ value, op: 'limit' }),
  },
}));

describe('UsersRepo', () => {
  beforeEach(() => {
    vi.resetModules();
    mockListFirstDocument.mockReset();
    mockGetTrackerUserSettings.mockReset();
    mockUpsertTrackerUserSettings.mockReset();
  });

  it('hydrates remote user settings by picking known fields only', async () => {
    mockGetTrackerUserSettings.mockResolvedValue(null);
    mockListFirstDocument.mockResolvedValue({
      $id: 'remote-user',
      $collectionId: 'users',
      userId: 'user-1',
      username: 'Tracker One',
      defaultTracker: 'uw',
      defaultRunType: 'run',
      scanLanguage: 'en',
      decimalPreference: 'comma',
      shareSettings: 'public',
      lastSeen: '2026-03-27T10:00:00.000Z',
      updatedAt: '2026-03-27T11:00:00.000Z',
      unexpectedField: 'ignored',
    });

    const { UsersRepo } = await import('./users-repo.js');
    const repo = new UsersRepo({
      listDocuments: (...args: unknown[]) => mockListFirstDocument(...args),
      getDocument: vi.fn(),
      updateDocument: vi.fn(),
      createDocument: vi.fn(),
    } as never);

    const user = await repo.getByUserId('user-1');

    expect(user?.userId).toBe('user-1');
    expect(user?.username).toBe('Tracker One');
    expect(user?.updatedAt).toBe('2026-03-27T11:00:00.000Z');
    expect(mockUpsertTrackerUserSettings).toHaveBeenCalledTimes(1);
  });
});