import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), pending: vi.fn(), remove: vi.fn(), log: vi.fn(), edit: vi.fn(), render: vi.fn(), diagnostic: vi.fn(), retain: vi.fn(), intent: vi.fn(), autoShare: vi.fn(), lifetime: vi.fn() }));
const logMocks = vi.hoisted(() => ({warn:vi.fn(),info:vi.fn(),error:vi.fn(),debug:vi.fn()}));
vi.mock('../../../core/logger',()=>({logger:logMocks}));
vi.mock('../paste-diagnostics', () => ({ updatePasteDiagnostic: mocks.diagnostic }));
vi.mock('../run-upload-history', async importOriginal => ({ ...await importOriginal<object>(), prepareBotRunUploadHistory: mocks.history }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(),
  getUserSettings: async () => ({ autoDetectDuplicates: true, shareChart: false }),
  getLastRun: async () => ({ allRuns: [], runTypeCounts: {} }), logRun: mocks.log, editRun: mocks.edit, saveLifetimeEntry: mocks.lifetime }));
vi.mock('../pending-run-store', async importOriginal => ({ ...await importOriginal<object>(), getPendingRun: mocks.pending, deletePendingRun: mocks.remove, retainPendingRunForHistoryRetry: mocks.retain, markPendingRunWriteIntent: mocks.intent }));
vi.mock('./review-interaction-helpers', async importOriginal => ({ ...await importOriginal<object>(), isTrackReviewFlowEnabled: () => true,
  resolveOwnedPendingInteraction: async (interaction: { customId: string }) => {
    const token = interaction.customId.startsWith('tracker_accept:') ? interaction.customId.split(':')[1] : interaction.customId; const pending = await mocks.pending(token); return pending ? { token, pending } : null;
  } }));
vi.mock('../ui/tracker-submission-embeds', async original => ({ ...await original<object>(), buildSubmissionResultEmbed: mocks.render }));
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
  pending = new Map(['a', 'b'].map(token => [token, { token, userId: 'submit-owner', username: 'fixture', createdAt: Date.now(), lastActivity: Date.now(), flowMode: 'track', runData: { type: 'Farming', tier: '22', wave: '900', totalCoins: '100', totalCells: '0', totalDice: '0', roundDuration: '1h0m0s' } }]));
  mocks.pending.mockImplementation(async token => pending.get(token) ?? null);
  mocks.remove.mockImplementation(async token => { pending.delete(token); });
  mocks.retain.mockImplementation(async token => { const current = pending.get(token); if (!current) return null; const next = { ...current, historyRetryRequired: true }; pending.set(token, next); return next; });
  mocks.intent.mockImplementation(async token => { const current = pending.get(token); if (!current || current.submissionWriteIntent) return null; const next = { ...current, submissionWriteIntent: true }; pending.set(token, next); return next; });
  mocks.runs.mockImplementation(async () => [...runs]); mocks.history.mockResolvedValue({ getRuns: mocks.runs });
  mocks.diagnostic.mockResolvedValue(true);
  mocks.autoShare.mockResolvedValue(undefined);
  mocks.lifetime.mockResolvedValue({ allEntries: [{ wave: '900' }] });
  mocks.render.mockReturnValue({ setImage: vi.fn() });
  mocks.log.mockImplementation(async input => { const index = runs.findIndex(row => row.localId === input.runData.localId); const record = { ...input.runData, localId: 'new-local' }; if (index < 0) runs.push(record); else runs[index] = record; return { localId: 'new-local', backgroundSync: Promise.resolve({}) }; });
  mocks.edit.mockResolvedValue({ localId: 'new-local' });
});
describe('actual submission history integration', () => {
  it('routes real lifetime statistics to lifetime persistence without requiring battle-report fields', async () => {
    setTrackerFlowMode('submit-owner', 'lifetime');
    const record = pending.get('a')!;
    record.flowMode = 'lifetime';
    record.runData = { gameStarted: '2023-08-30', coinsEarned: '5.67s', cashEarned: '26.14q', stonesEarned: '165493', date: '2026-10-27' };
    mocks.lifetime.mockResolvedValue({ allEntries: [record.runData] });
    const owner = interaction('a');
    await handleDataSubmission(owner as never);
    expect(mocks.lifetime).toHaveBeenCalledOnce();
    expect(mocks.lifetime.mock.calls[0][0].entryData).toMatchObject(record.runData as Record<string, unknown>);
    expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled(); expect(pending.has('a')).toBe(false);
    const { handleError } = await import('./error-handlers.js');
    expect(handleError).not.toHaveBeenCalled();
    expect(owner.editReply.mock.calls.at(-1)?.[0].components.length).toBeGreaterThan(0);
  });
  it('still rejects a battle submission without its required battle fields before any write', async () => {
    pending.get('a')!.runData = { coinsEarned: '5.67s', gameStarted: '2023-08-30' };
    await handleDataSubmission(interaction('a') as never);
    expect(mocks.lifetime).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('retains already-saved lifetime classification if result rendering fails after persistence', async () => {
    setTrackerFlowMode('submit-owner', 'lifetime');
    pending.get('a')!.flowMode = 'lifetime';
    pending.get('a')!.runData = { coinsEarned: '5.67s', date: '2026-10-27' };
    const ui = await import('../ui/tracker-submission-embeds.js');
    const render = vi.spyOn(ui, 'buildLifetimeSubmissionResultEmbed').mockImplementationOnce(() => { throw new Error('PRIVATE_LIFETIME_RENDER'); });
    const { handleError } = await import('./error-handlers.js');
    const owner = interaction('a');
    try { await handleDataSubmission(owner as never); }
    finally { render.mockRestore(); }
    expect(mocks.lifetime).toHaveBeenCalledOnce();
    expect(vi.mocked(handleError).mock.calls.at(-1)?.[0].lifecycle).toMatchObject({ runSaved: true, dispatchStarted: true, dispatchAdmitted: true });
    expect(owner.editReply.mock.calls.at(-1)?.[0].content).toContain('was saved');
    expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain('PRIVATE_');
  });
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
    setTrackerFlowMode('submit-owner', 'lifetime'); for (const record of pending.values()) record.flowMode = 'lifetime';
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
  // The failing call site is known to be history preparation; its unregistered cause is still not trusted.
  expect(safeErrorDiagnostic(diagnostic.error, diagnostic.context, diagnostic.stage)).toMatchObject({ operation: 'dataSubmission', stage: 'history' });
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




it('retains unchanged reviewed input after transient history failure and submits only after explicit versioned owner retry', async () => {
  const { historyFailureError } = await import('../history-failure-diagnostic.js');
  const { submissionDraftVersion } = await import('../submission-draft.js');
  pending.get('a')!.uploadProfileId = 'chosen-profile';
  const original = structuredClone(pending.get('a'));
  mocks.history.mockRejectedValueOnce(historyFailureError('safe', 'count_consistency', 'main_page'));
  const owner = interaction('a'); await handleDataSubmission(owner as never);
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.retain).toHaveBeenCalledOnce();
  expect(pending.get('a')).toEqual({ ...original, historyRetryRequired: true });
  expect(JSON.stringify(owner.editReply.mock.calls.at(-1))).toContain('Retry');
  // Old/unversioned Submit is not authorization to retry the retained session.
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).not.toHaveBeenCalled();
  const retry = interaction(`tracker_accept:a:${submissionDraftVersion(pending.get('a'))}`);
  await Promise.all([handleDataSubmission(retry as never), handleDataSubmission(interaction(retry.customId) as never)]);
  expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.log.mock.calls[0][0].uploadProfileId).toBe('chosen-profile');
  expect(pending.has('a')).toBe(false);
});
it.each(['cancel', 'expire', 'edit', 'profile', 'replace-session', 'replace-owner', 'mode'])('stops dispatch when the draft changes during history: %s', async change => {
  let finish!: (history: { getRuns: typeof mocks.runs }) => void;
  mocks.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const work = handleDataSubmission(interaction('a') as never);
  await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
  if (change === 'cancel') pending.delete('a');
  if (change === 'expire') pending.get('a')!.lastActivity = Date.now() - 300001;
  if (change === 'edit') pending.get('a')!.runData = { ...(pending.get('a')!.runData as object), wave: '999' };
  if (change === 'profile') pending.get('a')!.uploadProfileId = 'other-profile';
  if (change === 'replace-session') pending.get('a')!.token = 'b';
  if (change === 'replace-owner') pending.get('a')!.userId = 'other-owner';
  if (change === 'mode') setTrackerFlowMode('submit-owner', 'lifetime');
  finish({ getRuns: mocks.runs }); await work;
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.lifetime).not.toHaveBeenCalled();
  expect(mocks.retain).not.toHaveBeenCalled();
});
it.each(['cross-owner', 'wrong-session', 'expired'])('rejects invalid draft before history: %s', async mismatch => {
  if (mismatch === 'cross-owner') pending.get('a')!.userId = 'other-owner';
  if (mismatch === 'wrong-session') pending.get('a')!.token = 'b';
  if (mismatch === 'expired') pending.get('a')!.lastActivity = Date.now() - 300001;
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('rejects stale retained versions and rerenders the current profile without saving', async () => {
  const { submissionDraftVersion } = await import('../submission-draft.js');
  pending.get('a')!.historyRetryRequired = true;
  const previousVersion = submissionDraftVersion(pending.get('a'));
  pending.get('a')!.uploadProfileId = 'changed-profile';
  const owner = interaction(`tracker_accept:a:${previousVersion}`);
  await handleDataSubmission(owner as never);
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
  expect(pending.get('a')!.uploadProfileId).toBe('changed-profile');
});
it('rechecks duplicates on retained retry after another reviewed submission saved', async () => {
  const { historyFailureError } = await import('../history-failure-diagnostic.js');
  const { submissionDraftVersion } = await import('../submission-draft.js');
  mocks.history.mockRejectedValueOnce(historyFailureError('safe', 'count_consistency', 'main_count'));
  await handleDataSubmission(interaction('a') as never);
  await handleDataSubmission(interaction('b') as never);
  await handleDataSubmission(interaction(`tracker_accept:a:${submissionDraftVersion(pending.get('a'))}`) as never);
  expect(mocks.log).toHaveBeenCalledTimes(2); expect(mocks.edit).not.toHaveBeenCalled();
  expect(mocks.log.mock.calls[1][0].runData.localId).toBe('new-local');
  expect(runs).toHaveLength(133);
});
it('does not retain or offer retry after write dispatch failed, even for a tagged history exception', async () => {
  const { historyFailureError } = await import('../history-failure-diagnostic.js');
  mocks.log.mockRejectedValueOnce(historyFailureError('safe', 'timeout', 'cloud_history'));
  const owner = interaction('a'); await handleDataSubmission(owner as never);
  expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.retain).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(false);
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).toHaveBeenCalledOnce();
  expect(owner.editReply.mock.calls.at(-1)?.[0].components).toEqual([]);
});
it('acknowledgement failure leaves the draft intact and starts no history or write', async () => {
  const owner = interaction('a'); owner.deferUpdate.mockRejectedValueOnce(Error('safe ack failure'));
  await handleDataSubmission(owner as never);
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(true);
});

it('another owner cannot cancel a retained review by presenting its token', async () => {
  const { handleCancel } = await import('./data-review-handlers.js');
  pending.get('a')!.historyRetryRequired = true;
  const owner = interaction('tracker_cancel:a'); owner.user.id = 'other-owner';
  await handleCancel(owner as never);
  expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.diagnostic).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(true);
});
it('a retained run cannot be retried as lifetime input after changing flow', async () => {
  const { submissionDraftVersion } = await import('../submission-draft.js');
  pending.get('a')!.historyRetryRequired = true;
  const version = submissionDraftVersion(pending.get('a'));
  setTrackerFlowMode('submit-owner', 'lifetime');
  await handleDataSubmission(interaction(`tracker_accept:a:${version}`) as never);
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.lifetime).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(true);
});
it('legacy pending input with unknown original flow is preserved and cannot be guessed into a submission', async () => {
  delete pending.get('a')!.flowMode;
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(true);
});
it('a retry version from a different same-owner session cannot authorize this draft', async () => {
  const { submissionDraftVersion } = await import('../submission-draft.js');
  pending.get('a')!.historyRetryRequired = true; pending.get('b')!.historyRetryRequired = true;
  const versionA = submissionDraftVersion(pending.get('a'));
  await handleDataSubmission(interaction(`tracker_accept:b:${versionA}`) as never);
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
  expect(pending.has('a')).toBe(true); expect(pending.has('b')).toBe(true);
});
it('restoring a retained draft never invokes automatic confirmation or extends its activity clock', async () => {
  const { historyFailureError } = await import('../history-failure-diagnostic.js');
  const originalActivity = pending.get('a')!.lastActivity;
  mocks.history.mockRejectedValueOnce(historyFailureError('safe', 'timeout', 'cloud_history'));
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).not.toHaveBeenCalled();
  expect(pending.get('a')!.lastActivity).toBe(originalActivity);
  expect(pending.get('a')!.historyRetryRequired).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mocks.history).toHaveBeenCalledOnce();
});

it('failed write-intent persistence leaves input intact and calls no write', async () => {
  const original = structuredClone(pending.get('a'));
  mocks.intent.mockRejectedValueOnce(Error('safe storage failure'));
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  expect(pending.get('a')).toEqual(original);
});
it('cancellation during write-intent persistence still prevents the run write', async () => {
  let finish!: () => void;
  mocks.intent.mockImplementationOnce(async token => { const admitted = { ...pending.get(token), submissionWriteIntent: true }; pending.set(token, admitted); await new Promise<void>(resolve => { finish = resolve; }); return admitted; });
  const work = handleDataSubmission(interaction('a') as never);
  await vi.waitFor(() => expect(mocks.intent).toHaveBeenCalledOnce());
  pending.delete('a'); finish(); await work;
  expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
});
it('an uncertain admitted write cannot retry even when token consumption fails', async () => {
  mocks.log.mockRejectedValueOnce(Error('safe uncertain write'));
  mocks.remove.mockRejectedValueOnce(Error('safe consumption failure'));
  await handleDataSubmission(interaction('a') as never);
  expect(pending.get('a')!.submissionWriteIntent).toBe(true);
  await handleDataSubmission(interaction('a') as never);
  expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.history).toHaveBeenCalledOnce();
});
