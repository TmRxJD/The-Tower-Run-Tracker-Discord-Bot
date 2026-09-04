import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests must not write into the working copy's .data store. The KV path is resolved from
// cwd, so without this every run that touches the KV leaves fixture users behind in the
// developer's real database.
const testKvDirectory = mkdtempSync(join(tmpdir(), 'tracker-bot-test-kv-'));

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'threads',
    maxWorkers: 1,
    env: {
      TRACKER_BOT_RXDB_STORAGE: 'memory',
      TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK: 'true',
      TRACKER_BOT_KV_DB_PATH: join(testKvDirectory, 'tracker-bot-idb.sqlite'),
    },
  },
});