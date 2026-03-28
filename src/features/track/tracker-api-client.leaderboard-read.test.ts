import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDocumentsMock = vi.fn();

vi.mock('../../config', () => ({
  getAppConfig: () => ({
    appwrite: {
      runsDatabaseId: 'runs-db',
      runsCollectionId: 'runs',
      settingsDatabaseId: 'settings-db',
      settingsCollectionId: 'settings',
      lifetimeDatabaseId: 'lifetime-db',
      lifetimeCollectionId: 'lifetime',
      leaderboardDatabaseId: 'leaderboard-db',
      leaderboardCollectionId: 'leaderboard',
    },
  }),
}));

vi.mock('../../persistence/appwrite-client', () => ({
  createAppwriteClient: () => ({
    databases: {
      getDocument: vi.fn(),
      updateDocument: vi.fn(),
      createDocument: vi.fn(),
      deleteDocument: vi.fn(),
      listDocuments: listDocumentsMock,
    },
    storage: {
      createFile: vi.fn(),
      deleteFile: vi.fn(),
      getFileView: vi.fn(),
    },
  }),
}));

vi.mock('../../core/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@tmrxjd/platform/node', () => ({
  extractTrackerImageText: vi.fn(),
  preprocessTrackerImageForOcr: vi.fn(),
  getDocumentOrNull: vi.fn(),
  createOrUpdateDocument: vi.fn(),
  updateOrCreateDocument: vi.fn(),
  isUnauthorizedAppwriteError: vi.fn(),
}));

vi.mock('./handlers/upload-helpers', () => ({
  extractDateTimeFromImage: vi.fn(),
  formatOCRExtraction: vi.fn(),
  parseRunDataFromText: vi.fn(),
}));

vi.mock('./vision-ocr-client', () => ({
  runDirectVisionOcr: vi.fn(),
}));

import { getCloudLeaderboardRows } from './tracker-api-client';

beforeEach(() => {
  listDocumentsMock.mockReset();
});

describe('tracker-api-client leaderboard reader', () => {
  it('builds ranked rows from shared leaderboard documents', async () => {
    listDocumentsMock.mockResolvedValue({
      documents: [
        {
          $id: 'lb-user-a',
          data: JSON.stringify({
            userId: 'user-a',
            username: 'Alice',
            tiers: {
              '1': {
                metrics: {
                  wave: { best: { metric: 'wave', tier: '1', value: '100', userId: 'user-a', username: 'Alice', isVerified: true } },
                },
              },
            },
            entries: [],
          }),
        },
        {
          $id: 'lb-user-b',
          data: JSON.stringify({
            userId: 'user-b',
            username: 'Bob',
            tiers: {
              '1': {
                metrics: {
                  wave: { best: { metric: 'wave', tier: '1', value: '150', userId: 'user-b', username: 'Bob', isVerified: true } },
                },
              },
            },
            entries: [],
          }),
        },
      ],
    });

    const rows = await getCloudLeaderboardRows({ requestedTier: '1', sourceFilter: 'tower' });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.rank).toBe(1);
    expect(rows[0]?.metrics.wave?.userId).toBe('user-b');
    expect(rows[0]?.metrics.wave?.numericValue).toBe(150);
    expect(rows[1]?.rank).toBe(2);
    expect(rows[1]?.metrics.wave?.userId).toBe('user-a');
  });

  it('filters unverified entries when verifiedOnly is requested', async () => {
    listDocumentsMock.mockResolvedValue({
      documents: [
        {
          $id: 'lb-user-a',
          data: JSON.stringify({
            userId: 'user-a',
            username: 'Alice',
            tiers: {
              '1': {
                metrics: {
                  wave: { best: { metric: 'wave', tier: '1', value: '100', userId: 'user-a', username: 'Alice', isVerified: false } },
                },
              },
            },
            entries: [],
          }),
        },
        {
          $id: 'lb-user-b',
          data: JSON.stringify({
            userId: 'user-b',
            username: 'Bob',
            tiers: {
              '1': {
                metrics: {
                  wave: { best: { metric: 'wave', tier: '1', value: '150', userId: 'user-b', username: 'Bob', isVerified: true } },
                },
              },
            },
            entries: [],
          }),
        },
      ],
    });

    const rows = await getCloudLeaderboardRows({ requestedTier: '1', sourceFilter: 'tower', verifiedOnly: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics.wave?.userId).toBe('user-b');
    expect(rows[0]?.metrics.wave?.verified).toBe(true);
  });
});
