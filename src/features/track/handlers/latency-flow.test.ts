import { beforeEach, expect, it, vi } from 'vitest';
import type * as HistoryModule from '../run-upload-history';
const io = vi.hoisted(() => ({ list: vi.fn(), local: vi.fn(), upsert: vi.fn(), settings: vi.fn(), create: vi.fn(), pending: vi.fn(), intent: vi.fn(), remove: vi.fn(), save: vi.fn(), snapshot: vi.fn(), errors: vi.fn(), forceFullReview: false }));
vi.mock('../../../core/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: { listDocuments: io.list } }) }));
vi.mock('../run-cloud-identity', () => ({ resolveBotRunCloudIdentity: async () => ({ lookupUserIds: ['fixture-owner', 'legacy-owner'] }) }));
vi.mock('../../../rxdb/run-rxdb-store', async original => ({ ...await original<object>(), loadLocalRunsFromBotRxDB: io.local, upsertMergedRunsIntoBotRxDB: io.upsert }));
vi.mock('../local-run-store', async original => ({ ...await original<object>(), getLocalSettings: io.settings, getQueueItems: async () => [] }));
vi.mock('../run-deletion-tombstones', () => ({ getPermanentlyDeletedRunIds: async () => new Set() }));
vi.mock('../run-upload-history', async original => {
  const actual = await original<typeof HistoryModule>();
  return { ...actual, prepareBotRunUploadHistory: (user: string, options: Parameters<typeof actual.prepareBotRunUploadHistory>[1]) => actual.prepareBotRunUploadHistory(user, io.forceFullReview ? { ...options, localFirst: false, mainOnly: false } : options) };
});
vi.mock('../paste-diagnostics', () => ({ beginPasteDiagnostic: async () => 'P-fixture', updatePasteDiagnostic: async () => true }));
vi.mock('../pending-run-store', async original => ({ ...await original<object>(), createPendingRun: io.create, getPendingRun: io.pending, markPendingRunWriteIntent: io.intent, deletePendingRun: io.remove }));
vi.mock('../tracker-api-client', async original => ({ ...await original<object>(), getUserSettings: io.settings, logRun: io.save, editRun: io.save }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'last' }) }));
vi.mock('../upload-target-profile', () => ({ listBotUserProfiles: async () => [], peekPendingUploadProfile: () => null, resolveDefaultUploadProfileId: async () => null, setPendingUploadProfile: vi.fn() }));
vi.mock('./review-interaction-helpers', async original => ({ ...await original<object>(), isTrackReviewFlowEnabled: () => true }));
vi.mock('../share/auto-log-channel-share', () => ({ autoShareToConfiguredLogChannel: async () => undefined }));
vi.mock('../share/share-snapshot-store', () => ({ saveShareSnapshot: io.snapshot }));
vi.mock('../share/share-embed-delivery', () => ({ resolveShareEmbedChannelPayload: async (input: object) => input }));
vi.mock('./error-handlers', () => ({ handleError: io.errors, logError: io.errors }));
import { handleDirectTextPaste } from './upload-handlers';
import { handleDataSubmission } from './data-review-handlers';
import { handleTrackMenuShareLast } from './share-handlers';
import { setTrackerFlowMode } from '../flow-mode-store';

type Row = Record<string, unknown>;
let cloud: Row[], local: Row[], drafts: Map<string, Row>;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function interaction() {
  return { customId: 'tracker_accept:flow-fixture', user: { id: 'fixture-owner', username: 'fixture', displayAvatarURL: () => '' }, client: {}, guildId: null,
    deferred: true, replied: false, deferUpdate: vi.fn(async () => { await delay(2); }),
    editReply: vi.fn(async () => { await delay(2); return {}; }), followUp: vi.fn(async (payload: unknown) => { void payload; }),
    channel: { send: vi.fn(async (payload: unknown) => { void payload; await delay(2); return {}; }) }, message: { components: [] } };
}
beforeEach(() => {
  vi.clearAllMocks(); io.forceFullReview = false; setTrackerFlowMode('fixture-owner', 'track');
  cloud = Array.from({ length: 1360 }, (_, i) => ({ $id: `run-${String(i).padStart(4, '0')}`, userId: 'fixture-owner', type: 'Farming', tier: '22', wave: String(i + 1), coins: '100', duration: '1h0m0s', runDate: '2026-10-13', runTime: '01:00', totalEnemies: '1000' }));
  local = cloud.map(row => ({ ...row, runId: row.$id, localId: row.$id })); drafts = new Map();
  io.settings.mockResolvedValue({ cloudSyncEnabled: true, autoDetectDuplicates: true, confirmBeforeSubmit: true, shareChart: false });
  io.local.mockImplementation(async () => local);
  io.upsert.mockImplementation(async (_user: string, rows: Row[]) => { for (const row of rows) { const found = local.findIndex(r => r.runId === row.runId); const next = { ...row, localId: row.runId }; if (found < 0) local.push(next); else local[found] = next; } });
  io.list.mockImplementation(async (_db: string, collection: string, queries: string[]) => {
    await delay(15);
    const parsed = queries.map(q => JSON.parse(q));
    const equal = parsed.find(q => q.method === 'equal');
    const rows = collection === 'runs_extended_data' ? cloud.filter(r => equal.values.includes(r.$id)).map(r => ({ $id: r.$id, userId: 'fixture-owner', killsWithBlackHole: '800', killsWithOrbs: '600' })) : cloud.filter(r => r.userId === equal.values[0]);
    const cursor = parsed.find(q => q.method === 'cursorAfter')?.values[0];
    const offset = cursor ? rows.findIndex(r => r.$id === cursor) + 1 : 0;
    const limit = parsed.find(q => q.method === 'limit')?.values[0] ?? 100;
    return { total: rows.length, documents: rows.slice(offset, offset + limit) };
  });
  io.create.mockImplementation(async (value: Row) => { const record = { ...value, token: 'flow-fixture', createdAt: Date.now(), lastActivity: Date.now() }; drafts.set('flow-fixture', record); return record; });
  io.pending.mockImplementation(async (token: string) => drafts.get(token) ?? null);
  io.intent.mockImplementation(async (token: string) => { const record = drafts.get(token); if (!record || record.submissionWriteIntent) return null; const next = { ...record, submissionWriteIntent: true }; drafts.set(token, next); return next; });
  io.remove.mockImplementation(async (token: string) => { drafts.delete(token); });
  io.save.mockImplementation(async (input: { runData: Row }) => { await delay(3); const row = { ...input.runData, userId: 'fixture-owner', $id: 'run-new', runId: 'run-new', localId: 'local-new' }; local.push(row); cloud.push({ ...row }); return { runId: 'run-new', localId: 'local-new' }; });
  io.snapshot.mockResolvedValue(true);
});

it.each(['previous-full-review', 'main-only-review', 'duplicate-check-disabled'])('stubbed parse-review-submit-share flow: %s', async mode => {
  io.forceFullReview = mode === 'previous-full-review';
  if (mode === 'duplicate-check-disabled') io.settings.mockResolvedValue({ cloudSyncEnabled: true, autoDetectDuplicates: false, confirmBeforeSubmit: true, shareChart: false });
  const owner = interaction();
  const phases: { phase: string; ms: number; mainRequests: number; extendedRequests: number }[] = [];
  async function measure(phase: string, action: () => Promise<unknown>) {
    const before = io.list.mock.calls.length, start = performance.now(); await action();
    const calls = io.list.mock.calls.slice(before);
    phases.push({ phase, ms: Math.round(performance.now() - start), mainRequests: calls.filter(c => c[1] !== 'runs_extended_data').length, extendedRequests: calls.filter(c => c[1] === 'runs_extended_data').length });
  }
  await measure('review', () => handleDirectTextPaste(owner as never, 'Battle Report\nBattle Date\tOct 14, 2026 01:00\nTier\t22\nWave\t2000\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1\nTotal Enemies\t1000', null, null, 'Farming', 'track'));
  expect(drafts.size).toBe(1); expect(io.upsert).not.toHaveBeenCalled();
  expect(phases[0].extendedRequests).toBe(mode === 'previous-full-review' ? 14 : 0);
  expect(phases[0].mainRequests).toBe(mode === 'previous-full-review' ? 6 : 0);
  await measure('submit', () => handleDataSubmission(owner as never));
  expect(io.errors).not.toHaveBeenCalled(); expect(io.save).toHaveBeenCalledOnce(); expect(drafts.size).toBe(0);
  expect(local).toHaveLength(1361); expect(phases[1].extendedRequests).toBe(mode === 'previous-full-review' ? 14 : 0);
  await handleDataSubmission(owner as never); expect(io.save).toHaveBeenCalledOnce();
  // A website/other instance edits the selected run after the submission snapshot.
  cloud.find(row => row.$id === 'run-new')!.tier = '23';
  await measure('share', () => handleTrackMenuShareLast(owner as never));
  expect(io.errors).not.toHaveBeenCalled(); expect(owner.channel.send).toHaveBeenCalledOnce(); expect(phases[2].extendedRequests).toBe(mode === 'previous-full-review' ? 14 : 0);
  expect(io.snapshot.mock.calls[0][0].runTypeCounts).toEqual(mode === 'previous-full-review' ? { Farming: 1361 } : {});
  expect(io.snapshot.mock.calls[0][0].run.tier).toBe(mode === 'previous-full-review' ? '23' : '22');
  // A later deletion must invalidate the cached selection instead of posting it again.
  cloud = cloud.filter(row => row.$id !== 'run-new');
  await handleTrackMenuShareLast(owner as never);
  if (mode === 'previous-full-review') {
    expect(owner.channel.send).toHaveBeenCalledOnce();
    expect(owner.followUp.mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining('no longer in your current history') });
  } else {
    expect(owner.channel.send).toHaveBeenCalledTimes(2);
    expect((owner.channel.send.mock.calls.at(-1)?.[0] as { embed: { data: { footer: { text: string } } } }).embed.data.footer.text).toContain('cloud changes have not been verified');
  }
  console.log(JSON.stringify({ fixture: mode, simulatedAppwriteRequestMs: 15, simulatedDiscordCallMs: 2, realCloudWrites: 0, publicMessages: 0, phases }));
});
