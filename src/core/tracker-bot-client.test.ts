import { expect, it, vi } from 'vitest';
const diagnostic = vi.hoisted(() => vi.fn());
vi.mock('./diagnostics', () => ({ recordDiagnostic: diagnostic }));
import { TrackerBotClient } from './tracker-bot-client';
it('records REST waits without retaining private request metadata', async () => {
  const client = new TrackerBotClient({ intents: [] }, {} as never);
  try {
    client.rest.emit('rateLimited', { global: false, retryAfter: 7000, timeToReset: 6000, sublimitTimeout: 1000,
      route: 'PRIVATE_TOKEN', url: 'PRIVATE_TOKEN', hash: 'PRIVATE_TOKEN', majorParameter: 'PRIVATE_TOKEN' } as never);
    expect(diagnostic).toHaveBeenCalledWith('discord.rest.rate_limit', { global: false, retryAfterMs: 7000, timeToResetMs: 6000, sublimitTimeoutMs: 1000 });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE_TOKEN');
  } finally { await client.destroy(); }
});
