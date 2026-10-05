import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { parseRunDataFromText as OriginalParser } from './upload-helpers';
type HelperModule = { parseRunDataFromText: typeof OriginalParser };
const mocks = vi.hoisted(() => ({ modal: vi.fn(), begin: vi.fn(), diagnostic: vi.fn(), history: vi.fn(), create: vi.fn(), review: vi.fn(), log: vi.fn(), parse: vi.fn() }));
vi.mock('../../../core/interaction-session', () => ({ awaitOwnedModalSubmit: mocks.modal }));
vi.mock('../../../core/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../paste-diagnostics', () => ({ beginPasteDiagnostic: mocks.begin, updatePasteDiagnostic: mocks.diagnostic }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.history, withBotRunSubmissionLock: async (_user: string, action: (context: { setStage: () => void }) => Promise<unknown>) => action({ setStage: vi.fn() }) }));
vi.mock('../pending-run-store', async original => ({ ...await original<object>(), createPendingRun: mocks.create }));
vi.mock('../local-run-store', async original => ({ ...await original<object>(), getLocalSettings: async () => ({ autoDetectDuplicates: true }) }));
vi.mock('../upload-target-profile', () => ({ listBotUserProfiles: async () => [], peekPendingUploadProfile: () => null, resolveDefaultUploadProfileId: async () => null, setPendingUploadProfile: vi.fn() }));
vi.mock('./data-review-handlers', () => ({ renderDataReview: mocks.review, renderEditFieldPicker: vi.fn() }));
vi.mock('./error-handlers', () => ({ logError: mocks.log, handleError: vi.fn() }));
vi.mock('./upload-helpers', async original => {
  const actual = await original<HelperModule>();
  return { ...actual, parseRunDataFromText: mocks.parse };
});
import { handleAddRunFlow } from './upload-handlers';
import { safeErrorDiagnostic } from './safe-error-diagnostic';
import { setTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS } from '../track-custom-ids';
import { historyFailureError } from '../history-failure-diagnostic';

const report = 'Battle Report\nBattle Date\tOct 05, 2026 15:00\nTier\t22\nWave\t900\nReal Time\t1h 0m 0s\nCoins earned\t0\nCells Earned\t0\nReroll Shards Earned\t0';
function interaction(text: string) {
  const parent = { user: { id: 'modal-fixture', username: 'fixture' }, client: {}, showModal: vi.fn(), editReply: vi.fn() };
  const submitted = { user: parent.user, client: {}, deferUpdate: vi.fn(), editReply: vi.fn().mockResolvedValue({}),
    fields: { getTextInputValue: (id: string) => id === TRACKER_IDS.flow.addRunPasteText ? text : '' } };
  mocks.modal.mockResolvedValue(submitted);
  return { parent, submitted };
}
beforeEach(async () => {
  vi.resetAllMocks(); setTrackerFlowMode('modal-fixture', 'track');
  const original = await vi.importActual<HelperModule>('./upload-helpers');
  mocks.parse.mockImplementation(original.parseRunDataFromText);
  mocks.begin.mockResolvedValue('P-modal-fixture'); mocks.diagnostic.mockResolvedValue(true);
  mocks.history.mockResolvedValue({ getRuns: async () => [] });
  mocks.create.mockImplementation(async record => ({ ...record, token: 'fixture-token' }));
});
describe('Add Run modal paste integration', () => {
  it('rejects malformed input before history or pending writes, with a private reference and safe classification', async () => {
    const { parent, submitted } = interaction('SYNTHETIC_PRIVATE_NOT_A_REPORT');
    await handleAddRunFlow(parent as never);
    expect(mocks.begin).toHaveBeenCalledWith('modal-fixture', 'modal', 'SYNTHETIC_PRIVATE_NOT_A_REPORT');
    expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.diagnostic).toHaveBeenCalledWith('P-modal-fixture', expect.objectContaining({ result: 'rejected', stage: 'parse', errorCode: 'unrecognized_report' }));
    const call = mocks.log.mock.calls[0];
    expect(safeErrorDiagnostic(call[2], call[3], call[6])).toMatchObject({ code: 'unrecognized_report', operation: 'paste_add_run_modal', stage: 'parse' });
    expect(call[2].message + call[2].stack + JSON.stringify(submitted.editReply.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_NOT_A_REPORT');
    expect(submitted.editReply.mock.calls.at(-1)?.[0].content).toContain('Battle Date');
  });
  it('prepares recognized reports with genuine zero currencies and carries the diagnostic into review', async () => {
    const { parent } = interaction(report); await handleAddRunFlow(parent as never);
    expect(mocks.history).toHaveBeenCalledOnce(); expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ pasteDiagnosticId: 'P-modal-fixture', runData: { totalCoins: '0', totalCells: '0', totalDice: '0' } });
    expect(mocks.diagnostic).toHaveBeenCalledWith('P-modal-fixture', { result: 'review_ready', stage: 'review' });
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each(['Coins earned', 'Cells Earned', 'Reroll Shards Earned'])('rejects missing %s without treating it as zero', async label => {
    const text = report.split('\n').filter(line => !line.startsWith(label)).join('\n');
    const { parent } = interaction(text); await handleAddRunFlow(parent as never);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
    // The shared parser returns null for incomplete required currency columns.
    expect(mocks.diagnostic).toHaveBeenCalledWith('P-modal-fixture', expect.objectContaining({ result: 'rejected', errorCode: 'unrecognized_report' }));
    expect(mocks.log).toHaveBeenCalledOnce();
  });
  it('classifies a history failure separately from parser rejection and creates no pending write', async () => {
    mocks.history.mockRejectedValue(historyFailureError('SYNTHETIC_PRIVATE_HISTORY', 'count_consistency', 'main_count'));
    const { parent, submitted } = interaction(report); await handleAddRunFlow(parent as never);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.diagnostic).toHaveBeenCalledWith('P-modal-fixture', expect.objectContaining({ result: 'failed', stage: 'history', errorCode: 'history_unavailable', historyFailure: expect.objectContaining({ cause: 'count_consistency', stage: 'main_count' }) }));
    expect(submitted.editReply.mock.calls.at(-1)?.[0].content).toContain('no run was saved');
    const call = mocks.log.mock.calls[0];
    expect(safeErrorDiagnostic(call[2], call[3], call[6])).toMatchObject({ code: 'history_unavailable', stage: 'history', operation: 'paste_add_run_modal' });
  });
  it('continues valid review and visible rejection when diagnostic storage is unavailable', async () => {
    mocks.diagnostic.mockResolvedValue(false);
    let flow = interaction(report); await handleAddRunFlow(flow.parent as never);
    expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.review).toHaveBeenCalledOnce();
    mocks.create.mockClear(); mocks.review.mockClear();
    flow = interaction('SYNTHETIC_INVALID'); await handleAddRunFlow(flow.parent as never);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
    expect(flow.submitted.editReply.mock.calls.at(-1)?.[0].content).toContain('Reference:');
  });
  it('keeps unexpected parser defects error-visible without treating them as expected invalid input', async () => {
    mocks.parse.mockImplementation(() => { throw new Error('SYNTHETIC_PRIVATE_PARSER_DEFECT'); });
    const { parent, submitted } = interaction(report); await handleAddRunFlow(parent as never);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.diagnostic).toHaveBeenCalledWith('P-modal-fixture', expect.objectContaining({ result: 'failed', stage: 'parse', errorCode: 'internal_error' }));
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(submitted.editReply.mock.calls.at(-1)?.[0].content).toContain('could not be processed');
    expect(mocks.log.mock.calls[0][2].message + mocks.log.mock.calls[0][2].stack + JSON.stringify(submitted.editReply.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_PARSER_DEFECT');
  });
});
