import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSharedDiscordTokenLock } from './single-instance-lock';

describe('shared discord token lock', () => {
  const created: string[] = [];

  function newKey(): { key: string; path: string } {
    const key = `test-${randomUUID()}`;
    const path = join(tmpdir(), `tower-discord-token-${key}.lock`);
    created.push(path);
    return { key, path };
  }

  afterEach(() => {
    for (const path of created.splice(0)) {
      rmSync(path, { force: true });
    }
  });

  it('acquires, writes a heartbeat-bearing lock, and releases it', async () => {
    const { key, path } = newKey();

    const release = await acquireSharedDiscordTokenLock(key, 'test bot');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ pid: process.pid, label: 'test bot' });
    expect(typeof written.heartbeatAt).toBe('number');

    await release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a second holder while the first heartbeat is fresh', async () => {
    const { key, path } = newKey();
    // The pid is alive (this process) and the heartbeat is fresh, so the lock is real.
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), label: 'live bot' }));

    await expect(acquireSharedDiscordTokenLock(key, 'second bot')).rejects.toThrow(/live bot is already running/);
  });

  it('takes over a lock whose pid was recycled but whose heartbeat stopped', async () => {
    const { key, path } = newKey();
    const longAgo = Date.now() - 10 * 60_000;
    // pid exists (this process stands in for the unrelated process that reused it), but the
    // heartbeat is ten minutes old, so no live bot is behind it.
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: longAgo, heartbeatAt: longAgo, label: 'dead bot' }));

    const release = await acquireSharedDiscordTokenLock(key, 'new bot');
    expect(JSON.parse(readFileSync(path, 'utf8')).label).toBe('new bot');
    await release();
  });

  it('takes over a lock whose pid no longer exists', async () => {
    const { key, path } = newKey();
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_000, startedAt: Date.now(), heartbeatAt: Date.now(), label: 'crashed bot' }));

    const release = await acquireSharedDiscordTokenLock(key, 'new bot');
    await release();
  });
});
