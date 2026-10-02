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

vi.mock('../../config', () => ({
  getAppConfig: () => ({
    deploymentMode: 'dev',
    appwrite: {
      endpoint: 'https://appwrite.example/v1',
      projectId: 'project-1',
      runsDatabaseId: 'runs-db',
      runsCollectionId: 'runs',
      runsBucketId: 'runs',
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
  isAppwriteNotFoundError: (error: {code?: number}) => error?.code === 404,
  readTrackerImageText: vi.fn(),
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
  queueCloudUpsert,
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
  getDocumentMock.mockRejectedValue({code:404,type:'document_not_found'});
  getDocumentOrNullMock.mockReset();
  updateDocumentMock.mockReset();
  createDocumentMock.mockReset();
  deleteDocumentMock.mockReset();
  listDocumentsMock.mockReset();
  createFileMock.mockReset();
  deleteFileMock.mockReset();
  delete process.env.APPWRITE_JWT;

  listDocumentsMock.mockResolvedValue({ documents: [], total: 0 });
  updateDocumentMock.mockRejectedValue({ code: 404, type: 'document_not_found', message: 'not found' });

  await clearQueue('tracker.sync.queue-local-newer');
  await clearQueue('tracker.sync.cloud-newer');
  await clearQueue('371914184822095873');
});

describe('tracker-api-client settings sync', () => {
  it.each([false, true])('reuses the attempted ID after partial write and concurrent retries (existing duplicate: %s)', async hasExistingRun => {
    const userId = `fixture.partial-write-retry-${hasExistingRun}`;
    await clearQueue(userId);
    await updateLocalSettings(userId, { cloudSyncEnabled: true });
    const main = new Map<string, Record<string, unknown>>();
    if (hasExistingRun) {
      main.set('fixture-existing-duplicate', { $id: 'fixture-existing-duplicate', userId, profileId: 'fixture-alt-a',
        tier: '5', wave: '321', totalCoins: '2B', roundDuration: '1h', spotlightDamage: '0' });
      listDocumentsMock.mockImplementation(async (_db, collection) => ({
        documents: collection === 'runs' ? [...main.values()] : [], total: collection === 'runs' ? main.size : 0,
      }));
    }
    let failExtended = true;
    getDocumentMock.mockImplementation(async (_db, collection, id) => {
      const doc = collection === 'runs' ? main.get(id) : undefined;
      if (!doc) throw { code: 404, type: 'document_not_found' };
      return { ...doc, $id: id };
    });
    updateDocumentMock.mockImplementation(async (_db, collection, id, data) => {
      if (collection === 'runs' && main.has(id)) { main.set(id, data); return {}; }
      throw { code: 404, type: 'document_not_found' };
    });
    createDocumentMock.mockImplementation(async (_db, collection, id, data) => {
      if (collection === 'runs') { main.set(id, data); return {}; }
      if (collection === 'runs_extended_data' && failExtended) throw { code: 503 };
      return {};
    });
    const result = await logRun({ userId, username: 'fixture', uploadProfileId: 'fixture-alt-a',
      skipLeaderboardRefresh: true, runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'}, localId: 'fixture-partial', tier: '5', wave: '321',
        spotlightDamage: '1Q', totalCoins: '2B', roundDuration: '1h', runDate: '2026-10-01', runTime: '12:00:00' } });
    expect(result.queuedForCloud).toBe(true);
    const attemptedId = [...main.keys()][0];
    const queued = (await getQueueItems(userId))[0];
    expect(queued.runId).toBe(attemptedId);
    expect(queued.uploadProfileId).toBe('fixture-alt-a');
    failExtended = false;
    await Promise.all([forceSyncQueuedRuns(userId), forceSyncQueuedRuns(userId)]);
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect([...main.keys()]).toEqual([attemptedId]);
    expect(main.get(attemptedId)?.profileId).toBe('fixture-alt-a');
  });
  it('blocks unknown legacy new targets without retry storms or payload deletion',async()=>{
    const userId='fixture.blocked-target';await clearQueue(userId);
    await queueCloudUpsert({userId,username:'fixture',localId:'fixture-blocked',runData:{localId:'fixture-blocked',wave:'123'}});
    await forceSyncQueuedRuns(userId);await forceSyncQueuedRuns(userId);
    const q=await getQueueItems(userId);
    expect(q).toHaveLength(1);expect(q[0].blockedReason).toBe('target-profile-required');
    expect(q[0].retryCount).toBe(0);expect(q[0].runData?.wave).toBe('123');
    expect(createDocumentMock).not.toHaveBeenCalled();
  });
  it('recovers a queued payload after a memory cache miss and uses its captured profile',async()=>{
    const userId='fixture.recover-queue';await clearQueue(userId);
    createDocumentMock.mockResolvedValue({});
    await queueCloudUpsert({userId,username:'fixture',localId:'fixture-recover-local',uploadProfileId:'fixture-alt-a',runData:{...{totalCoins:'0',totalCells:'0',totalDice:'0',roundDuration:'1h'},localId:'fixture-recover-local',wave:'123',tier:'5',type:'Farming'}});
    const queued=(await getQueueItems(userId))[0];
    await forceSyncQueuedRuns(userId);
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect(createDocumentMock.mock.calls.find(x=>x[1]==='runs')?.[3]).toMatchObject({profileId:'fixture-alt-a'});
    const local=await getLastRun(userId,{cloudSyncMode:'none'});
    expect(local?.allRuns?.some(x=>x.runId===queued.runId)).toBe(true);
  });
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
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
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
      .mockResolvedValue({ $id: 'cloud-run-1' });

    const result = await logRun({
      userId,
      uploadProfileId: null,
      username: 'tester',
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
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
    const mainRunCalls = createDocumentMock.mock.calls.filter(call => call[1] === 'runs');
    const extendedRunCalls = createDocumentMock.mock.calls.filter(call => call[1] === 'runs_extended_data');
    expect(mainRunCalls).toHaveLength(2);
    expect(extendedRunCalls).toHaveLength(1);
    expect(mainRunCalls[1]?.[2]).toBe(mainRunCalls[0]?.[2]);
    expect(extendedRunCalls[0]?.[2]).toBe(mainRunCalls[0]?.[2]);
    expect(extendedRunCalls[0]?.[3]).toEqual(expect.objectContaining({
      runId: mainRunCalls[0]?.[2],
      userId,
      spotlightDamage: '1.25Q',
      schemaVersion: 1,
    }));
  });

  it('writes the base run document before screenshot upload finishes', async () => {
    const userId = `tracker.sync.screenshot-nonblocking-${Date.now()}`;
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });

    let resolveUpload: ((value: { $id: string }) => void) | null = null;
    createFileMock.mockImplementation(() => new Promise(resolve => {
      resolveUpload = resolve as (value: { $id: string }) => void;
    }));
    createDocumentMock.mockResolvedValue({ $id: 'cloud-run-screen-1' });

    const runPromise = logRun({
      userId,
      uploadProfileId: null,
      username: 'tester',
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
        localId: 'queued-run-screen-1',
        type: 'Farming',
        tier: '10',
        wave: '1234',
      },
      screenshot: {
        data: Buffer.from('image-bytes'),
        filename: 'run.png',
        contentType: 'image/png',
      },
    });

    await vi.waitFor(() => {
      expect(createDocumentMock.mock.calls.some(call => call[1] === 'runs')).toBe(true);
    });

    if (!resolveUpload) {
      throw new Error('Expected upload resolver to be captured');
    }

    (resolveUpload as (value: { $id: string }) => void)({ $id: 'file-1' });

    const result = await runPromise;
    expect(result.queuedForCloud).toBe(false);
    expect(result.cloudUnavailable).toBe(false);
    expect('screenshotUrl' in result).toBe(true);
    if (!('screenshotUrl' in result)) {
      throw new Error('Expected screenshot URL in logRun result');
    }
    expect(result.screenshotUrl).toBe('https://appwrite.example/v1/storage/buckets/runs/files/file-1/view?project=project-1');
  });

  it('builds an Appwrite screenshot view URL from the uploaded file id', async () => {
    const userId = `tracker.sync.screenshot-view-url-${Date.now()}`;
    await updateLocalSettings(userId, {
      cloudSyncEnabled: true,
      updatedAt: 1_000,
    });

    createFileMock.mockResolvedValue({ $id: 'file-async-1' });
    createDocumentMock.mockResolvedValue({ $id: 'cloud-run-screen-async-1' });

    const result = await logRun({
      userId,
      uploadProfileId: null,
      username: 'tester',
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
        localId: 'queued-run-screen-async-1',
        type: 'Farming',
        tier: '10',
        wave: '1235',
      },
      screenshot: {
        data: Buffer.from('image-bytes'),
        filename: 'run.png',
        contentType: 'image/png',
      },
    });

    expect('screenshotUrl' in result).toBe(true);
    if (!('screenshotUrl' in result)) {
      throw new Error('Expected screenshot URL in logRun result');
    }
    expect(result.screenshotUrl).toBe('https://appwrite.example/v1/storage/buckets/runs/files/file-async-1/view?project=project-1');
  });

  it('does not borrow a shared JWT account for Discord-only uploads', async () => {
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
      uploadProfileId: null,
      username: 'tmrxjd',
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
        localId: 'queued-run-jwt-1',
        type: 'Farming',
        tier: '14',
        wave: '5639',
        coins: '131.08B',
        coinsPerKill: '68.96B',
      },
    });

    expect(result.queuedForCloud).toBe(true);
    expect(await getQueueItems(userId)).toHaveLength(1);
    expect(createDocumentMock).not.toHaveBeenCalled();
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
      uploadProfileId: null,
      username: 'tester',
      runData: { ...{totalCoins: '0', totalCells: '0', totalDice: '0', roundDuration: '1h'},
        localId: 'queued-run-2',
        type: 'Farming',
        tier: '5',
        wave: '654',
      },
      deferCloudSync: true,
    });

    expect(result.cloudSyncDeferred).toBe(true);
    expect(result.backgroundSync).toBeTruthy();
    expect(await getQueueItems(userId)).toHaveLength(1);

    const backgroundResult = await result.backgroundSync;

    expect(backgroundResult).toEqual({ queuedForCloud: false, cloudUnavailable: false });
    expect(await getQueueItems(userId)).toHaveLength(0);
    expect(createDocumentMock).toHaveBeenCalledWith(
      'run-tracker-data',
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
