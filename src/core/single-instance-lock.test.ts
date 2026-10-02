import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
      if (!existsSync(path)) continue;
      if (statSync(path).isDirectory()) {
        for (const marker of readdirSync(path)) unlinkSync(join(path,marker));
        rmdirSync(path);
      } else unlinkSync(path);
    }
  });

  it('acquires, writes a heartbeat-bearing lock, and releases it', async () => {
    const { key, path } = newKey();

    const release = await acquireSharedDiscordTokenLock(key, 'test bot');
    const written = JSON.parse(readFileSync(join(path,readdirSync(path)[0]), 'utf8'));
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

  it('does not evict a live process on heartbeat expiry alone', async () => {
    const { key, path } = newKey();
    const longAgo = Date.now() - 10 * 60_000;
    // pid exists (this process stands in for the unrelated process that reused it), but the
    // heartbeat is ten minutes old, so no live bot is behind it.
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: longAgo, heartbeatAt: longAgo, label: 'dead bot' }));

    await expect(acquireSharedDiscordTokenLock(key, 'new bot')).rejects.toThrow('already running');
  });

  it('takes over a lock whose pid no longer exists', async () => {
    const { key, path } = newKey();
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_000, startedAt: Date.now(), heartbeatAt: Date.now(), label: 'crashed bot' }));

    const release = await acquireSharedDiscordTokenLock(key, 'new bot');
    await release();
  });

  it('allows exactly one concurrent starter to own an absent lock', async () => {
    for (let i=0;i<20;i++) {
      const {key} = newKey();
      const contenders = await Promise.allSettled(Array.from({length:8},()=>acquireSharedDiscordTokenLock(key,'concurrent fixture')));
      const holders = contenders.filter((result): result is PromiseFulfilledResult<()=>Promise<void>>=>result.status==='fulfilled');
      await Promise.all(holders.map(result=>result.value()));
      expect(holders).toHaveLength(1);
    }
  });

  it('an old release cannot delete a replacement owner', async () => {
    const {key,path} = newKey();
    const release = await acquireSharedDiscordTokenLock(key,'first');
    unlinkSync(join(path,readdirSync(path)[0])); rmdirSync(path);
    const replacement = await acquireSharedDiscordTokenLock(key,'replacement');
    await release();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(join(path,readdirSync(path)[0]),'utf8')).label).toBe('replacement');
    await replacement();
  });

  it('recovers a dead directory holder but fails closed during interrupted publication', async () => {
    const {key,path} = newKey();
    mkdirSync(path); writeFileSync(join(path,'owner-dead.json'),JSON.stringify({pid:2147483000,label:'dead',startedAt:0}));
    const release = await acquireSharedDiscordTokenLock(key,'new'); await release();
    mkdirSync(path);
    await expect(acquireSharedDiscordTokenLock(key,'new')).rejects.toThrow('inspect the empty lock');
  });
});
