import { expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../../core/logger', () => ({ logger: logs }));
import { createCompareObservation } from './compare-telemetry';

it('logs only allowlisted outcome/timing metadata, never raw errors, IDs or run data', () => {
  logs.warn.mockClear();
  const observation = createCompareObservation('select');
  observation.stage('run-read');
  observation.failure(Object.assign(new Error('PRIVATE_RUN https://private.invalid/token'), { code: 'PRIVATE_TOKEN', userId: 'private-owner', run: { notes: 'PRIVATE_NOTES' } }));
  observation.finish();
  const [label, payload] = logs.warn.mock.calls[0];
  expect(label).toBe('[share-compare] interaction');
  expect(Object.keys(payload).sort()).toEqual(['action', 'durationMs', 'outcome', 'pid', 'stage']);
  expect(payload).toMatchObject({ pid: process.pid, action: 'select', outcome: 'failed', stage: 'run-read', durationMs: expect.any(Number) });
  expect(JSON.stringify(logs.warn.mock.calls)).not.toMatch(/PRIVATE|private-owner|private.invalid/);
});
it('retains only numeric Discord error codes and explicit delivery outcomes', () => {
  logs.warn.mockClear();
  const failed = createCompareObservation('open'); failed.failure({ code: 50027 }, 'ack_failed'); failed.finish();
  expect(logs.warn.mock.calls[0][1]).toMatchObject({ outcome: 'ack_failed', code: 50027 });
  const delivered = createCompareObservation('select'); delivered.stage('reply'); delivered.outcome('comparison_delivered'); delivered.finish();
  expect(logs.warn.mock.calls[1][1]).toMatchObject({ outcome: 'comparison_delivered', stage: 'reply' });
});
