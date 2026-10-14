import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), runs: vi.fn(), create: vi.fn(), review: vi.fn(), ocr: vi.fn(), settings: vi.fn() }));
vi.mock('../paste-diagnostics', () => ({ beginPasteDiagnostic: async () => 'P-test-fixture', updatePasteDiagnostic: async () => true }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.prepare, withBotRunSubmissionLock: async (_user: string, action: (context: { setStage: () => void }) => Promise<unknown>) => action({ setStage: vi.fn() }) }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(), runOCR: mocks.ocr }));
vi.mock('../local-run-store', async importOriginal => ({ ...await importOriginal<object>(), getLocalSettings: mocks.settings }));
vi.mock('../pending-run-store', async importOriginal => ({ ...await importOriginal<object>(), createPendingRun: mocks.create }));
vi.mock('./data-review-handlers', () => ({ renderDataReview: mocks.review, renderEditFieldPicker: vi.fn() }));
vi.mock('../upload-target-profile', () => ({ listBotUserProfiles: async () => [], peekPendingUploadProfile: () => null, resolveDefaultUploadProfileId: async () => null, setPendingUploadProfile: vi.fn() }));
vi.mock('./error-handlers', () => ({ handleError: vi.fn(), logError: vi.fn() }));
import { handleDirectAttachment, handleDirectTextPaste } from './upload-handlers';
import { setTrackerFlowMode } from '../flow-mode-store';

const candidate = { tier: '22', wave: '900', totalCoins: '100', totalCells: '10', totalDice: '1', roundDuration: '1h0m0s', type: 'Farming' };
const interaction = () => ({ user: { id: 'fixture-owner', username: 'fixture' }, client: {}, editReply: vi.fn().mockResolvedValue({}), deferred: true });
beforeEach(() => {
  vi.clearAllMocks(); setTrackerFlowMode('fixture-owner', 'track');
  mocks.settings.mockResolvedValue({ autoDetectDuplicates: true });
  mocks.runs.mockResolvedValue(Array.from({ length: 132 }, (_, i) => ({ ...candidate, runId: `run-${i}`, localId: `local-${i}`, wave: String(900 + i) })));
  mocks.prepare.mockResolvedValue({ getRuns: mocks.runs });
  mocks.create.mockImplementation(async record => ({ ...record, token: 'fixture-token' }));
  mocks.ocr.mockResolvedValue({ runData: candidate, text: [], source: 'fixture' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
});
describe('direct upload history paths', () => {
  it('direct pasted report checks all cold-cache history before review', async () => {
    await handleDirectTextPaste(interaction() as never,
      'Battle Report\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1', null, null, 'Farming', 'track');
    expect(mocks.prepare).toHaveBeenCalledWith('fixture-owner', { readOnly: true, onStage: expect.any(Function) });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ isDuplicate: true, runData: { runId: 'run-0' } });
    expect(mocks.review).toHaveBeenCalledOnce();
  });
  it('direct screenshot checks the same complete history before review', async () => {
    await handleDirectAttachment(interaction() as never, { url: 'https://example.invalid/fixture.png', name: 'fixture.png' }, null, 'Farming', 'track');
    expect(mocks.prepare).toHaveBeenCalledWith('fixture-owner', { readOnly: true, onStage: expect.any(Function) });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ isDuplicate: true, runData: { runId: 'run-0' } });
    expect(mocks.review).toHaveBeenCalledOnce();
  });
  it('a history failure in either upload path creates no pending run or success review', async () => {
    mocks.prepare.mockRejectedValue(new Error('fixture cloud unavailable'));
    await handleDirectTextPaste(interaction() as never, 'Tier\t22\nWave\t900', null, null, 'Farming', 'track');
    await handleDirectAttachment(interaction() as never, { url: 'https://example.invalid/fixture.png', name: 'fixture.png' }, null, 'Farming', 'track');
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });
});
it.each(['paste', 'screenshot'])('captures the input flow before asynchronous history finishes: %s', async source => {
  let finish!: (history: { getRuns: typeof mocks.runs }) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const work = source === 'paste'
    ? handleDirectTextPaste(interaction() as never, 'Battle Report\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1', null, null, 'Farming', 'track')
    : handleDirectAttachment(interaction() as never, { url: 'https://example.invalid/fixture.png', name: 'fixture.png' }, null, 'Farming', 'track');
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  setTrackerFlowMode('fixture-owner', 'lifetime'); finish({ getRuns: mocks.runs }); await work;
  expect(mocks.create.mock.calls[0][0].flowMode).toBe('track');
});
