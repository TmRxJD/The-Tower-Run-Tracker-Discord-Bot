import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const getDocumentMock = vi.fn();
const getDocumentOrNullMock = vi.fn();
const updateDocumentMock = vi.fn();
const createDocumentMock = vi.fn();

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
      getDocument: getDocumentMock,
      updateDocument: updateDocumentMock,
      createDocument: createDocumentMock,
      deleteDocument: vi.fn(),
      listDocuments: vi.fn(),
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
  getDocumentOrNull: (...args: unknown[]) => getDocumentOrNullMock(...args),
  updateOrCreateDocument: async ({ databaseId, collectionId, documentId, data }: { databaseId: string; collectionId: string; documentId: string; data: Record<string, unknown> }) => {
    try {
      await createDocumentMock(databaseId, collectionId, documentId, data);
      return 'created';
    } catch (error) {
      const maybeError = error as { code?: number };
      if (maybeError.code !== 409) {
        throw error;
      }

      await updateDocumentMock(databaseId, collectionId, documentId, data);
      return 'updated';
    }
  },
}));

vi.mock('./handlers/upload-helpers', () => ({
  extractDateTimeFromImage: vi.fn(),
  formatOCRExtraction: vi.fn(),
  parseRunDataFromText: vi.fn(),
}));

vi.mock('./vision-ocr-client', () => ({
  runDirectVisionOcr: vi.fn(),
}));

import { forceSyncQueuedRuns, getUserSettings } from './tracker-api-client';
import {
  getLocalSettingsRecord,
  getQueueItems,
  queueCloudSettings,
  removeQueueItem,
  updateLocalSettings,
} from './local-run-store';

beforeAll(() => {
  const testDataDir = join(tmpdir(), `trackerbot-settings-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDataDir, { recursive: true });
  process.env.TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK = 'true';
  process.env.TRACKER_BOT_DATA_DIR = testDataDir;
});

async function clearQueue(userId: string): Promise<void> {
  const existing = await getQueueItems(userId);
  for (const item of existing) {
    await removeQueueItem(item.id);
  }
}

beforeEach(async () => {
  getDocumentMock.mockReset();
  getDocumentOrNullMock.mockReset();
  updateDocumentMock.mockReset();
  createDocumentMock.mockReset();

  await clearQueue('tracker.sync.queue-local-newer');
  await clearQueue('tracker.sync.cloud-newer');
});

describe('tracker-api-client settings sync', () => {
  it('replays queued settings with the newer local state', async () => {
    const userId = 'tracker.sync.queue-local-newer';
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      defaultRunType: 'Tournament',
      updatedAt: 2_000,
    });
    await queueCloudSettings({
      userId,
      settingsData: {
        defaultTracker: 'Web',
        defaultRunType: 'Farming',
        cloudSyncEnabled: true,
      },
      settingsUpdatedAt: 1_000,
    });
    createDocumentMock.mockRejectedValue({ code: 409 });
    updateDocumentMock.mockResolvedValue(undefined);

    const remaining = await forceSyncQueuedRuns(userId);

    expect(remaining).toBe(0);
    expect(updateDocumentMock).toHaveBeenCalledWith(
      'settings-db',
      'settings',
      userId,
      expect.objectContaining({
        defaultTracker: 'Web',
        defaultRunType: 'Tournament',
        updatedAt: new Date(2_000).toISOString(),
      }),
    );
    expect(createDocumentMock).toHaveBeenCalledWith(
      'settings-db',
      'settings',
      userId,
      expect.objectContaining({
        defaultTracker: 'Web',
        defaultRunType: 'Tournament',
        updatedAt: new Date(2_000).toISOString(),
      }),
    );
    expect(await getQueueItems(userId)).toHaveLength(0);
  });

  it('hydrates local settings when the cloud copy is newer', async () => {
    const userId = 'tracker.sync.cloud-newer';
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      defaultRunType: 'Farming',
      updatedAt: 1_000,
    });
    getDocumentOrNullMock.mockResolvedValue({
      defaultRunType: 'Tournament',
      updatedAt: new Date(2_000).toISOString(),
    });

    const settings = await getUserSettings(userId);
    const localRecord = await getLocalSettingsRecord(userId);

    expect(settings?.defaultRunType).toBe('Tournament');
    expect(localRecord.state.defaultRunType).toBe('Tournament');
    expect(localRecord.updatedAt).toBe(2_000);
  });
});