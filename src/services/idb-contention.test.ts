import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Keep native SQLite handles in a main-thread process, away from Vitest worker teardown.
it.each(['false', 'true'])('recovers durable storage after real contention without acknowledging memory fallback (%s)', async fallback => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-kv-contention-'));
  const script = `
    const assert = require('node:assert/strict');
    const sqlite = require('sqlite3');
    const path = require('node:path');
    const kv = require('./dist/services/idb');
    (async () => {
      await kv.setTrackerKv('seed', { durable: true }, { requirePersistent: true });
      const blocker = await new Promise((resolve, reject) => {
        const handle = new sqlite.Database(path.join(process.env.TRACKER_BOT_DATA_DIR, 'indexeddb', 'tracker-bot-idb.sqlite'), error => error ? reject(error) : resolve(handle));
      });
      const exec = sql => new Promise((resolve, reject) => blocker.exec(sql, error => error ? reject(error) : resolve()));
      try {
        await exec('BEGIN EXCLUSIVE');
        await assert.rejects(kv.setTrackerKv('blocked', { mustNotAcknowledge: true }), { code: 'SQLITE_BUSY' });
        await assert.rejects(kv.getTrackerKv('seed'), { code: 'SQLITE_BUSY' });
        await exec('ROLLBACK');
        assert.deepEqual(await kv.getTrackerKv('seed'), { durable: true });
        assert.equal(await kv.getTrackerKv('blocked'), null);
        await kv.setTrackerKv('recovered', { durable: true }, { requirePersistent: true });
        assert.deepEqual(await kv.getTrackerKv('recovered'), { durable: true });
        assert.equal((await kv.getTrackerKvStorageStatus()).persistent, true);
      } finally {
        await exec('ROLLBACK').catch(() => {});
        await new Promise(resolve => blocker.close(() => resolve()));
      }
      process.stdout.write('CONTENTION_OK');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TRACKER_BOT_DATA_DIR: root, TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK: fallback },
    timeout: 30_000,
  });
  expect(stdout).toContain('CONTENTION_OK');
}, 40_000);
