import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Client, Events, Status } from 'discord.js';
import { logger } from './logger';

export interface GatewayReadiness {
  schemaVersion: 1;
  pid: number;
  utc: string;
  discord: { ready: boolean };
}

function writeReadiness(sample: GatewayReadiness): void {
  const directory = join(process.cwd(), '.data');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'gateway-readiness.json');
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(sample));
  renameSync(temporary, target);
}

/** Local evidence only: no tokens, user data, network probes, or recovery actions. */
export function startGatewayReadiness(client: Client, write = writeReadiness): () => void {
  const disconnected = new Set<number>();
  let invalidated = false;
  let writeFailed = false;
  const publish = () => {
    const now = Date.now();
    // Client.isReady() can remain true during shard reconnects. Require every
    // shard to be ready with a recent acknowledged heartbeat as well.
    const ready = !invalidated && disconnected.size === 0 && client.isReady()
      && client.ws.shards.size > 0 && client.ws.shards.every(shard =>
        shard.status === Status.Ready && shard.lastPingTimestamp > 0
        && shard.lastPingTimestamp <= now && now - shard.lastPingTimestamp <= 90_000);
    try {
      write({ schemaVersion: 1, pid: process.pid, utc: new Date(now).toISOString(), discord: { ready } });
      writeFailed = false;
    } catch {
      if (!writeFailed) logger.warn('[gateway] readiness telemetry could not be persisted');
      writeFailed = true;
    }
  };
  const down = (shardId: number) => { disconnected.add(shardId); publish(); };
  const disconnect = (_event: unknown, shardId: number) => down(shardId);
  const up = (shardId: number) => { disconnected.delete(shardId); publish(); };
  const invalidate = () => { invalidated = true; publish(); };
  client.on(Events.ShardDisconnect, disconnect);
  client.on(Events.ShardReconnecting, down);
  client.on(Events.ShardReady, up);
  client.on(Events.ShardResume, up);
  client.on(Events.ClientReady, publish);
  client.on(Events.Invalidated, invalidate);
  publish();
  const timer = setInterval(publish, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    client.off(Events.ShardDisconnect, disconnect);
    client.off(Events.ShardReconnecting, down);
    client.off(Events.ShardReady, up);
    client.off(Events.ShardResume, up);
    client.off(Events.ClientReady, publish);
    client.off(Events.Invalidated, invalidate);
  };
}
