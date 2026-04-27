import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const getDocumentMock = vi.fn();
const getDocumentOrNullMock = vi.fn();
const updateDocumentMock = vi.fn();
const createDocumentMock = vi.fn();
const deleteDocumentMock = vi.fn();
const listDocumentsMock = vi.fn();
const createFileMock = vi.fn();
const deleteFileMock = vi.fn();
const getFileViewMock = vi.fn();

vi.mock('../../config', () => ({
  getAppConfig: () => ({
    deploymentMode: 'dev',
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
      deleteDocument: deleteDocumentMock,
      listDocuments: listDocumentsMock,
    },
    storage: {
      createFile: createFileMock,
      deleteFile: deleteFileMock,
      getFileView: getFileViewMock,
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

import { forceSyncQueuedRuns, getLastRun, getUserSettings, logRun } from './tracker-api-client';
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
  deleteDocumentMock.mockReset();
  listDocumentsMock.mockReset();
  createFileMock.mockReset();
  deleteFileMock.mockReset();
  getFileViewMock.mockReset();
  delete process.env.APPWRITE_JWT;

  listDocumentsMock.mockResolvedValue({ documents: [], total: 0 });

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
      undefined,
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

  it('returns local-only summaries without replaying queued runs', async () => {
    const userId = `tracker.sync.summary-none-${Date.now()}`;
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });
    createDocumentMock.mockRejectedValue({
      code: 400,
      type: 'document_invalid_structure',
      message: 'Invalid document structure: Unknown attribute: "createdAt"',
    });

    await logRun({
      userId,
      username: 'tester',
      runData: {
        localId: 'queued-run-1',
        type: 'Farming',
        tier: '4',
        wave: '321',
        notes: 'queued',
      },
    });

    createDocumentMock.mockClear();

    const summary = await getLastRun(userId, { cloudSyncMode: 'none' });

    expect(await getQueueItems(userId)).toHaveLength(1);
    expect(summary?.allRuns).toHaveLength(1);
    expect(summary?.lastRun).toEqual(expect.objectContaining({
      tier: '4',
      wave: '321',
      type: 'Farming',
    }));
    expect(createDocumentMock).not.toHaveBeenCalled();
  });

  it('retries run writes after stripping unsupported Appwrite attributes', async () => {
    const userId = `tracker.sync.strip-unsupported-${Date.now()}`;
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });

    createDocumentMock
      .mockRejectedValueOnce({
        code: 400,
        type: 'document_invalid_structure',
        message: 'Invalid document structure: Unknown attribute: "verified"',
      })
      .mockResolvedValueOnce({ $id: 'cloud-run-1' });

    const result = await logRun({
      userId,
      username: 'tester',
      runData: {
        localId: 'queued-run-strip-1',
        type: 'Farming',
        tier: '9',
        wave: '999',
        verified: true,
        spotlightDamage: '1.25Q',
      },
    });

    expect(result.queuedForCloud).toBe(false);
    expect(result.cloudUnavailable).toBe(false);
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect(createDocumentMock).toHaveBeenCalledTimes(3);
    expect(createDocumentMock.mock.calls[0]?.[0]).toBe('runs-db');
    expect(createDocumentMock.mock.calls[0]?.[1]).toBe('runs');
    expect(createDocumentMock.mock.calls[1]?.[0]).toBe('runs-db');
    expect(createDocumentMock.mock.calls[1]?.[1]).toBe('runs');
    expect(createDocumentMock.mock.calls[1]?.[2]).toBe(createDocumentMock.mock.calls[0]?.[2]);
    expect(createDocumentMock.mock.calls[2]?.[0]).toBe('runs-db');
    expect(createDocumentMock.mock.calls[2]?.[1]).toBe('runs_extended_data');
    expect(createDocumentMock.mock.calls[2]?.[2]).toBe(createDocumentMock.mock.calls[0]?.[2]);
    expect(createDocumentMock.mock.calls[2]?.[3]).toEqual(expect.objectContaining({
      runId: createDocumentMock.mock.calls[0]?.[2],
      userId,
      spotlightDamage: '1.25Q',
      schemaVersion: 1,
    }));
  });

  it('uses the dev Appwrite JWT user id for permissions when the upload user id is discord-only', async () => {
    const userId = '371914184822095873';
    process.env.APPWRITE_JWT = [
      'header',
      Buffer.from(JSON.stringify({ userId: '681ab667ce6096096b3b' })).toString('base64url'),
      'signature',
    ].join('.');

    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });

    createDocumentMock.mockResolvedValue({ $id: 'cloud-run-jwt-1' });

    const result = await logRun({
      userId,
      username: 'tmrxjd',
      runData: {
        localId: 'queued-run-jwt-1',
        type: 'Farming',
        tier: '14',
        wave: '5639',
        coins: '131.08B',
        coinsPerKill: '68.96B',
      },
    });

    expect(result.queuedForCloud).toBe(false);
    expect(createDocumentMock.mock.calls[0]?.[4]).toEqual([
      'read("user:681ab667ce6096096b3b")',
      'update("user:681ab667ce6096096b3b")',
      'delete("user:681ab667ce6096096b3b")',
    ]);
    expect(createDocumentMock.mock.calls[1]?.[1]).toBe('runs_extended_data');
    expect(createDocumentMock.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
      userId,
      coinsPerKill: '68.96B',
    }));
    expect(createDocumentMock.mock.calls[1]?.[4]).toEqual([
      'read("user:681ab667ce6096096b3b")',
      'update("user:681ab667ce6096096b3b")',
      'delete("user:681ab667ce6096096b3b")',
    ]);
  });

  it('defers cloud run sync without blocking the local save result', async () => {
    const userId = `tracker.sync.defer-cloud-${Date.now()}`;
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });
    createDocumentMock.mockResolvedValue({ $id: 'cloud-run-2' });

    const result = await logRun({
      userId,
      username: 'tester',
      runData: {
        localId: 'queued-run-2',
        type: 'Farming',
        tier: '5',
        wave: '654',
      },
      deferCloudSync: true,
    });

    expect(result.cloudSyncDeferred).toBe(true);
    expect(result.backgroundSync).toBeTruthy();
    expect(await getQueueItems(userId)).toHaveLength(0);

    const backgroundResult = await result.backgroundSync;

    expect(backgroundResult).toEqual({ queuedForCloud: false, cloudUnavailable: false });
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect(createDocumentMock).toHaveBeenCalledWith(
      'runs-db',
      'runs',
      expect.any(String),
      expect.objectContaining({
        userId,
        username: 'tester',
        tier: '5',
        wave: '654',
      }),
      expect.any(Array),
    );
  });
});