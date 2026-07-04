import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'threads',
    maxWorkers: 1,
    env: {
      TRACKER_BOT_RXDB_STORAGE: 'memory',
      TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK: 'true',
    },
  },
});