import { describe, expect, it } from 'vitest';
import {
  initSharedBotRunTrackerRxDatabase,
  resetSharedBotRunTrackerRxDatabase,
} from './init-database';

describe('shared bot run RxDB lifecycle', () => {
  /**
   * The corrupt-cache handler wipes and reopens the shared database while the process
   * keeps running. Dropping the reference without closing left the old instance open, and
   * RxDB then refused the reopen with DB8 — so one bad read poisoned every user's tracker
   * commands until the bot was restarted, and retrying the command appeared to "sometimes"
   * work because a failed open freed the name for the next attempt.
   */
  it('reopens cleanly after repeated wipes', async () => {
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const db = await initSharedBotRunTrackerRxDatabase();
      expect(db.run_part_1, `collections missing on cycle ${cycle}`).toBeTruthy();

      await db.run_part_1.bulkUpsert([
        { id: `cycle-${cycle}`, updatedAt: Date.now(), botScopeUserId: 'user-1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      await resetSharedBotRunTrackerRxDatabase();
    }

    const reopened = await initSharedBotRunTrackerRxDatabase();
    expect(reopened.run_part_1).toBeTruthy();
    await resetSharedBotRunTrackerRxDatabase();
  });
});
