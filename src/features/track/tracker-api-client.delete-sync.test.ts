import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const getDocumentMock = vi.fn();
const updateDocumentMock = vi.fn();
const createDocumentMock = vi.fn();
const deleteDocumentMock = vi.fn();
const listDocumentsMock = vi.fn();
const createFileMock = vi.fn();
const deleteFileMock = vi.fn();
const getFileViewMock = vi.fn();
const deleteTrackerRunCloudDocumentsMock = vi.fn();
const isTrackerCloudAddressableUserIdMock = vi.fn(() => false);
const resolveAppwriteIdForDiscordUserMock = vi.fn<(discordId: string) => Promise<string | null>>(async () => null);

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

vi.mock('../../services/discord-identity-resolver', () => ({
  resolveAppwriteIdForDiscordUser: (discordId: string) => resolveAppwriteIdForDiscordUserMock(discordId),
}));

vi.mock('@tmrxjd/platform/node', () => ({
  extractTrackerImageText: vi.fn(),
  preprocessTrackerImageForOcr: vi.fn(),
  getDocumentOrNull: vi.fn(async () => null),
  updateOrCreateDocument: vi.fn(),
}));

vi.mock('./handlers/upload-helpers', () => ({
  extractDateTimeFromImage: vi.fn(),
  formatOCRExtraction: vi.fn(),
  parseRunDataFromText: vi.fn(),
}));

vi.mock('./vision-ocr-client', () => ({
  runDirectVisionOcr: vi.fn(),
}));

vi.mock('@tmrxjd/platform/tools', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tmrxjd/platform/tools');
  return {
    ...actual,
    isTrackerCloudAddressableUserId: (...args: Parameters<typeof isTrackerCloudAddressableUserIdMock>) => isTrackerCloudAddressableUserIdMock(...args),
    extractTrackerAppwriteUserIdFromJwt: vi.fn(() => null),
    deleteTrackerRunCloudDocuments: (...args: Parameters<typeof deleteTrackerRunCloudDocumentsMock>) => deleteTrackerRunCloudDocumentsMock(...args),
  };
});

import { forceSyncQueuedRuns, getLastRun, removeLastRun } from './tracker-api-client';
import { getQueueItems, queueCloudDelete, queueCloudUpsert, removeQueueItem, upsertLocalRun } from './local-run-store';
import { ingestMergedRunsIntoBotStore } from './run-sync-ingest';

beforeAll(() => {
  const testDataDir = join(tmpdir(), `trackerbot-delete-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  updateDocumentMock.mockReset();
  createDocumentMock.mockReset();
  deleteDocumentMock.mockReset();
  listDocumentsMock.mockReset();
  createFileMock.mockReset();
  deleteFileMock.mockReset();
  getFileViewMock.mockReset();
  deleteTrackerRunCloudDocumentsMock.mockReset();
  isTrackerCloudAddressableUserIdMock.mockReset();
  resolveAppwriteIdForDiscordUserMock.mockReset();
  resolveAppwriteIdForDiscordUserMock.mockResolvedValue(null);
  isTrackerCloudAddressableUserIdMock.mockReturnValue(false);
  listDocumentsMock.mockResolvedValue({ documents: [], total: 0 });

  await clearQueue('discord-delete-no-identity');
  await clearQueue('discord-queued-delete-no-identity');
  await clearQueue('discord-delete-hydration-race');
  await clearQueue('discord-stale-local-run-reconcile');
});

describe('tracker-api-client delete sync', () => {
  it('still deletes the cloud run when identity resolution is unavailable', async () => {
    const userId = 'discord-delete-no-identity';
    await upsertLocalRun(userId, 'tester', {
      localId: 'local-run-1',
      runId: 'cloud-run-1',
      type: 'Farming',
      updatedAt: Date.now(),
    });

    await removeLastRun({
      userId,
      runId: 'cloud-run-1',
      localId: 'local-run-1',
    });

    const summary = await getLastRun(userId, { cloudSyncMode: 'none' });

    expect(deleteTrackerRunCloudDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({
      databaseId: 'runs-db',
      mainCollectionId: 'runs',
      runId: 'cloud-run-1',
    }));
    expect(summary?.allRuns ?? []).toHaveLength(0);
    expect(await getQueueItems(userId)).toHaveLength(0);
  });

  it('replays queued deletes even when identity resolution is unavailable', async () => {
    const userId = 'discord-queued-delete-no-identity';
    await queueCloudDelete({
      userId,
      username: 'tester',
      runId: 'cloud-run-queued',
    });

    const remaining = await forceSyncQueuedRuns(userId);

    expect(deleteTrackerRunCloudDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({
      databaseId: 'runs-db',
      mainCollectionId: 'runs',
      runId: 'cloud-run-queued',
    }));
    expect(remaining).toBe(0);
    expect(await getQueueItems(userId)).toHaveLength(0);
  });

  it('queues the delete when the extended run document delete is unauthorized', async () => {
    const userId = 'discord-delete-extended-unauthorized';
    deleteTrackerRunCloudDocumentsMock.mockRejectedValueOnce({
      code: 401,
      type: 'general_unauthorized_scope',
      message: 'Missing permission for runs_extended_data delete',
    });

    await upsertLocalRun(userId, 'tester', {
      localId: 'local-run-unauthorized-1',
      runId: 'cloud-run-unauthorized-1',
      type: 'Farming',
      updatedAt: Date.now(),
    });

    await removeLastRun({
      userId,
      runId: 'cloud-run-unauthorized-1',
      localId: 'local-run-unauthorized-1',
    });

    expect(deleteTrackerRunCloudDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({
      databaseId: 'runs-db',
      mainCollectionId: 'runs',
      extendedCollectionId: 'runs_extended_data',
      runId: 'cloud-run-unauthorized-1',
    }));
    expect(await getQueueItems(userId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'delete',
        userId,
        runId: 'cloud-run-unauthorized-1',
      }),
    ]));
  });

  it('does not resurrect a permanently deleted run during background ingest', async () => {
    const userId = 'discord-delete-ingest-tombstone';
    isTrackerCloudAddressableUserIdMock.mockReturnValue(true);

    await upsertLocalRun(userId, 'tester', {
      localId: 'local-run-race-1',
      runId: 'cloud-run-race-1',
      type: 'Farming',
      tier: '12',
      wave: '4567',
      date: '2026-05-29',
      time: '10:00 PM',
      runDate: '2026-05-29',
      runTime: '10:00 PM',
      duration: '1h',
      coins: '1B',
      cells: '1M',
      rerollShards: '1K',
      killedBy: 'Boss',
      updatedAt: Date.now(),
    });

    await removeLastRun({
      userId,
      runId: 'cloud-run-race-1',
      localId: 'local-run-race-1',
    });

    await ingestMergedRunsIntoBotStore(userId, [{
      runId: 'cloud-run-race-1',
      type: 'Farming',
      tier: '12',
      wave: '4567',
      date: '2026-05-29',
      time: '10:00 PM',
      runDate: '2026-05-29',
      runTime: '10:00 PM',
      duration: '1h',
      coins: '1B',
      cells: '1M',
      rerollShards: '1K',
      killedBy: 'Boss',
      updatedAt: Date.now(),
    }]);

    const summary = await getLastRun(userId, { cloudSyncMode: 'none' });
    expect(summary?.allRuns ?? []).toHaveLength(0);
    expect(deleteTrackerRunCloudDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'cloud-run-race-1',
    }));
  });

  it('drops queued upserts for a run that was deleted before replay', async () => {
    const userId = 'discord-delete-prunes-upsert';

    await upsertLocalRun(userId, 'tester', {
      localId: 'local-run-delete-queued-1',
      type: 'Farming',
      tier: '20',
      wave: '5136',
      date: '2026-05-29',
      time: '08:26:36',
      runDate: '2026-05-28',
      runTime: '07:07:00',
      duration: '3h57m42s',
      coins: '365.95Q',
      updatedAt: Date.now(),
    });

    await queueCloudUpsert({
      userId,
      username: 'tester',
      localId: 'local-run-delete-queued-1',
      runData: {
        localId: 'local-run-delete-queued-1',
        type: 'Farming',
        tier: '20',
        wave: '5136',
        date: '2026-05-29',
        time: '08:26:36',
        runDate: '2026-05-28',
        runTime: '07:07:00',
        duration: '3h57m42s',
        coins: '365.95Q',
      },
    });

    await removeLastRun({
      userId,
      localId: 'local-run-delete-queued-1',
    });

    const remaining = await forceSyncQueuedRuns(userId);

    expect(remaining).toBe(0);
    expect(createDocumentMock).not.toHaveBeenCalled();
    expect(updateDocumentMock).not.toHaveBeenCalled();
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect((await getLastRun(userId, { cloudSyncMode: 'none' }))?.allRuns ?? []).toHaveLength(0);
  });

  it('preserves local cloud-backed runs when full cloud hydration returns zero documents', async () => {
    const userId = 'discord-stale-local-run-reconcile';
    isTrackerCloudAddressableUserIdMock.mockReturnValue(true);

    await upsertLocalRun(userId, 'tester', {
      localId: 'local-run-stale-1',
      runId: 'cloud-run-stale-1',
      type: 'Farming',
      tier: '14',
      wave: '5136',
      date: '2026-05-29',
      time: '11:15 AM',
      runDate: '2026-05-29',
      runTime: '11:15 AM',
      duration: '1h2m3s',
      coins: '1B',
      cells: '1M',
      rerollShards: '1K',
      killedBy: 'Boss',
      updatedAt: Date.now(),
    });

    listDocumentsMock.mockResolvedValue({ documents: [], total: 0 });

    const summary = await getLastRun(userId, { cloudSyncMode: 'full' });
    const localOnlySummary = await getLastRun(userId, { cloudSyncMode: 'none' });

    expect(summary?.allRuns ?? []).toHaveLength(1);
    expect(localOnlySummary?.allRuns ?? []).toHaveLength(1);
  });

  it('falls back to direct extended document reads so legacy split docs still hydrate immediately', async () => {
    const userId = 'discord-extended-fallback';
    isTrackerCloudAddressableUserIdMock.mockReturnValue(true);

    listDocumentsMock.mockImplementation(async (_databaseId: string, collectionId: string, queries?: unknown[]) => {
      const queryText = Array.isArray(queries) ? queries.map(value => String(value)).join(' ') : '';
      if (collectionId === 'runs') {
        return {
          documents: [{
            $id: 'run-1',
            userId,
            username: 'tester',
            date: '2026-05-29',
            time: '10:00 PM',
            runDate: '2026-05-29',
            runTime: '10:00 PM',
            duration: '1h',
            type: 'Farming',
            tier: '12',
            wave: '4567',
            coins: '1B',
            cells: '1M',
            rerollShards: '1K',
            killedBy: 'Boss',
            public: 'false',
          }],
          total: 1,
        };
      }

      if (collectionId === 'runs_extended_data') {
        if (queryText.includes('userId:discord-extended-fallback')) {
          return { documents: [], total: 0 };
        }
      }

      return { documents: [], total: 0 };
    });
    getDocumentMock.mockImplementation(async (_databaseId: string, collectionId: string, documentId: string) => {
      if (collectionId === 'runs_extended_data' && documentId === 'run-1') {
        return {
          $id: 'run-1',
          runId: 'run-1',
          userId: 'legacy_user_variant',
          highestCoinsPerMinute: '7.41T',
        };
      }
      return {};
    });

    const summary = await getLastRun(userId, { cloudSyncMode: 'full' });

    expect(summary?.allRuns?.[0]?.highestCoinsPerMinute).toBe('7.41T');
    expect(getDocumentMock).toHaveBeenCalledWith('run-tracker-data', 'runs_extended_data', 'run-1');
  });
});