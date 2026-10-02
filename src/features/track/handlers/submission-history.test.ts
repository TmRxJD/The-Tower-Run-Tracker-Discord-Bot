import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), pending: vi.fn(), remove: vi.fn(), log: vi.fn(), edit: vi.fn(), render: vi.fn() }));
vi.mock('../run-upload-history', async importOriginal => ({ ...await importOriginal<object>(), prepareBotRunUploadHistory: mocks.history }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(),
  getUserSettings: async () => ({ autoDetectDuplicates: true, shareChart: false }),
  getLastRun: async () => ({ allRuns: [], runTypeCounts: {} }), logRun: mocks.log, editRun: mocks.edit }));
vi.mock('../pending-run-store', async importOriginal => ({ ...await importOriginal<object>(), getPendingRun: mocks.pending, deletePendingRun: mocks.remove }));
vi.mock('./review-interaction-helpers', async importOriginal => ({ ...await importOriginal<object>(), isTrackReviewFlowEnabled: () => true,
  resolveOwnedPendingInteraction: async (interaction: { customId: string }) => {
    const pending = await mocks.pending(interaction.customId); return pending ? { token: interaction.customId, pending } : null;
  } }));
vi.mock('../ui/tracker-submission-embeds', () => ({ buildSubmissionResultEmbed: mocks.render }));
vi.mock('../share/auto-log-channel-share', () => ({ autoShareToConfiguredLogChannel: vi.fn() }));
vi.mock('./error-handlers', () => ({ handleError: vi.fn() }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'disabled' }) }));
vi.mock('../upload-target-profile', () => ({ setPendingUploadProfile: vi.fn() }));
import { handleDataSubmission } from './data-review-handlers';
import { setTrackerFlowMode } from '../flow-mode-store';

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
  pending = new Map(['a', 'b'].map(token => [token, { token, userId: 'submit-owner', username: 'fixture', runData: { type: 'Farming', tier: '22', wave: '900', totalCoins: '100', roundDuration: '1h0m0s' } }]));
  mocks.pending.mockImplementation(async token => pending.get(token) ?? null);
  mocks.remove.mockImplementation(async token => { pending.delete(token); });
  mocks.runs.mockImplementation(async () => [...runs]); mocks.history.mockResolvedValue({ getRuns: mocks.runs });
  mocks.render.mockReturnValue({ setImage: vi.fn() });
  mocks.log.mockImplementation(async input => { const index = runs.findIndex(row => row.localId === input.runData.localId); const record = { ...input.runData, localId: 'new-local' }; if (index < 0) runs.push(record); else runs[index] = record; return { localId: 'new-local', backgroundSync: Promise.resolve({}) }; });
  mocks.edit.mockResolvedValue({ localId: 'new-local' });
});
describe('actual submission history integration', () => {
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
