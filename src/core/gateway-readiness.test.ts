import { EventEmitter } from 'node:events';
import { type Client, Collection, Status } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGatewayReadiness, type GatewayReadiness } from './gateway-readiness';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T18:00:00Z'));
  const shard = { status: Status.Ready, lastPingTimestamp: Date.now() };
  const client = Object.assign(new EventEmitter(), {
    isReady: () => true, ws: { shards: new Collection([[0, shard]]) },
  });
  const samples: GatewayReadiness[] = [];
  cleanups.push(startGatewayReadiness(client as unknown as Client, sample => samples.push(sample)));
  return { client, shard, samples, last: () => samples[samples.length - 1] };
}

describe('process-bound gateway readiness', () => {
  it('publishes the current PID, UTC time, and current heartbeat readiness', () => {
    const f = fixture();
    expect(f.last()).toEqual({ schemaVersion: 1, pid: process.pid, utc: '2026-10-08T18:00:00.000Z', discord: { ready: true } });
  });
  it.each(['shardReady', 'shardResume'])('recovers after %s, but never from aggregate ready alone', event => {
    const f = fixture();
    f.client.emit('shardReconnecting', 0);
    expect(f.last().discord.ready).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(f.last().discord.ready).toBe(false);
    f.shard.lastPingTimestamp = Date.now();
    f.client.emit(event, 0);
    expect(f.last().discord.ready).toBe(true);
  });
  it('retains a real disconnect and rejects stale heartbeats even if aggregate ready remains true', () => {
    const f = fixture();
    f.client.emit('shardDisconnect', {}, 0);
    expect(f.last().discord.ready).toBe(false);
    f.client.emit('shardReady', 0);
    vi.advanceTimersByTime(120_000);
    expect(f.last().discord.ready).toBe(false);
  });
  it('requires every shard and cannot clear invalidation with a later ready event', () => {
    const f = fixture();
    f.client.ws.shards.set(1, { status: Status.Connecting, lastPingTimestamp: Date.now() });
    f.client.emit('clientReady');
    expect(f.last().discord.ready).toBe(false);
    f.client.ws.shards.delete(1);
    f.client.emit('invalidated');
    f.client.emit('shardReady', 0);
    expect(f.last().discord.ready).toBe(false);
  });
  it('contains disk failures without stopping the bot or retrying in a tight loop', () => {
    const f = fixture();
    const write = vi.fn(() => { throw new Error('fixture write failed'); });
    const stop = startGatewayReadiness(f.client as unknown as Client, write);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledTimes(2);
    stop();
  });
});
