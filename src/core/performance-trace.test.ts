import { expect, it } from 'vitest';
import { measurePerformanceSpan, measurePerformanceSync, performanceTraceIdentity, performanceTraceSummary, withPerformanceTrace } from './performance-trace';

it('keeps overlapping operation IDs and nested measurements separate', async () => {
  const outputs = await Promise.all([0, 1].map(() => withPerformanceTrace(async () => {
    const identity = performanceTraceIdentity();
    await measurePerformanceSpan('cloud-main', async () => {
      await Promise.resolve();
      expect(performanceTraceIdentity()).toEqual(identity);
      return measurePerformanceSync('comparison', () => 42);
    });
    return performanceTraceSummary();
  })));
  expect(outputs[0].operationId).not.toBe(outputs[1].operationId);
  for (const output of outputs) {
    expect(output.pid).toBe(process.pid);
    expect(output.spans?.['cloud-main']).toMatchObject({ count: 1, sampled: 1 });
    expect(output.spans?.comparison).toMatchObject({ count: 1, sampled: 1 });
  }
  expect(performanceTraceSummary()).toEqual({});
});
it('preserves failures and bounds diagnostic samples without recording returned content', async () => {
  const failure = new Error('PRIVATE_RESULT');
  await withPerformanceTrace(async () => {
    await expect(measurePerformanceSpan('cloud-main', async () => { throw failure; })).rejects.toBe(failure);
    for (let i = 0; i < 300; i++) measurePerformanceSync('comparison', () => 'PRIVATE_RESULT');
    const summary = performanceTraceSummary();
    expect(summary.spans?.comparison).toMatchObject({ count: 300, sampled: 256 });
    expect(summary.spans?.['cloud-main']).toMatchObject({ count: 1 });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_RESULT');
  });
});
it('distinguishes an unfinished read from a completed zero-cost span', async () => {
  await withPerformanceTrace(async () => {
    let release!: () => void;
    const pending = measurePerformanceSpan('cloud-sdk', () => new Promise<void>(resolve => { release = resolve; }));
    expect(performanceTraceSummary().spans?.['cloud-sdk']).toMatchObject({ count: 0, pending: 1, sampled: 0, p50Ms: null, p95Ms: null });
    release(); await pending;
    expect(performanceTraceSummary().spans?.['cloud-sdk']).toMatchObject({ count: 1, pending: 0, sampled: 1 });
  });
});
