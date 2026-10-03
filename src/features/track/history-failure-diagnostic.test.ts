import { describe, expect, it, vi } from 'vitest';
import { annotateHistoryFailure, historyFailureError, historyFailureSchema, readHistoryFailure } from './history-failure-diagnostic';

describe('allowlisted history failure metadata', () => {
  it.each([
    [{ code: 429, response: 'PRIVATE' }, 'http_status', 429],
    [{ status: 503, message: 'PRIVATE' }, 'http_status', 503],
    [{ code: 'ECONNRESET', stack: 'PRIVATE' }, 'transport', undefined],
    [{ cause: { code: 'ENOTFOUND', message: 'PRIVATE' } }, 'transport', undefined],
    [{ code: 'ETIMEDOUT', request: 'PRIVATE' }, 'timeout', undefined],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'timeout', undefined],
    [{ code: 'PRIVATE', status: 9999, name: 'ZodError', issues: 'PRIVATE' }, 'unknown', undefined],
  ])('classifies only bounded status or known transport codes %#', (error, cause, status) => {
    const diagnostic = readHistoryFailure(error, 'main_page');
    expect(diagnostic).toMatchObject({ cause, stage: 'main_page' });
    expect(diagnostic.status).toBe(status);
    expect(historyFailureSchema.safeParse(diagnostic).success).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
  });
  it('does not invoke getters or trust forged metadata, messages or stacks', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const error = Object.defineProperties({}, { code: { get: getter }, status: { get: getter }, cause: { get: getter }, message: { get: getter }, historyFailure: { value: { cause: 'schema', stage: 'PRIVATE' } } });
    expect(readHistoryFailure(error).cause).toBe('unknown'); expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter });
    expect(readHistoryFailure(proxy).cause).toBe('unknown');
  });
  it('retains registered guard cause/stage/correlation through sanitization without exception content', () => {
    const error = historyFailureError('PRIVATE\n    at PRIVATE', 'count_consistency', 'main_count');
    const original = readHistoryFailure(error);
    const propagated = annotateHistoryFailure(error, 'cloud_history');
    expect(readHistoryFailure(propagated)).toEqual(original);
    const copy = readHistoryFailure(error); copy.stage = 'unknown';
    expect(readHistoryFailure(error).stage).toBe('main_count');
    expect(JSON.stringify(original)).not.toContain('PRIVATE');
    expect(readHistoryFailure(annotateHistoryFailure('PRIVATE', 'identity')).cause).toBe('unknown');
  });
});
