import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it, vi } from 'vitest';

it.each(['false', 'true'])('recovers durable storage after real contention without acknowledging memory fallback (%s)', async fallback => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-kv-contention-'));
  vi.stubEnv('TRACKER_BOT_DATA_DIR', root);
  vi.stubEnv('TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK', fallback);
  vi.resetModules();
  const kv = await import('./idb.js');
  await kv.setTrackerKv('seed', { durable: true }, { requirePersistent: true });
  const blocker = await new Promise<sqlite3.Database>((resolve, reject) => {
    const handle = new sqlite3.Database(join(root, 'indexeddb', 'tracker-bot-idb.sqlite'), error => error ? reject(error) : resolve(handle));
  });
  const exec = (sql: string) => new Promise<void>((resolve, reject) => blocker.exec(sql, error => error ? reject(error) : resolve()));
  try {
    await exec('BEGIN EXCLUSIVE');
    await expect(kv.setTrackerKv('blocked', { mustNotAcknowledge: true })).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    await expect(kv.getTrackerKv('seed')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    await exec('ROLLBACK');
    expect(await kv.getTrackerKv('seed')).toEqual({ durable: true });
    expect(await kv.getTrackerKv('blocked')).toBeNull();
    await kv.setTrackerKv('recovered', { durable: true }, { requirePersistent: true });
    expect(await kv.getTrackerKv('recovered')).toEqual({ durable: true });
    expect((await kv.getTrackerKvStorageStatus()).persistent).toBe(true);
  } finally {
    await exec('ROLLBACK').catch(() => {});
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    vi.unstubAllEnvs();
  }
}, 30_000);
