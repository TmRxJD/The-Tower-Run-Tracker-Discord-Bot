import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), runs: vi.fn(), create: vi.fn(), review: vi.fn(), ocr: vi.fn(), settings: vi.fn() }));
vi.mock('../paste-diagnostics', () => ({ beginPasteDiagnostic: async () => 'P-test-fixture', updatePasteDiagnostic: async () => true }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.prepare, withBotRunSubmissionLock: async (_user: string, action: (context: { setStage: () => void }) => Promise<unknown>) => action({ setStage: vi.fn() }) }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(), runOCR: mocks.ocr }));
vi.mock('../local-run-store', async importOriginal => ({ ...await importOriginal<object>(), getLocalSettings: mocks.settings }));
vi.mock('../pending-run-store', async importOriginal => ({ ...await importOriginal<object>(), createPendingRun: mocks.create }));
vi.mock('./data-review-handlers', () => ({ renderDataReview: mocks.review, renderEditFieldPicker: vi.fn() }));
vi.mock('../upload-target-profile', () => ({ listBotUserProfiles: async () => [], peekPendingUploadProfile: () => null, resolveDefaultUploadProfileId: async () => null, setPendingUploadProfile: vi.fn() }));
vi.mock('./error-handlers', () => ({ handleError: vi.fn(), logError: vi.fn() }));
import { handleDirectAttachment, handleDirectTextPaste, handleAddRunFlow, handleUploadFlow, handleTrackMenuManual,
  handleManualTypeSelection, handleManualNote, handleManualEditStageOne, handleManualEditStageTwo, handleManualNext,
  handleManualBackToMenu } from './upload-handlers';
import { TRACKER_IDS } from '../track-custom-ids';
import { setTrackerFlowMode } from '../flow-mode-store';

const candidate = { tier: '22', wave: '900', totalCoins: '100', totalCells: '10', totalDice: '1', roundDuration: '1h0m0s', type: 'Farming' };
const interaction = () => ({ user: { id: 'fixture-owner', username: 'fixture' }, client: {}, editReply: vi.fn().mockResolvedValue({}), deferred: true });
beforeEach(() => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', 'true');
  vi.clearAllMocks(); setTrackerFlowMode('fixture-owner', 'track');
  mocks.settings.mockResolvedValue({ autoDetectDuplicates: true });
  mocks.runs.mockResolvedValue(Array.from({ length: 132 }, (_, i) => ({ ...candidate, runId: `run-${i}`, localId: `local-${i}`, wave: String(900 + i) })));
  mocks.prepare.mockResolvedValue({ getRuns: mocks.runs });
  mocks.create.mockImplementation(async record => ({ ...record, token: 'fixture-token' }));
  mocks.ocr.mockResolvedValue({ runData: candidate, text: [], source: 'fixture' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
});
afterEach(() => vi.unstubAllEnvs());
describe('direct upload history paths', () => {
  it('direct pasted report checks local saved history before review', async () => {
    await handleDirectTextPaste(interaction() as never,
      'Battle Report\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1', null, null, 'Farming', 'track');
    expect(mocks.prepare).toHaveBeenCalledWith('fixture-owner', { localFirst: true, readOnly: true, mainOnly: true, onStage: expect.any(Function) });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ isDuplicate: true, runData: { runId: 'run-0' } });
    expect(mocks.review).toHaveBeenCalledOnce();
  });
  it('direct screenshot checks the same local history before review', async () => {
    await handleDirectAttachment(interaction() as never, { url: 'https://example.invalid/fixture.png', name: 'fixture.png' }, null, 'Farming', 'track');
    expect(mocks.prepare).toHaveBeenCalledWith('fixture-owner', { localFirst: true, readOnly: true, mainOnly: true, onStage: expect.any(Function) });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ isDuplicate: true, runData: { runId: 'run-0' } });
    expect(mocks.review).toHaveBeenCalledOnce();
  });
  it('a local-storage failure in either upload path creates no pending run or success review', async () => {
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

it('skips cloud history entirely when duplicate detection is disabled', async () => {
  mocks.settings.mockResolvedValue({ autoDetectDuplicates: false });
  await handleDirectTextPaste(interaction() as never, 'Battle Report\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1', null, null, 'Farming', 'track');
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.review).toHaveBeenCalledOnce();
});

it('rejects standalone screenshot OCR in both Track and Lifetime without touching the file', async () => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', 'false');
  for (const mode of ['track', 'lifetime'] as const) {
    const submission = interaction();
    await handleDirectAttachment(submission as never, { url: 'https://example.invalid/fixture.png' }, null, undefined, mode);
    expect(submission.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/export|Import Save File/) }));
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.ocr).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it('keeps an optional screenshot with a real text export without invoking OCR', async () => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', 'false');
  await handleDirectTextPaste(interaction() as never,
    'Battle Report\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t100\nCells Earned\t10\nReroll Shards Earned\t1',
    { url: 'https://example.invalid/fixture.png', name: 'fixture.png' }, null, 'Farming', 'track');
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ screenshot: { name: 'fixture.png' } });
  expect(mocks.review).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.ocr).not.toHaveBeenCalled();
});

it('stale manual buttons show export guidance before opening or creating drafts; opt-in restores manual creation', async () => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', 'false');
  for (const handler of [handleTrackMenuManual, handleManualTypeSelection, handleManualNote, handleManualEditStageOne,
    handleManualEditStageTwo, handleManualNext, handleManualBackToMenu]) {
    const submission = { ...interaction(), deferUpdate: vi.fn().mockResolvedValue(undefined), showModal: vi.fn() };
    await handler(submission as never);
    expect(submission.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Battle Report export') }));
    expect(submission.showModal).not.toHaveBeenCalled();
  }
  expect(mocks.create).not.toHaveBeenCalled();
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', 'true');
  const submission = { ...interaction(), deferUpdate: vi.fn().mockResolvedValue(undefined) };
  await handleTrackMenuManual(submission as never);
  expect(mocks.create).toHaveBeenCalledOnce();
});

it.each([false, true])('add run requires pasted text when legacy input is off or opens the OCR modal when enabled (%s)', async enabled => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', String(enabled));
  const submission = {
    ...interaction(), showModal: vi.fn().mockResolvedValue(undefined),
    awaitModalSubmit: vi.fn().mockRejectedValue(new Error('mocked collection end')),
  };
  await handleAddRunFlow(submission as never);
  const trackModal = submission.showModal.mock.lastCall?.[0].toJSON();
  const serialized = JSON.stringify(trackModal);
  expect(serialized).toContain(TRACKER_IDS.flow.addRunPasteText);
  expect(serialized).toContain(TRACKER_IDS.flow.addRunFile);
  expect(trackModal.components[0].components[0].required).toBe(!enabled);
  submission.showModal.mockClear();
  await handleUploadFlow(submission as never);
  expect(submission.showModal).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (!enabled) expect(submission.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Battle Report export') }));
});
it.each([false, true])('an older Add Run modal submitting a screenshot alone obeys the switch (%s)', async enabled => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', String(enabled));
  const submitted = {
    ...interaction(), deferUpdate: vi.fn().mockResolvedValue(undefined),
    fields: { getTextInputValue: vi.fn().mockReturnValue('') },
    attachments: [{ url: 'https://example.invalid/fixture.png', name: 'fixture.png', contentType: 'image/png' }],
  };
  const component = {
    ...interaction(), showModal: vi.fn().mockResolvedValue(undefined),
    awaitModalSubmit: vi.fn().mockResolvedValue(submitted),
  };
  await handleAddRunFlow(component as never);
  expect(mocks.ocr).toHaveBeenCalledTimes(enabled ? 1 : 0);
  expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (!enabled) expect(submitted.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Battle Report export') }));
});
