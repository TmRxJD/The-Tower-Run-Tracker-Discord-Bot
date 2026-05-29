import { beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forceSyncQueuedRuns } from './tracker-api-client';
import { getQueueItems, markQueueItemFailed, queueCloudDelete, queueCloudUpsert, removeQueueItem } from './local-run-store';

const TEST_USER_ID = 'tracker_sync_cleanup_user';

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  const existing = await getQueueItems(TEST_USER_ID);
  for (const item of existing) {
    await removeQueueItem(item.id);
  }
});

describe('tracker-api-client queue sync', () => {
  it('drops max-retry queue items and cleans queued screenshot temp files', async () => {
    const screenshotPath = join(tmpdir(), `trackerbot-queued-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    await fs.writeFile(screenshotPath, Buffer.from([1, 2, 3, 4]));

    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'local-run-id' },
      localId: 'local-run-id',
      screenshot: {
        filename: 'queued.png',
        contentType: 'image/png',
        tempPath: screenshotPath,
      },
    });

    let queued = await getQueueItems(TEST_USER_ID);
    expect(queued).toHaveLength(1);

    for (let index = 0; index < 8; index += 1) {
      await markQueueItemFailed(queued[0].id, 'forced failure');
    }

    expect((await getQueueItems(TEST_USER_ID))[0]?.retryCount).toBe(8);
    expect(await fileExists(screenshotPath)).toBe(true);

    await forceSyncQueuedRuns(TEST_USER_ID);

    const afterSync = await getQueueItems(TEST_USER_ID);
    expect(afterSync).toHaveLength(0);
    expect(await fileExists(screenshotPath)).toBe(false);
  });

  it('drops queued upserts shadowed by a queued delete before replaying', async () => {
    const screenshotPath = join(tmpdir(), `trackerbot-shadowed-upsert-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    await fs.writeFile(screenshotPath, Buffer.from([1, 2, 3, 4]));

    await queueCloudUpsert({
      userId: TEST_USER_ID,
      username: 'tester',
      runData: { localId: 'local-shadowed-id', runId: 'shadowed-run-id' },
      localId: 'local-shadowed-id',
      screenshot: {
        filename: 'shadowed.png',
        contentType: 'image/png',
        tempPath: screenshotPath,
      },
    });

    await queueCloudDelete({
      userId: TEST_USER_ID,
      username: 'tester',
      runId: 'shadowed-run-id',
    });

    const deleteItem = (await getQueueItems(TEST_USER_ID)).find(item => item.op === 'delete');
    expect(deleteItem).toBeTruthy();

    for (let index = 0; index < 8; index += 1) {
      await markQueueItemFailed(deleteItem!.id, 'forced delete exhaustion');
    }

    await forceSyncQueuedRuns(TEST_USER_ID);

    expect(await getQueueItems(TEST_USER_ID)).toHaveLength(0);
    expect(await fileExists(screenshotPath)).toBe(false);
  });
});
