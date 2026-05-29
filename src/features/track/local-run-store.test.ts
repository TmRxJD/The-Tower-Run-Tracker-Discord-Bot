import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getQueueItems,
  markQueueItemFailed,
  queueCloudDelete,
  queueCloudSettings,
  queueCloudUpsert,
  releaseQueuedItemsForImmediateRetry,
  removeQueueItem,
} from './local-run-store';

const TEST_USER_ID = 'tracker-test-user';

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

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

  it('suppresses duplicate queued deletes for the same run', async () => {
    await queueCloudDelete({
      userId: TEST_USER_ID,
      username: 'tester',
      runId: 'run-delete-1',
    });

    await queueCloudDelete({
      userId: TEST_USER_ID,
      username: 'tester',
      runId: 'run-delete-1',
    });

    const queued = await getQueueItems(TEST_USER_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.op).toBe('delete');
    expect(queued[0]?.runId).toBe('run-delete-1');
  });

  it('replaces duplicate queued upserts for the same run identity', async () => {
    const staleScreenshotPath = join(tmpdir(), `trackerbot-stale-upsert-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const freshScreenshotPath = join(tmpdir(), `trackerbot-fresh-upsert-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    await fs.writeFile(staleScreenshotPath, Buffer.from([1, 2, 3]));
    await fs.writeFile(freshScreenshotPath, Buffer.from([4, 5, 6]));

    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'dedupe-local-id', runId: 'dedupe-run-id', wave: '100' },
      localId: 'dedupe-local-id',
      screenshot: {
        filename: 'stale.png',
        contentType: 'image/png',
        tempPath: staleScreenshotPath,
      },
    });

    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester-new',
      runData: { localId: 'dedupe-local-id', runId: 'dedupe-run-id', wave: '101' },
      localId: 'dedupe-local-id',
      screenshot: {
        filename: 'fresh.png',
        contentType: 'image/png',
        tempPath: freshScreenshotPath,
      },
    });

    const queued = await getQueueItems(TEST_USER_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.op).toBe('upsert');
    expect(queued[0]?.username).toBe('tester-new');
    expect(queued[0]?.runId).toBe('dedupe-run-id');
    expect(queued[0]?.localId).toBe('dedupe-local-id');
    expect(queued[0]?.runData?.wave).toBe('101');
    expect(queued[0]?.screenshot?.tempPath).toBe(freshScreenshotPath);
    expect(await fileExists(staleScreenshotPath)).toBe(false);
    expect(await fileExists(freshScreenshotPath)).toBe(true);
  });

  it('supersedes a queued delete when the same run is re-queued as an upsert', async () => {
    await queueCloudDelete({
      userId: TEST_USER_ID,
      username: 'tester',
      runId: 'resurrected-run-id',
    });

    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'resurrected-local-id', runId: 'resurrected-run-id', wave: '150' },
      localId: 'resurrected-local-id',
    });

    const queued = await getQueueItems(TEST_USER_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.op).toBe('upsert');
    expect(queued[0]?.runId).toBe('resurrected-run-id');
  });

  it('replaces queued settings updates for the same user', async () => {
    await queueCloudSettings({
      userId: TEST_USER_ID,
      settingsUpdatedAt: 100,
      settingsData: {
        defaultTracker: 'Web',
        cloudSyncEnabled: true,
      },
    });

    await queueCloudSettings({
      userId: TEST_USER_ID,
      settingsUpdatedAt: 200,
      settingsData: {
        defaultTracker: 'Bluestacks',
        cloudSyncEnabled: true,
      },
    });

    const queued = await getQueueItems(TEST_USER_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.op).toBe('settings');
    expect(queued[0]?.settingsUpdatedAt).toBe(200);
    expect(queued[0]?.settingsData?.defaultTracker).toBe('Bluestacks');
  });
});
