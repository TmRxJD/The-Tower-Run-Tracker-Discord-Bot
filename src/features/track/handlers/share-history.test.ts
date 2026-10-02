import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), snapshot: vi.fn(), settings: vi.fn() }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.history, withBotRunSubmissionLock: async (_user: string, action: () => Promise<unknown>) => action() }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(), getUserSettings: mocks.settings }));
vi.mock('../share/share-snapshot-store', () => ({ saveShareSnapshot: mocks.snapshot }));
vi.mock('../share/share-embed-delivery', () => ({ resolveShareEmbedChannelPayload: async (input: object) => input }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'disabled' }) }));
vi.mock('./error-handlers', () => ({ logError: vi.fn() }));
import { handleTrackMenuShareLast } from './share-handlers';
import { setShareableRun } from '../share/share-state';
import { setTrackerFlowMode } from '../flow-mode-store';

const rows = Array.from({ length: 132 }, (_, i) => ({ runId: `run-${i}`, localId: `local-${i}`, type: 'Farming', tier: '22', wave: String(i + 1), totalCoins: '100', roundDuration: '1h0m0s', reportTimestamp: new Date(1700000000000 + i * 1000).toISOString() }));
function interaction() { return { user: { id: 'share-owner', username: 'fixture', displayAvatarURL: () => '' }, client: {}, guildId: null, deferUpdate: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined), channel: { send: vi.fn().mockResolvedValue({}) }, message: { components: [] } }; }
beforeEach(() => {
  vi.clearAllMocks(); setTrackerFlowMode('share-owner', 'track');
  mocks.settings.mockResolvedValue({ shareChart: false }); mocks.runs.mockResolvedValue(rows);
  mocks.history.mockResolvedValue({ getRuns: mocks.runs }); mocks.snapshot.mockResolvedValue(undefined);
});
describe('verified share history', () => {
  it('refreshes stale #1 while preserving an older selected run and repeated share semantics', async () => {
    setShareableRun('share-owner', { run: rows[0], runTypeCounts: { Farming: 1 }, screenshotUrl: null });
    for (let i = 0; i < 2; i++) {
      const owner = interaction(); await handleTrackMenuShareLast(owner as never);
      expect(owner.channel.send).toHaveBeenCalledOnce();
      const payload = owner.channel.send.mock.calls[0][0] as { embed: { data: { title: string } } };
      expect(payload.embed.data.title).toBe('Farming Run #132');
      expect(mocks.snapshot.mock.calls.at(-1)?.[0].run.runId).toBe('run-0');
    }
    expect(mocks.history).toHaveBeenCalledTimes(2);
  });
  it('shares the newest retained run when no cached selection exists', async () => {
    setShareableRun('share-owner', { run: null as never, runTypeCounts: {}, screenshotUrl: null });
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(mocks.snapshot.mock.calls.at(-1)?.[0].run.runId).toBe('run-131');
    expect(owner.channel.send).toHaveBeenCalledOnce();
  });
  it('does not silently replace a deleted cached selection with another run', async () => {
    setShareableRun('share-owner', { run: { runId: 'deleted' }, runTypeCounts: { Farming: 1 }, screenshotUrl: null });
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).not.toHaveBeenCalled();
    expect(owner.followUp.mock.calls[0][0].content).toContain('no longer in your current history');
  });
  it('cloud failure sends no fabricated numbered share', async () => {
    mocks.history.mockRejectedValue(new Error('fixture cloud unavailable'));
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).not.toHaveBeenCalled();
    expect(owner.followUp.mock.calls[0][0].content).toContain('unavailable');
  });
});
