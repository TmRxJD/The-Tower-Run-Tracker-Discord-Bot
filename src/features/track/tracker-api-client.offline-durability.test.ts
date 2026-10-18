const historyMock = vi.hoisted(() => vi.fn());
vi.mock('./run-cloud-pair-client', async original => ({ ...await original<object>(), loadBotCompleteRunCloudDocuments: historyMock }));
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


import { logRun, editRun, editUserSettings, forceSyncQueuedRuns, removeLastRun, retryPendingRunSync } from './tracker-api-client';
import { getLocalRuns, getQueueItems, removeLocalRun, updateLocalSettings, queueCloudUpsert } from './local-run-store';
import { getOriginalRunTarget } from './run-local-provenance';
import { restoreLocalOnlyRuns, LOCAL_ONLY_BACKUP_KEY_PREFIX } from '../../rxdb/local-only-backup';
import * as kv from '../../services/idb';
import { createDiscordSaveImportPort } from './import/save-import-port';
const complete = { tier: '5', wave: '321', totalCoins: '2B', totalCells: '3K', totalDice: 0, roundDuration: '1h', runDate: '2026-10-02', runTime: '10:00:00' };
const main = new Map<string, Record<string, unknown>>();
beforeAll(() => { const dir=join(tmpdir(), 'tracker-offline-acceptance-'+Date.now()); mkdirSync(dir,{recursive:true});process.env.TRACKER_BOT_DATA_DIR=dir; });
beforeEach(() => {
  vi.clearAllMocks(); historyMock.mockResolvedValue([]); main.clear();
  getDocumentMock.mockImplementation(async (_db, collection, id) => { const doc=collection==='runs'?main.get(id):undefined;if(!doc)throw {code:404};return {...doc,$id:id}; });
  createDocumentMock.mockImplementation(async (_db,collection,id,data) => {if(collection==='runs')main.set(id,{...data,$id:id});return {$id:id};});
  updateDocumentMock.mockImplementation(async (_db,collection,id,data) => {if(collection!=='runs'||!main.has(id))throw {code:404};main.set(id,{...main.get(id),...data});return {$id:id};});
  listDocumentsMock.mockResolvedValue({documents:[],total:0});
  getDocumentOrNullMock.mockResolvedValue(null);
});
describe('actual offline save/edit/import/re-enable acceptance',()=>{
 it('rejects incomplete direct new saves before local or cloud mutations',async()=>{
  const userId='fixture-direct-missing';await updateLocalSettings(userId,{cloudSyncEnabled:false});
  await expect(logRun({userId,username:'fixture',uploadProfileId:null,runData:{tier:'5',wave:'321'}})).rejects.toThrow('required fields');
  expect(await getLocalRuns(userId)).toHaveLength(0);expect(main.size).toBe(0);
 });
 it('awaits actual offline snapshot persistence and preserves Alt through restart and edit',async()=>{
  const userId='fixture-offline-edit';await updateLocalSettings(userId,{cloudSyncEnabled:false});
  const saved=await logRun({userId,username:'fixture',uploadProfileId:'alt-original',runData:{...complete,localId:'fixture-offline-local'}});
  expect(await getOriginalRunTarget(userId,saved.localId)).toEqual({profileId:'alt-original'});
  await removeLocalRun(userId,{localId:saved.localId});await restoreLocalOnlyRuns();
  expect((await getLocalRuns(userId))[0].totalCoins).toBe('2B');
  await updateLocalSettings(userId,{cloudSyncEnabled:true});
  createDocumentMock.mockRejectedValue({code:503});
  const edited=await editRun({userId,username:'fixture',uploadProfileId:'alt-later',runData:{...complete,localId:saved.localId,totalCoins:'4B'},deferCloudSync:true});
  await edited.backgroundSync;
  expect((await getQueueItems(userId))[0].uploadProfileId).toBe('alt-original');
  await removeLocalRun(userId,{localId:saved.localId});await restoreLocalOnlyRuns();
  expect((await getLocalRuns(userId))[0].totalCoins).toBe('4B');
  createDocumentMock.mockImplementation(async (_db,collection,id,data)=>{if(collection==='runs')main.set(id,data);return {$id:id};});
  await forceSyncQueuedRuns(userId);expect(await getQueueItems(userId)).toHaveLength(0);
  expect([...main.values()][0].profileId).toBe('alt-original');
  expect((await kv.getTrackerKv<{runs:unknown[]}>(LOCAL_ONLY_BACKUP_KEY_PREFIX+userId))?.runs).toHaveLength(0);
 });
 it('queues offline imports before enabling cloud and retains recovery during an outage',async()=>{
  const userId='fixture-offline-import';await updateLocalSettings(userId,{cloudSyncEnabled:false});
  const port=createDiscordSaveImportPort({user:{id:userId,username:'fixture'}} as never,'alt-import-original');
  await port.persistBattleReports({importable:[{...complete,localId:'fixture-import-local'}]} as never);
  const run=(await getLocalRuns(userId))[0];expect(await getOriginalRunTarget(userId,run.localId)).toEqual({profileId:'alt-import-original'});
  createDocumentMock.mockRejectedValue({code:503});
  await editUserSettings(userId,{cloudSyncEnabled:true});
  const queued=(await getQueueItems(userId)).find(item=>item.op==='upsert');expect(queued?.uploadProfileId).toBe('alt-import-original');
  await removeLocalRun(userId,{localId:run.localId});await restoreLocalOnlyRuns();
  expect((await getLocalRuns(userId)).some(r=>r.localId===run.localId)).toBe(true);
 });
 it('rejects disk failure without acknowledging, then a retry snapshots exactly one run',async()=>{
  const userId='fixture-offline-failure';await updateLocalSettings(userId,{cloudSyncEnabled:false});
  const original=kv.setTrackerKv;
  const spy=vi.spyOn(kv,'setTrackerKv').mockImplementation(async(key,value,options)=>{if(key.startsWith(LOCAL_ONLY_BACKUP_KEY_PREFIX))throw Error('fixture disk failure');return original(key,value,options);});
  const input={userId,username:'fixture',uploadProfileId:null,runData:{...complete,localId:'fixture-disk-run'}};
  await expect(logRun(input)).rejects.toThrow('disk failure');spy.mockRestore();
  await logRun(input);expect(await getLocalRuns(userId)).toHaveLength(1);
  expect((await kv.getTrackerKv<{runs:unknown[]}>(LOCAL_ONLY_BACKUP_KEY_PREFIX+userId))?.runs).toHaveLength(1);
 });
 it('unsupported-identity deletion cannot resurrect from a stale restart snapshot',async()=>{
  const userId='unsupported identity fixture';await updateLocalSettings(userId,{cloudSyncEnabled:true});
  const saved=await logRun({userId,username:'fixture',uploadProfileId:null,runData:{...complete,localId:'unsupported-local'}});
  const snapshot=await kv.getTrackerKv(LOCAL_ONLY_BACKUP_KEY_PREFIX+userId);
  await removeLastRun({userId,localId:saved.localId});
  expect((await kv.getTrackerKv<{runs:unknown[]}>(LOCAL_ONLY_BACKUP_KEY_PREFIX+userId))?.runs).toHaveLength(0);
  await kv.setTrackerKv(LOCAL_ONLY_BACKUP_KEY_PREFIX+userId,snapshot,{requirePersistent:true});
  await restoreLocalOnlyRuns();expect(await getLocalRuns(userId)).toHaveLength(0);
 });
});

it('accepts cloud-enabled submissions durably during an outage, then syncs exactly once without releasing legacy targets', async () => {
  const userId = 'fixture-future-offline';
  await updateLocalSettings(userId, { cloudSyncEnabled: true });
  await queueCloudUpsert({ userId, username: 'fixture', localId: 'legacy-unknown', runData: { ...complete, wave: '111' } });
  const legacy = structuredClone((await getQueueItems(userId))[0]);
  let recover!: (rows: object[]) => void;
  historyMock.mockImplementationOnce(() => new Promise(resolve => { recover = resolve; }));
  const started = performance.now();
  const accepted = await logRun({ userId, username: 'fixture', uploadProfileId: 'alt-original', runData: { ...complete, localId: 'new-offline-run' }, deferCloudSync: true });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(accepted).toMatchObject({ ok: true, queuedForCloud: true, cloudSyncDeferred: true });
  const queued = (await getQueueItems(userId)).find(item => item.localId === 'new-offline-run')!;
  expect(queued).toMatchObject({ uploadProfileId: 'alt-original', duplicateCheckPending: true });
  expect(await getOriginalRunTarget(userId, 'new-offline-run')).toEqual({ profileId: 'alt-original' });
  expect(createDocumentMock).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(historyMock).toHaveBeenCalled());
  recover([]); await accepted.backgroundSync;
  expect(main.size).toBe(1);
  expect([...main.keys()]).toEqual([queued.runId]);
  expect(await getQueueItems(userId)).toEqual([legacy]);
  await retryPendingRunSync(userId);
  expect(main.size).toBe(1); expect(await getQueueItems(userId)).toEqual([legacy]);
});
it('resolves a matching website report before writing and persists that identity through recovery', async () => {
  const userId = 'fixture-cloud-duplicate'; await updateLocalSettings(userId, { cloudSyncEnabled: true });
  const remote = { ...complete, $id: 'website-existing', runId: 'website-existing', userId, profileId: null };
  main.set('website-existing', remote); historyMock.mockResolvedValue([remote]);
  const accepted = await logRun({ userId, username: 'fixture', uploadProfileId: null, runData: { ...complete, localId: 'duplicate-local' }, deferCloudSync: true });
  await accepted.backgroundSync;
  expect([...main.keys()]).toEqual(['website-existing']);
  expect(await getQueueItems(userId)).toHaveLength(0);
  expect((await getLocalRuns(userId))[0].runId).toBe('website-existing');
});
it('does not acknowledge a cloud-enabled submission when the durable queue write fails', async () => {
  const userId = 'fixture-queue-disk-failure'; await updateLocalSettings(userId, { cloudSyncEnabled: true });
  const original = kv.setTrackerKv;
  const spy = vi.spyOn(kv, 'setTrackerKv').mockImplementation(async (key, value, options) => {
    if (key === 'tracker-local-store:v1' && (value as { queue: unknown[] }).queue.length) throw Error('fixture queue disk failure');
    return original(key, value, options);
  });
  try {
    await expect(logRun({ userId, username: 'fixture', uploadProfileId: null, runData: { ...complete, localId: 'failed-queue-local' }, deferCloudSync: true })).rejects.toThrow('queue disk failure');
    expect(createDocumentMock).not.toHaveBeenCalled();
    expect((await getQueueItems(userId)).some(item => item.localId === 'failed-queue-local')).toBe(false);
  } finally { spy.mockRestore(); }
});

it('automatically recovers future intents after a long outage without releasing exhausted legacy entries', async () => {
  const userId = 'fixture-auto-recovery'; await updateLocalSettings(userId, { cloudSyncEnabled: true });
  await queueCloudUpsert({ userId, username: 'fixture', uploadProfileId: null, localId: 'future-long-outage', runData: { ...complete, localId: 'future-long-outage' }, automaticRecovery: true });
  const pending = (await getQueueItems(userId))[0];
  // Isolated restored-queue fixture after more failures than the legacy retry cap.
  pending.retryCount = 12; pending.nextRetryAt = 0;
  await retryPendingRunSync(userId);
  expect(await getQueueItems(userId)).toHaveLength(0); expect(main.size).toBe(1);
});

it('coalesces duplicate history only within a recovery pass and verifies again on the next pass', async () => {
  const userId = 'fixture-recovery-coalescing'; await updateLocalSettings(userId, { cloudSyncEnabled: true });
  for (const wave of ['401', '402']) await queueCloudUpsert({ userId, username: 'fixture', uploadProfileId: null, localId: 'coalesce-' + wave,
    runData: { ...complete, wave, localId: 'coalesce-' + wave }, automaticRecovery: true, duplicateCheckPending: true });
  await retryPendingRunSync(userId);
  expect(historyMock).toHaveBeenCalledTimes(1); expect(main.size).toBe(2);
  await queueCloudUpsert({ userId, username: 'fixture', uploadProfileId: null, localId: 'coalesce-403',
    runData: { ...complete, wave: '403', localId: 'coalesce-403' }, automaticRecovery: true, duplicateCheckPending: true });
  await retryPendingRunSync(userId);
  expect(historyMock).toHaveBeenCalledTimes(2); expect(main.size).toBe(3);
});
