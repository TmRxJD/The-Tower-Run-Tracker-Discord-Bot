import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), pending: vi.fn(), remove: vi.fn(), log: vi.fn(), edit: vi.fn(), render: vi.fn(), diagnostic: vi.fn(), autoShare: vi.fn(), lifetime: vi.fn() }));
const logMocks = vi.hoisted(() => ({warn:vi.fn(),info:vi.fn(),error:vi.fn(),debug:vi.fn()}));
vi.mock('../../../core/logger',()=>({logger:logMocks}));
vi.mock('../paste-diagnostics', () => ({ updatePasteDiagnostic: mocks.diagnostic }));
vi.mock('../run-upload-history', async importOriginal => ({ ...await importOriginal<object>(), prepareBotRunUploadHistory: mocks.history }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(),
  getUserSettings: async () => ({ autoDetectDuplicates: true, shareChart: false }),
  getLastRun: async () => ({ allRuns: [], runTypeCounts: {} }), logRun: mocks.log, editRun: mocks.edit, saveLifetimeEntry: mocks.lifetime }));
vi.mock('../pending-run-store', async importOriginal => ({ ...await importOriginal<object>(), getPendingRun: mocks.pending, deletePendingRun: mocks.remove }));
vi.mock('./review-interaction-helpers', async importOriginal => ({ ...await importOriginal<object>(), isTrackReviewFlowEnabled: () => true,
  resolveOwnedPendingInteraction: async (interaction: { customId: string }) => {
    const pending = await mocks.pending(interaction.customId); return pending ? { token: interaction.customId, pending } : null;
  } }));
vi.mock('../ui/tracker-submission-embeds', () => ({ buildSubmissionResultEmbed: mocks.render }));
vi.mock('../share/auto-log-channel-share', () => ({ autoShareToConfiguredLogChannel: mocks.autoShare }));
vi.mock('./error-handlers', () => ({ handleError: vi.fn() }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'disabled' }) }));
vi.mock('../upload-target-profile', () => ({ setPendingUploadProfile: vi.fn() }));
import { handleDataSubmission } from './data-review-handlers';
import { setTrackerFlowMode } from '../flow-mode-store';
import { withBotRunSubmissionLock } from '../run-upload-history';

type Row = Record<string, unknown>;
let runs: Row[];
let pending: Map<string, Row>;
function interaction(token: string) {
  const owner = { customId: token, user: { id: 'submit-owner', username: 'fixture' }, client: {}, guildId: null,
    deferred: false, replied: false, deferUpdate: vi.fn(), editReply: vi.fn().mockResolvedValue({}) };
  owner.deferUpdate.mockImplementation(async () => { owner.deferred = true; }); return owner;
}
beforeEach(() => {
  vi.clearAllMocks(); setTrackerFlowMode('submit-owner', 'track');
  runs = Array.from({ length: 132 }, (_, i) => ({ runId: `run-${i}`, localId: `local-${i}`, type: 'Farming', tier: '22', wave: String(i + 1), totalCoins: '100', roundDuration: '1h0m0s' }));
  pending = new Map(['a', 'b'].map(token => [token, { token, userId: 'submit-owner', username: 'fixture', runData: { type: 'Farming', tier: '22', wave: '900', totalCoins: '100', totalCells: '0', totalDice: '0', roundDuration: '1h0m0s' } }]));
  mocks.pending.mockImplementation(async token => pending.get(token) ?? null);
  mocks.remove.mockImplementation(async token => { pending.delete(token); });
  mocks.runs.mockImplementation(async () => [...runs]); mocks.history.mockResolvedValue({ getRuns: mocks.runs });
  mocks.diagnostic.mockResolvedValue(true);
  mocks.autoShare.mockResolvedValue(undefined);
  mocks.lifetime.mockResolvedValue({ allEntries: [{ wave: '900' }] });
  mocks.render.mockReturnValue({ setImage: vi.fn() });
  mocks.log.mockImplementation(async input => { const index = runs.findIndex(row => row.localId === input.runData.localId); const record = { ...input.runData, localId: 'new-local' }; if (index < 0) runs.push(record); else runs[index] = record; return { localId: 'new-local', backgroundSync: Promise.resolve({}) }; });
  mocks.edit.mockResolvedValue({ localId: 'new-local' });
});
describe('actual submission history integration', () => {
  it('does not replace a saved response with loading when a repeated Submit acknowledgement arrives late', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const late = interaction('a');
    late.deferUpdate.mockImplementation(async () => { await blocked; late.deferred = true; });
    const repeated = handleDataSubmission(late as never);
    await vi.waitFor(() => expect(late.deferUpdate).toHaveBeenCalledOnce());
    await handleDataSubmission(interaction('a') as never);
    finish(); await repeated;
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(late.editReply).not.toHaveBeenCalled();
  });
  it('a failed write consumes its session and releases the save lock while its error reply stalls', async () => {
    pending.get('a')!.pasteDiagnosticId = 'fixture-reference';
    mocks.log.mockRejectedValueOnce(new Error('PRIVATE_WRITE_FAILURE'));
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const owner = interaction('a');
    owner.editReply.mockImplementation(async payload => {
      if (payload.content?.includes('could not be completed')) await blocked;
      return {};
    });
    const first = handleDataSubmission(owner as never);
    await vi.waitFor(() => expect(pending.has('a')).toBe(false));
    const second = handleDataSubmission(interaction('b') as never);
    try {
      await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledTimes(2));
      expect(runs).toHaveLength(133);
      expect(mocks.render).not.toHaveBeenCalled();
      await handleDataSubmission(interaction('a') as never);
      expect(mocks.log).toHaveBeenCalledTimes(2);
    } finally { finish(); await Promise.all([first, second]); }
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('PRIVATE_WRITE_FAILURE');
  });
  it('a failed success reply reports an already saved run and never reuses its consumed token', async () => {
    const owner = interaction('a');
    owner.editReply.mockImplementation(async payload => {
      if (payload.components?.length) throw new Error('PRIVATE_DELIVERY_FAILURE');
      return {};
    });
    await handleDataSubmission(owner as never);
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(pending.has('a')).toBe(false);
    expect(owner.editReply.mock.calls.at(-1)?.[0].content).toContain('Your run was saved');
    expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('PRIVATE_DELIVERY_FAILURE');
    await handleDataSubmission(interaction('a') as never);
    expect(mocks.log).toHaveBeenCalledOnce();
  });
  it('a stalled auto-share cannot block another save, and delivery remains ordered', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    mocks.autoShare.mockImplementationOnce(() => blocked);
    const first = handleDataSubmission(interaction('a') as never);
    await vi.waitFor(() => expect(mocks.autoShare).toHaveBeenCalledOnce());
    const second = handleDataSubmission(interaction('b') as never);
    try {
      await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledTimes(2));
      expect(pending.size).toBe(0);
      expect(mocks.autoShare).toHaveBeenCalledOnce();
    } finally { finish(); await Promise.all([first, second]); }
    expect(mocks.autoShare).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(133);
  });
  it('lifetime delivery releases the mutation lock after saving and consuming its token', async () => {
    setTrackerFlowMode('submit-owner', 'lifetime');
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const owner = interaction('a');
    owner.editReply.mockImplementation(async payload => { if (payload.components?.length) await blocked; return {}; });
    const first = handleDataSubmission(owner as never);
    try {
      await vi.waitFor(() => expect(pending.has('a')).toBe(false));
      expect(await withBotRunSubmissionLock('submit-owner', async () => 'free')).toBe('free');
      expect(mocks.lifetime).toHaveBeenCalledOnce();
    } finally { finish(); await first; }
  });
  it('releases the save lock and consumes the token before a slow success reply', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const owner = interaction('a');
    owner.editReply.mockImplementation(async payload => {
      if (payload.components?.length) await blocked;
      return {};
    });
    const first = handleDataSubmission(owner as never);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    let entered = false;
    const second = withBotRunSubmissionLock('submit-owner', async () => { entered = true; });
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 200 });
      expect(pending.has('a')).toBe(false);
      await handleDataSubmission(interaction('a') as never);
      expect(mocks.log).toHaveBeenCalledOnce();
    } finally { finish(); await Promise.all([first, second]); }
  });
  it('a complete 132-run cold cache becomes 133, never #1, for a new save', async () => {
    await handleDataSubmission(interaction('a') as never);
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.render.mock.calls[0][0].runTypeCounts).toEqual({ Farming: 133 });
    expect(mocks.runs).toHaveBeenLastCalledWith({ runId: undefined, localId: 'new-local' });
  });
  it('two concurrent reviews for the same report save one new run then update it', async () => {
    await Promise.all([handleDataSubmission(interaction('a') as never), handleDataSubmission(interaction('b') as never)]);
    expect(mocks.log).toHaveBeenCalledTimes(2); expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.log.mock.calls[1][0].runData.localId).toBe('new-local');
    expect(runs).toHaveLength(133);
    expect(mocks.render.mock.calls.map(call => call[0].runTypeCounts.Farming)).toEqual([133, 133]);
  });
  it('a repeated Submit for the same pending token writes only once', async () => {
    await Promise.all([handleDataSubmission(interaction('a') as never), handleDataSubmission(interaction('a') as never)]);
    expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('failed history saves nothing and releases the lock for the next successful request', async () => {
    mocks.history.mockRejectedValueOnce(new Error('fixture cloud unavailable'));
    await handleDataSubmission(interaction('a') as never);
    expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
    await handleDataSubmission(interaction('b') as never);
    expect(mocks.log).toHaveBeenCalledOnce();
  });
});

it('paste diagnostic storage failure does not prevent a real save or invent success before the save', async () => {
  pending.get('a')!.pasteDiagnosticId = 'fixture-reference'; mocks.diagnostic.mockResolvedValue(false);
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.render).toHaveBeenCalledOnce();
  expect(mocks.diagnostic).toHaveBeenCalledWith('fixture-reference', expect.objectContaining({ result: 'saved', stage: 'submit', localId: 'new-local' }));
});
it('a failed save remains failure-visible without forwarding paste text', async () => {
  pending.get('a')!.pasteDiagnosticId = 'fixture-reference'; mocks.log.mockRejectedValue(new Error('synthetic-private-paste'));
  const owner = interaction('a'); await handleDataSubmission(owner as never);
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.diagnostic).toHaveBeenCalledWith('fixture-reference', expect.objectContaining({ result: 'failed', stage: 'submit' }));
  expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('synthetic-private-paste');
});
it('does not forward private errors from a deferred submission follow-up to diagnostics', async () => {
  let fail: ((error: Error) => void) | undefined;
  const backgroundSync = new Promise<never>((_resolve,reject)=>{fail=reject;});
  mocks.log.mockResolvedValue({localId:'new-local',backgroundSync});
  await handleDataSubmission(interaction('a') as never);
  fail!(Error('PRIVATE_DEFERRED_REPORT_SECRET'));
  await vi.waitFor(()=>expect(logMocks.warn).toHaveBeenCalledWith('deferred tracker submission follow-up failed'));
  expect(JSON.stringify(logMocks.warn.mock.calls)).not.toContain('PRIVATE_');
});

it('preserves pre-save history cause and correlation through the private submission wrapper', async () => {
  const { historyFailureError, readHistoryFailure } = await import('../history-failure-diagnostic.js');
  const { handleError } = await import('./error-handlers.js');
  const { safeErrorDiagnostic } = await import('./safe-error-diagnostic.js');
  pending.get('a')!.pasteDiagnosticId = 'fixture-reference';
  const error = historyFailureError('PRIVATE_HISTORY_CONTENT', 'count_consistency', 'main_page');
  const metadata = readHistoryFailure(error);
  mocks.history.mockRejectedValueOnce(error);
  const owner = interaction('a'); await handleDataSubmission(owner as never);
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
  expect(mocks.diagnostic).toHaveBeenCalledWith('fixture-reference', expect.objectContaining({ result: 'failed', stage: 'submit', errorCode: 'history_unavailable', historyFailure: metadata }));
  const diagnostic = vi.mocked(handleError).mock.calls.at(-1)![0];
  expect(safeErrorDiagnostic(diagnostic.error, diagnostic.context, diagnostic.stage)).toMatchObject({ operation: 'dataSubmission', stage: 'history', code: 'history_unavailable', historyFailure: metadata });
  expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('PRIVATE_HISTORY_CONTENT');
  expect(JSON.stringify(safeErrorDiagnostic(diagnostic.error, diagnostic.context, diagnostic.stage))).not.toContain('PRIVATE_HISTORY_CONTENT');
});

it('does not classify an unregistered submission exception as a history failure', async () => {
  const { handleError } = await import('./error-handlers.js');
  const { safeErrorDiagnostic } = await import('./safe-error-diagnostic.js');
  pending.get('a')!.pasteDiagnosticId = 'fixture-reference';
  mocks.history.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_GENERIC'), { historyFailure: { cause: 'count_consistency', stage: 'main_page', correlation: 'forged' } }));
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.diagnostic).toHaveBeenCalledWith('fixture-reference', { result: 'failed', stage: 'submit', errorCode: 'internal_error' });
  const diagnostic = vi.mocked(handleError).mock.calls.at(-1)![0];
  expect(safeErrorDiagnostic(diagnostic.error, diagnostic.context, diagnostic.stage)).toMatchObject({ operation: 'dataSubmission', stage: 'submit' });
  expect(safeErrorDiagnostic(diagnostic.error, diagnostic.context, diagnostic.stage)).not.toHaveProperty('historyFailure');
});
it('preserves already-saved classification when presentation throws a registered history error', async () => {
  const { historyFailureError } = await import('../history-failure-diagnostic.js');
  pending.get('a')!.pasteDiagnosticId = 'fixture-reference';
  mocks.render.mockImplementationOnce(() => { throw historyFailureError('PRIVATE_PRESENTATION', 'timeout', 'cloud_history'); });
  const owner = interaction('a'); await handleDataSubmission(owner as never);
  expect(mocks.log).toHaveBeenCalledOnce();
  expect(mocks.diagnostic).toHaveBeenLastCalledWith('fixture-reference', { result: 'saved', stage: 'submit', errorCode: 'presentation_error' });
  expect(JSON.stringify(owner.editReply.mock.calls)).toContain('run was saved');
  expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('PRIVATE_PRESENTATION');
});

