import type { EmbedBuilder } from 'discord.js';
import { logger } from '../../../core/logger';

export type DiagnosticClient = { channels: { fetch: (id: string) => Promise<unknown> } };
type Job = { client: DiagnosticClient; channelId: string; embed: EmbedBuilder; incident: string; correlation: { operationId?: string; pid?: number } };
/** Alerts cannot hold a user-response lock. Timed-out requests retain their slot until settlement. */
export function createDiagnosticDelivery(options: { concurrency?: number; maxQueued?: number; warningMs?: number } = {}) {
  const concurrency = options.concurrency ?? 2, maxQueued = options.maxQueued ?? 32, warningMs = options.warningMs ?? 5_000;
  const queue: Job[] = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift()!; active++;
      const started = performance.now();
      const meta = { incident: job.incident, ...job.correlation };
      const timer = setTimeout(() => logger.warn('[diag] diagnostic.delivery', { ...meta, outcome: 'slow_pending', elapsedMs: Math.round(performance.now() - started), active, queued: queue.length }), warningMs);
      timer.unref?.();
      void Promise.resolve().then(async () => {
        const channel = await job.client.channels.fetch(job.channelId);
        if (!channel || typeof channel !== 'object' || !('send' in channel) || typeof channel.send !== 'function') throw new Error('Diagnostic channel unavailable');
        await channel.send({ embeds: [job.embed], allowedMentions: { parse: [] } });
      }).then(() => logger.warn('[diag] diagnostic.delivery', { ...meta, outcome: 'delivered', elapsedMs: Math.round(performance.now() - started) }),
        () => logger.error('Tracker diagnostic delivery failed', { ...meta, elapsedMs: Math.round(performance.now() - started) }))
        .finally(() => { clearTimeout(timer); active--; drain(); });
    }
  };
  return {
    enqueue(job: Job): boolean {
      if (queue.length >= maxQueued) { logger.warn('[diag] diagnostic.delivery', { incident: job.incident, ...job.correlation, outcome: 'queue_full', active, queued: queue.length }); return false; }
      queue.push(job); drain(); return true;
    },
    state: () => ({ active, queued: queue.length }),
  };
}
export const diagnosticDelivery = createDiagnosticDelivery();
