import { afterEach, expect, it, vi } from 'vitest';
import { EmbedBuilder } from 'discord.js';
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: log }));
import { createDiagnosticDelivery } from './diagnostic-delivery';
afterEach(() => vi.useRealTimers());

it('bounds queued/in-flight alerts and retains slow requests rather than retrying or releasing their slots', async () => {
  vi.useFakeTimers(); log.warn.mockClear(); log.error.mockClear();
  let release!: (channel: unknown) => void;
  const blocked = new Promise(resolve => { release = resolve; });
  const fetch = vi.fn(() => blocked), send = vi.fn().mockResolvedValue({});
  const delivery = createDiagnosticDelivery({ concurrency: 1, maxQueued: 1, warningMs: 100 });
  const job = { client: { channels: { fetch } }, channelId: 'PRIVATE_CHANNEL', embed: new EmbedBuilder().setDescription('safe incident'), incident: 'incident', correlation: { operationId: 'opaque', pid: process.pid } };
  expect(delivery.enqueue(job)).toBe(true); expect(delivery.enqueue(job)).toBe(true); expect(delivery.enqueue(job)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivery.state()).toEqual({ active: 1, queued: 1 }); expect(fetch).toHaveBeenCalledOnce();
  expect(log.warn.mock.calls.some(([, data]) => data.outcome === 'slow_pending')).toBe(true);
  release({ send }); await vi.advanceTimersByTimeAsync(0);
  expect(delivery.state()).toEqual({ active: 0, queued: 0 }); expect(fetch).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([...log.warn.mock.calls, ...log.error.mock.calls])).not.toContain('PRIVATE_');
});
