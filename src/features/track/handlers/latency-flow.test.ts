import { beforeEach, expect, it, vi } from 'vitest';
import type * as HistoryModule from '../run-upload-history';
const io = vi.hoisted(() => ({ list: vi.fn(), local: vi.fn(), upsert: vi.fn(), settings: vi.fn(), create: vi.fn(), pending: vi.fn(), intent: vi.fn(), remove: vi.fn(), save: vi.fn(), snapshot: vi.fn(), errors: vi.fn(), forceFullReview: false, outage: false, disabled: false, historyRead: vi.fn(), historyWrite: vi.fn(), queueRead: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: { listDocuments: io.list } }) }));
vi.mock('../run-cloud-identity', () => ({ resolveBotRunCloudIdentity: async () => ({ lookupUserIds: ['fixture-owner', 'legacy-owner'] }) }));
vi.mock('../../../rxdb/run-rxdb-store', async original => ({ ...await original<object>(), loadLocalRunsFromBotRxDB: io.local, upsertMergedRunsIntoBotRxDB: io.upsert }));
vi.mock('../local-run-store', async original => ({ ...await original<object>(), getLocalSettings: io.settings, getQueueItems: io.queueRead }));
vi.mock('../run-deletion-tombstones', () => ({ getPermanentlyDeletedRunIds: async () => new Set() }));
vi.mock('../run-upload-history', async original => {
  const actual = await original<typeof HistoryModule>();
  return { ...actual, prepareBotRunUploadHistory: (user: string, options: Parameters<typeof actual.prepareBotRunUploadHistory>[1]) => actual.prepareBotRunUploadHistory(user, io.forceFullReview ? { ...options, localFirst: false, mainOnly: false } : options) };
});
vi.mock('../run-history-snapshot', () => ({ readVerifiedHistorySnapshot: io.historyRead, saveVerifiedHistorySnapshot: io.historyWrite }));
vi.mock('../paste-diagnostics', () => ({ beginPasteDiagnostic: async () => 'P-fixture', updatePasteDiagnostic: async () => true }));
vi.mock('../pending-run-store', async original => ({ ...await original<object>(), createPendingRun: io.create, getPendingRun: io.pending, markPendingRunWriteIntent: io.intent, deletePendingRun: io.remove }));
vi.mock('../tracker-api-client', async original => ({ ...await original<object>(), getUserSettings: io.settings, logRun: io.save, editRun: io.save }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'last' }) }));
vi.mock('../upload-target-profile', () => ({ listBotUserProfiles: async () => [], peekPendingUploadProfile: () => null, resolveDefaultUploadProfileId: async () => null, setPendingUploadProfile: vi.fn() }));
vi.mock('./review-interaction-helpers', async original => ({ ...await original<object>(), isTrackReviewFlowEnabled: () => true }));
vi.mock('../share/auto-log-channel-share', () => ({ autoShareToConfiguredLogChannel: async () => undefined }));
vi.mock('../run-menu-sync', () => ({ beginBackgroundAuthoritySync: vi.fn() }));
vi.mock('../share/share-snapshot-store', () => ({ saveShareSnapshot: io.snapshot }));
vi.mock('../share/share-embed-delivery', () => ({ resolveShareEmbedChannelPayload: async (input: object) => input }));
vi.mock('./error-handlers', () => ({ handleError: io.errors, logError: io.errors }));
import { handleDirectTextPaste, renderTrackMenu } from './upload-handlers';
import { handleDataSubmission } from './data-review-handlers';
import { handleTrackMenuShareLast } from './share-handlers';
import { setShareableRun } from '../share/share-state';
import { setTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS } from '../track-custom-ids';
import { clearPreparedShareHistory, resolvePreparedShareHistory } from '../share/prepared-share';
import { capturePreparedShareCheckpoint } from '../share/prepared-share-inputs';
import { mkdirSync, writeFileSync } from 'node:fs';

type Row = Record<string, unknown>;
let cloud: Row[], local: Row[], drafts: Map<string, Row>, queue: Row[];
let historyCache: { version: number; checkedAt: number; documents: Row[] } | null;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function interaction() {
  return { customId: 'tracker_accept:flow-fixture', user: { id: 'fixture-owner', username: 'fixture', displayAvatarURL: () => '' }, client: {}, guildId: null,
    deferred: true, replied: false, deferUpdate: vi.fn(async () => { await delay(2); }),
    editReply: vi.fn(async (payload: unknown) => { void payload; await delay(2); return {}; }), followUp: vi.fn(async (payload: unknown) => { void payload; }),
    channel: { send: vi.fn(async (payload: unknown) => { void payload; await delay(2); return {}; }) }, message: { components: [] } };
}
beforeEach(() => {
  vi.clearAllMocks(); io.forceFullReview = false; io.outage = false; io.disabled = false; setTrackerFlowMode('fixture-owner', 'track');
  cloud = Array.from({ length: 1360 }, (_, i) => ({ $id: `run-${String(i).padStart(4, '0')}`, userId: 'fixture-owner', type: 'Farming', tier: '22', wave: String(i + 1), coins: '100', duration: '1h0m0s', runDate: '2026-10-13', runTime: '01:00', totalEnemies: '1000' }));
  local = cloud.map(row => ({ ...row, runId: row.$id, localId: row.$id })); drafts = new Map(); queue = [];
  historyCache = { version: 1, checkedAt: Date.now(), documents: structuredClone(cloud) };
  io.historyRead.mockImplementation(async () => historyCache);
  io.historyWrite.mockImplementation(async (_user: string, documents: Row[]) => { historyCache = { version: 1, checkedAt: Date.now(), documents: structuredClone(documents) }; });
  io.queueRead.mockImplementation(async () => queue);
  io.settings.mockResolvedValue({ cloudSyncEnabled: true, autoDetectDuplicates: true, confirmBeforeSubmit: true, shareChart: false });
  io.local.mockImplementation(async () => local);
  io.upsert.mockImplementation(async (_user: string, rows: Row[]) => { for (const row of rows) { const found = local.findIndex(r => r.runId === row.runId); const next = { ...row, localId: row.runId }; if (found < 0) local.push(next); else local[found] = next; } });
  io.list.mockImplementation(async (_db: string, collection: string, queries: string[]) => {
    if (io.outage) throw Object.assign(new Error('fixture backend unavailable'), { code: 503 });
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
  io.save.mockImplementation(async (input: { runData: Row }) => {
    await delay(3);
    const row = { ...input.runData, userId: 'fixture-owner', $id: 'run-new', runId: io.disabled ? undefined : 'run-new', localId: 'local-new' };
    local.push(row);
    if (io.outage) queue.push({ id: 'future', op: 'upsert', automaticRecovery: true, uploadProfileId: null, runId: 'run-new', localId: 'local-new', runData: row });
    else if (!io.disabled) cloud.push({ ...row });
    return { runId: row.runId, localId: 'local-new', queuedForCloud: io.outage };
  });
  io.snapshot.mockResolvedValue(true);
});

it('reuses the actual submitted-result invocation through its generated Share button without another history read', async () => {
  const owner = { ...interaction(), message: { id: 'submitted-result-source', components: [] } };
  await handleDirectTextPaste(owner as never, 'Battle Report\nBattle Date\tOct 14, 2026 01:00\nTier\t22\nWave\t2000\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1\nTotal Enemies\t1000', null, null, 'Farming', 'track');
  await handleDataSubmission(owner as never);
  expect(io.errors).not.toHaveBeenCalled();
  const ids = owner.editReply.mock.calls.flatMap(([payload]) => {
    const data = payload as { components?: Array<{ components: Array<{ toJSON: () => { custom_id?: string } }> }> };
    return (data.components ?? []).flatMap(row => row.components.map(button => button.toJSON().custom_id ?? ''));
  });
  const preparedId = ids.find(id => id.startsWith(TRACKER_IDS.flow.preparedSharePrefix));
  expect(preparedId).toBeTruthy(); owner.customId = preparedId!;
  const callsBefore = io.list.mock.calls.length;
  const clickStarted = performance.now();
  await handleTrackMenuShareLast(owner as never);
  const preparedMs = performance.now() - clickStarted;
  expect(io.errors).not.toHaveBeenCalled(); expect(owner.channel.send).toHaveBeenCalledOnce();
  expect(io.list.mock.calls.length).toBe(callsBefore);
  expect(io.snapshot.mock.calls.at(-1)?.[0]).toMatchObject({ runTypeCounts: { Farming: 1361 }, historyCapturedAt: expect.any(Number) });
  const retained = await resolvePreparedShareHistory({ token: preparedId!.slice(TRACKER_IDS.flow.preparedSharePrefix.length), userId: owner.user.id,
    messageId: owner.message.id, profileId: null, mode: 'track', checkpoint: () => capturePreparedShareCheckpoint(owner.user.id) });
  expect(retained?.runs).toHaveLength(1361);
  expect(retained?.runs.find(run => run.runId === 'run-0000')?.killsWithBlackHole).toBe('800');
  // Same actual handler, isolated backend adapter with a realistic bounded network delay.
  const list = io.list.getMockImplementation()!;
  io.list.mockImplementation(async (...args) => { await delay(300); return list(...args); });
  const freshCallsBefore = io.list.mock.calls.length; owner.customId = TRACKER_IDS.flow.shareLast;
  const freshStarted = performance.now(); await handleTrackMenuShareLast(owner as never);
  const freshMs = performance.now() - freshStarted;
  expect(io.list.mock.calls.length - freshCallsBefore).toBeGreaterThan(0);
  expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1361 });
  mkdirSync('temp', {recursive:true});
  writeFileSync('temp/prepared-flow-benchmark.json', JSON.stringify({ fixture:true, historyRows:1361, preparedMs, freshMs,
    preparedHistoryRequests:0, freshHistoryRequests:io.list.mock.calls.length-freshCallsBefore,
    method:'Actual parse/review/submit/generated-button and Share handler; isolated SDK adapter adds 300 ms per fresh request, Discord and settings mocked.' },null,2));
});

it('prepares a menu invocation once and rejects its old token after a process-cache restart', async () => {
  const owner = { ...interaction(), message: { id: 'menu-source', components: [] } };
  await renderTrackMenu(owner as never, 'track');
  const payload = owner.editReply.mock.calls.at(-1)?.[0] as { components: Array<{ components: Array<{ toJSON: () => { custom_id?: string } }> }> };
  const preparedId = payload.components.flatMap(row => row.components.map(button => button.toJSON().custom_id ?? '')).find(id => id.startsWith(TRACKER_IDS.flow.preparedSharePrefix));
  expect(preparedId).toBeTruthy(); owner.customId = preparedId!;
  const callsBefore = io.list.mock.calls.length;
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).toHaveBeenCalledOnce(); expect(io.list.mock.calls.length).toBe(callsBefore);
  expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1360 });
  clearPreparedShareHistory();
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).toHaveBeenCalledOnce(); expect(io.list.mock.calls.length).toBe(callsBefore);
  expect(owner.followUp.mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining('expired') });
});


it.each(['healthy-cloud', 'outage', 'cloud-disabled'])('automatic parse-review-submit-standard-share: %s', async mode => {
  io.outage = mode === 'outage'; io.disabled = mode === 'cloud-disabled';
  if (io.disabled) io.settings.mockResolvedValue({ cloudSyncEnabled: false, autoDetectDuplicates: true, confirmBeforeSubmit: true, shareChart: false });
  const owner = interaction();
  const phases: { phase: string; ms: number; requests: number }[] = [];
  async function measure(phase: string, action: () => Promise<unknown>) {
    const calls = io.list.mock.calls.length, start = performance.now(); await action();
    phases.push({ phase, ms: Math.round(performance.now() - start), requests: io.list.mock.calls.length - calls });
  }
  await measure('review', () => handleDirectTextPaste(owner as never, 'Battle Report\nBattle Date\tOct 14, 2026 01:00\nTier\t22\nWave\t2000\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1\nTotal Enemies\t1000', null, null, 'Farming', 'track'));
  expect(drafts.size).toBe(1);
  await measure('submit', () => handleDataSubmission(owner as never));
  expect(io.errors).not.toHaveBeenCalled(); expect(io.save).toHaveBeenCalledOnce(); expect(drafts.size).toBe(0);
  await handleDataSubmission(owner as never); expect(io.save).toHaveBeenCalledOnce();
  if (!io.outage && !io.disabled) cloud.find(row => row.$id === 'run-new')!.tier = '23';
  await measure('share', () => handleTrackMenuShareLast(owner as never));
  expect(io.errors).not.toHaveBeenCalled(); expect(owner.channel.send).toHaveBeenCalledOnce();
  const payload = owner.channel.send.mock.calls[0][0] as { embed: { data: { title: string; description: string; footer?: { text: string } } } };
  expect(payload.embed.data.title).toContain('Farming Run #1361');
  expect(payload.embed.data.title).not.toContain('unavailable');
  expect(payload.embed.data.description).toContain('(+0.00%)');
  expect(io.snapshot.mock.calls[0][0].runTypeCounts).toEqual({ Farming: 1361 });
  expect(io.snapshot.mock.calls[0][0].run.tier).toBe(!io.outage && !io.disabled ? '23' : '22');
  if (io.outage) expect(payload.embed.data.footer?.text).toContain('Offline fallback');
  else expect(payload.embed.data.footer?.text ?? '').not.toContain('Offline fallback');
  if (io.disabled) expect(io.list).not.toHaveBeenCalled();
  if (mode === 'healthy-cloud') {
    cloud = cloud.filter(row => row.$id !== 'run-new');
    await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).toHaveBeenCalledOnce();
    expect(owner.followUp.mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining('no longer in your current history') });
  }
  if (io.outage) {
    io.outage = false;
    cloud.push({ ...local.find(row => row.localId === 'local-new')!, tier: '24' }); queue = [];
    await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).toHaveBeenCalledTimes(2);
    expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1361 });
    expect(io.snapshot.mock.calls.at(-1)?.[0].run.tier).toBe('24');
    expect(io.snapshot.mock.calls.at(-1)?.[0].historyVerified).toBe(true);
  }
  console.log(JSON.stringify({ fixture: mode, phases, realCloudWrites: 0, publicMessages: 0 }));
});
it('standard Share refreshes a website type edit instead of using an old cached quantity', async () => {
  setShareableRun('fixture-owner', { run: local[0], runTypeCounts: { Farming: 1360 } });
  cloud[0].type = 'Tournament';
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1359, Tournament: 1 });
  expect(io.snapshot.mock.calls.at(-1)?.[0].run.type).toBe('Tournament');
  expect(io.errors).not.toHaveBeenCalled();
});
it('counts a website duplicate and a durable pending report once, including after a cache-cold restart', async () => {
  cloud[0].profileId = ''; // Legacy Main and null Main share the same profile identity.
  const pending = { ...local[0], localId: 'pending-duplicate', runId: 'reserved-new' };
  local = [];
  queue = [{ id: 'future', op: 'upsert', automaticRecovery: true, duplicateCheckPending: true, uploadProfileId: null, localId: 'pending-duplicate', runId: 'reserved-new', runData: pending }];
  setShareableRun('fixture-owner', { run: pending, runTypeCounts: { Farming: 1 } });
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1360 });
  expect(io.errors).not.toHaveBeenCalled(); expect(owner.channel.send).toHaveBeenCalledOnce();
});

it('never labels an incomplete cold-cache fallback as an authoritative cloud quantity', async () => {
  io.outage = true; historyCache = null; local = local.slice(0, 20);
  setShareableRun('fixture-owner', { run: local[0], runTypeCounts: { Farming: 1 } });
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  const payload = owner.channel.send.mock.calls[0][0] as { embed: { data: { title: string; description: string; footer: { text: string } } } };
  expect(payload.embed.data.title).toContain('Farming Run #20 (locally saved)');
  expect(payload.embed.data.footer.text).toContain('Offline fallback');
  expect(payload.embed.data.description).not.toContain('(+0.00%)');
  expect(io.snapshot.mock.calls[0][0].historyVerified).toBe(false);
});
it('subtracts a durable pending deletion once without changing its queue entry', async () => {
  queue = [{ id: 'delete-intent', op: 'delete', runId: 'run-0000' }];
  const before = structuredClone(queue);
  setShareableRun('fixture-owner', { run: local[1], runTypeCounts: { Farming: 1360 } });
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  expect(io.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 1359 });
  expect(queue).toEqual(before); expect(io.errors).not.toHaveBeenCalled();
});
