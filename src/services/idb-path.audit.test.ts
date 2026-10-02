import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('writes SQLite KV into the configured isolated data directory', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'tracker-kv-path-audit-'));
  vi.stubEnv('TRACKER_BOT_DATA_DIR', isolated);
  vi.resetModules();
  const kv = await import('./idb.js');
  await kv.setTrackerKv('fixture:path-isolation', { synthetic: true });
  expect(await kv.getTrackerKv('fixture:path-isolation')).toEqual({ synthetic: true });
  const expected = join(isolated, 'indexeddb', 'tracker-bot-idb.sqlite');
  expect((await kv.getTrackerKvStorageStatus()).dbPath).toBe(expected);
  expect(existsSync(expected)).toBe(true);
  vi.unstubAllEnvs();
});
