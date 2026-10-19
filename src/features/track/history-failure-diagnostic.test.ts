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
  it('copies bounded pagination counts without retaining mutable or arbitrary response data', () => {
    const error = historyFailureError('PRIVATE_RESPONSE', 'pagination', 'main_page', undefined, {
      pagination: { reason: 'empty_before_total', pageIndex: 2, returnedCount: 0, collectedCount: 100, expectedTotal: 101 },
    });
    const original = readHistoryFailure(error);
    const copy = readHistoryFailure(annotateHistoryFailure(error, 'cloud_history'));
    copy.pagination!.collectedCount = 0;
    expect(readHistoryFailure(error)).toEqual(original);
    expect(JSON.stringify(original)).not.toContain('PRIVATE_RESPONSE');
    for (const invalid of [
      { ...original.pagination, reason: 'PRIVATE_REASON' },
      { ...original.pagination, returnedCount: -1 },
      { ...original.pagination, expectedTotal: Infinity },
      { ...original.pagination, documents: 'PRIVATE_RESPONSE' },
    ]) expect(historyFailureSchema.safeParse({ ...original, pagination: invalid }).success).toBe(false);
  });
});

it('copies only registered history metadata to a privacy wrapper without inspecting getters', async () => {
  const { copyKnownHistoryFailure, getKnownHistoryFailure } = await import('./history-failure-diagnostic.js');
  const original = historyFailureError('PRIVATE', 'count_consistency', 'main_page');
  const copy = copyKnownHistoryFailure(Object.freeze(original), new Error('safe wrapper'));
  expect(getKnownHistoryFailure(copy)).toEqual(getKnownHistoryFailure(original));
  const metadata = getKnownHistoryFailure(copy)!; metadata.stage = 'unknown';
  expect(getKnownHistoryFailure(copy)?.stage).toBe('main_page');
  const getter = vi.fn(() => { throw Error('PRIVATE_GETTER'); });
  const forged = Object.defineProperty({}, 'historyFailure', { get: getter });
  expect(getKnownHistoryFailure(copyKnownHistoryFailure(forged, new Error('safe wrapper')))).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
});

