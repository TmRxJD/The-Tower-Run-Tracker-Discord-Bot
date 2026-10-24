import { expect, it, vi } from 'vitest';
const diagnostic = vi.hoisted(() => vi.fn());
vi.mock('./diagnostics', () => ({ recordDiagnostic: diagnostic }));
import { TrackerBotClient } from './tracker-bot-client';
import { withPerformanceTrace } from './performance-trace';
it('records REST waits without retaining private request metadata', async () => {
  const client = new TrackerBotClient({ intents: [] }, {} as never);
  try {
    client.rest.emit('rateLimited', { global: false, retryAfter: 7000, timeToReset: 6000, sublimitTimeout: 1000,
      route: 'PRIVATE_TOKEN', url: 'PRIVATE_TOKEN', hash: 'PRIVATE_TOKEN', majorParameter: 'PRIVATE_TOKEN' } as never);
    expect(diagnostic).toHaveBeenCalledWith('discord.rest.rate_limit', { global: false, retryAfterMs: 7000, timeToResetMs: 6000, sublimitTimeoutMs: 1000 });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE_TOKEN');
  } finally { await client.destroy(); }
});
it('correlates rate-limit events with the initiating operation without request identifiers', async () => {
  const client = new TrackerBotClient({ intents: [] }, {} as never);
  try {
    await withPerformanceTrace(async () => {
      client.rest.emit('rateLimited', { global: true, retryAfter: 1000, timeToReset: 1000, sublimitTimeout: 0,
        route: 'PRIVATE_TOKEN', hash: 'PRIVATE_TOKEN', majorParameter: 'PRIVATE_TOKEN' } as never);
      expect(diagnostic).toHaveBeenLastCalledWith('discord.rest.rate_limit', expect.objectContaining({
        operationId: expect.stringMatching(/^[a-f0-9-]{36}$/), pid: process.pid, retryAfterMs: 1000,
      }));
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE_TOKEN');
    });
  } finally { await client.destroy(); }
});
