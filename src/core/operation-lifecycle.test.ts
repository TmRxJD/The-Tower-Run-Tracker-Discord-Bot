import { expect, it, vi } from 'vitest';
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./logger', () => ({ logger: log }));
import { observeOperation } from './operation-lifecycle';
import { bindPerformanceFlow, markPerformanceFailure, setPerformanceTraceStage } from './performance-trace';

it('correlates start/finish, stage and an opaque session reference without logging its token or the thrown error', async () => {
  log.warn.mockClear(); const failure = new Error('PRIVATE_REPORT_IMAGE_URL_TOKEN');
  await expect(observeOperation('submission', async () => {
    bindPerformanceFlow('PRIVATE_REPORT_IMAGE_URL_TOKEN', 'lifetime'); setPerformanceTraceStage('save'); throw failure;
  })).rejects.toBe(failure);
  const start = log.warn.mock.calls[0][1], finish = log.warn.mock.calls.at(-1)![1];
  expect(finish).toMatchObject({ operationId: start.operationId, pid: process.pid, diagnosticStage: 'save', flowMode: 'lifetime', rejected: true, handledFailure: true });
  expect(finish.flowRef).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE_');
});
it('marks a handled failure without pretending the handler rejected', async () => {
  log.warn.mockClear(); await observeOperation('interaction', async () => { markPerformanceFailure(); });
  expect(log.warn.mock.calls.at(-1)![1]).toMatchObject({ rejected: false, handledFailure: true });
});
