import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ update: vi.fn(), log: vi.fn() }));
vi.mock('../paste-diagnostics', () => ({ updatePasteDiagnostic: mocks.update }));
vi.mock('./error-handlers', () => ({ logError: mocks.log }));
import { reportPasteFailure } from './paste-failure-response';
import { IncompleteRunReportError } from './paste-input-error';
beforeEach(() => { vi.clearAllMocks(); mocks.update.mockResolvedValue(true); });
const interaction = () => ({ user: { id: 'fixture-user' }, client: {}, editReply: vi.fn().mockResolvedValue({}) });
describe('paste rejection visibility and privacy', () => {
  it('gives actionable expected-input guidance without generating a false system-error alert', async () => {
    const owner = interaction(); await reportPasteFailure(owner as never, new IncompleteRunReportError('missing_fields'), 'fixture-reference', 'parse', 'direct_text_paste');
    expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.update).toHaveBeenCalledWith('fixture-reference', expect.objectContaining({ result: 'rejected', errorCode: 'missing_fields' }));
    expect(owner.editReply.mock.calls[0][0].content).toContain('Battle Date'); expect(owner.editReply.mock.calls[0][0].content).toContain('fixture-reference');
  });
  it('keeps unrecognized formats error-visible without pretending the parser is fixed', async () => {
    const owner = interaction(); await reportPasteFailure(owner as never, new IncompleteRunReportError('unrecognized_report'), 'fixture-reference', 'parse', 'direct_text_paste');
    expect(mocks.log).toHaveBeenCalledOnce(); expect(mocks.log.mock.calls[0][2].message).toContain('unrecognized_report');
  });
  it('does not leak private text via exception messages, fake stack lines, logs or error replies', async () => {
    const body = 'synthetic-private-body'; const error = new Error(body + '\n    at ' + body);
    const owner = interaction(); await reportPasteFailure(owner as never, error, 'fixture-reference', 'parse', 'direct_text_paste');
    const sentError = mocks.log.mock.calls[0][2];
    expect(sentError.message + sentError.stack).not.toContain(body);
    expect(JSON.stringify(owner.editReply.mock.calls)).not.toContain(body);
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ result: 'failed', errorCode: 'internal_error' });
  });
  it('history and diagnostic-storage failure cannot be called successful or misclassified as bad input', async () => {
    mocks.update.mockResolvedValue(false); const owner = interaction();
    await reportPasteFailure(owner as never, new Error('synthetic-private-body'), 'fixture-reference', 'history', 'paste_flow_modal');
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ result: 'failed', errorCode: 'history_unavailable' });
    expect(owner.editReply.mock.calls[0][0].content).toContain('no run was saved'); expect(mocks.log).toHaveBeenCalledOnce();
  });
});
