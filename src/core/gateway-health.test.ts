import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('./logger', () => ({ logger }));

import { registerGatewayHealthLogging } from './gateway-health';

function makeClient() {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, { ws: { ping: 87 } }) as unknown as Client;
  registerGatewayHealthLogging(client);
  return emitter;
}

describe('gateway health logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the library line that states why the shard reconnected', () => {
    const client = makeClient();

    client.emit('debug', '[WS => Shard 0] Destroying shard\n\tReason: Told to reconnect by Discord\n\tCode: 4200\n\tRecover: Resume');

    expect(logger.warn).toHaveBeenCalledWith(
      '[gateway] cause',
      '[WS => Shard 0] Destroying shard Reason: Told to reconnect by Discord Code: 4200 Recover: Resume',
    );
  });

  it('forwards unexpected close codes and invalid sessions', () => {
    const client = makeClient();

    client.emit('debug', '[WS => Shard 0] The gateway closed with an unexpected code 1006, attempting to resume.');
    client.emit('debug', '[WS => Shard 0] Invalid session; will attempt to resume: true');

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('drops routine heartbeat chatter so the stream stays readable', () => {
    const client = makeClient();

    client.emit('debug', '[WS => Shard 0] Sending a heartbeat.');
    client.emit('debug', '[WS => Shard 0] Heartbeat acknowledged, latency of 81ms.');
    client.emit('debug', 'Preparing to connect to the gateway...');

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs reconnect and resume with the ping so recovery time can be judged', () => {
    const client = makeClient();

    client.emit('shardReconnecting', 0);
    client.emit('shardResume', 0, 1);

    expect(logger.warn).toHaveBeenCalledWith('[gateway] shard reconnecting', { shardId: 0 });
    expect(logger.warn).toHaveBeenCalledWith('[gateway] shard resumed', { shardId: 0, replayedEvents: 1, wsPingMs: 87 });
  });

  it('logs an unrecoverable disconnect with its close code as an error path', () => {
    const client = makeClient();

    client.emit('shardDisconnect', { code: 4004, reason: 'Authentication failed', wasClean: true }, 0);

    expect(logger.warn).toHaveBeenCalledWith('[gateway] shard disconnected', {
      shardId: 0,
      code: 4004,
      reason: 'Authentication failed',
      wasClean: true,
    });
  });

  it('keeps the process alive when the client emits an error', () => {
    const client = makeClient();

    expect(() => client.emit('error', new Error('boom'))).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});
