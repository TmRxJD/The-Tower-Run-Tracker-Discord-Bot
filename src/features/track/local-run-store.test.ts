import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getQueueItems,
  markQueueItemFailed,
  queueCloudUpsert,
  releaseQueuedItemsForImmediateRetry,
  removeQueueItem,
} from './local-run-store';

const TEST_USER_ID = 'tracker-test-user';

beforeAll(() => {
  const testDataDir = join(tmpdir(), `trackerbot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDataDir, { recursive: true });
  process.env.TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK = 'true';
  process.env.TRACKER_BOT_DATA_DIR = testDataDir;
});

beforeEach(async () => {
  const existing = await getQueueItems(TEST_USER_ID);
  for (const item of existing) {
    await removeQueueItem(item.id);
  }
});

describe('local-run-store queue retry behavior', () => {
  it('increments retry count and schedules next retry after failure', async () => {
    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'run-local-id', runId: 'run-id' },
      localId: 'run-local-id',
    });

    const queuedBefore = await getQueueItems(TEST_USER_ID);
    expect(queuedBefore).toHaveLength(1);

    const first = queuedBefore[0];
    const previousNextRetryAt = first.nextRetryAt ?? 0;

    await markQueueItemFailed(first.id, 'intentional test failure');

    const queuedAfter = await getQueueItems(TEST_USER_ID);
    expect(queuedAfter).toHaveLength(1);

    const updated = queuedAfter[0];
    expect(updated.retryCount).toBe(1);
    expect(updated.lastError).toBe('intentional test failure');
    expect((updated.nextRetryAt ?? 0) > previousNextRetryAt).toBe(true);
  });

  it('releases queued items for immediate retry', async () => {
    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'run-local-id-2', runId: 'run-id-2' },
      localId: 'run-local-id-2',
    });

    const [queuedItem] = await getQueueItems(TEST_USER_ID);
    await markQueueItemFailed(queuedItem.id, 'intentional retry delay');

    const delayed = (await getQueueItems(TEST_USER_ID))[0];
    expect((delayed.nextRetryAt ?? 0) > Date.now()).toBe(true);

    await releaseQueuedItemsForImmediateRetry(TEST_USER_ID);

    const released = (await getQueueItems(TEST_USER_ID))[0];
    expect((released.nextRetryAt ?? 0) <= Date.now()).toBe(true);
  });
});
