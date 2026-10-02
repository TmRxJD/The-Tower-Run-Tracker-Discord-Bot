import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn(), ingest: vi.fn(), set: vi.fn(), get: vi.fn() }));
vi.mock('../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: {} }) }));
vi.mock('../../services/idb', () => ({ getTrackerKv: m.get, setTrackerKv: m.set }));
vi.mock('../../core/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('./run-cloud-identity', () => ({ resolveBotRunCloudIdentity: async () => ({ cloudWriteUserId: 'fixture-owner', lookupUserIds: ['fixture-owner'] }) }));
vi.mock('../../rxdb/reactive-sync', () => ({ bindBotRunTrackerRxDBInboundSync: vi.fn() }));
vi.mock('../../rxdb/run-rxdb-store', () => ({ ensureBotRunTrackerRxDatabase: async () => ({}), loadLocalRunsFromBotRxDB: async () => [{}] }));
vi.mock('../../rxdb/persistence', () => ({ getMaxUpdatedAtMsForBotScopeUser: async () => 0 }));
vi.mock('./local-run-store', () => ({ getLocalSettings: async () => ({ cloudSyncEnabled: true }) }));
vi.mock('./run-delta-function-client', () => ({ fetchTrackerRunDeltasFromFunction: m.fetch }));
vi.mock('./run-sync-ingest', () => ({ ingestMergedRunsIntoBotStore: m.ingest }));
import { bulkImportAllRunsFromCloud, syncUserRunDeltaPageForMenu } from './run-delta-sync';
describe('audit: complete-page cursor invariants', () => {
 beforeEach(() => { vi.clearAllMocks(); m.get.mockResolvedValue(100); m.ingest.mockResolvedValue({ingested: 1}); m.set.mockResolvedValue(undefined); });
 it('does not checkpoint an unfinished menu delta page', async () => {
  m.fetch.mockResolvedValue({ runs: [{runId:'fixture-run'}], count:1, syncedAtMs:200, nextPage:{pageOffset:100} });
  await syncUserRunDeltaPageForMenu('fixture-discord');
  expect(m.ingest).toHaveBeenCalledWith('fixture-discord', expect.any(Array), 200, {persistSyncCursor:false});
  expect(m.set).not.toHaveBeenCalled();
 });
 it('does not report success or checkpoint when a bulk page fails', async () => {
  m.fetch.mockImplementation(async ({pageOffset}:{pageOffset?:number}) => {
   if (pageOffset === 2) throw new Error('fixture outage');
   return {runs: pageOffset ? [] : [{runId:'fixture-run'}], count: pageOffset ? 0 : 1, syncedAtMs:200, nextPage:null};
  });
  const result = await bulkImportAllRunsFromCloud('fixture-discord', 2);
  expect(result.success).toBe(false);
  expect(m.set).not.toHaveBeenCalled();
 });
});
