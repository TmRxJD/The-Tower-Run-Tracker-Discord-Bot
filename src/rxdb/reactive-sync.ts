import { stitchTrackerRunCollections } from '@tmrxjd/platform/tools';
import { logger } from '../core/logger';
import { getActiveBotRunTrackerRxDatabase, getOrInitBotRunTrackerRxDatabase } from './database-manager';
import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

export type BotRunInboundChangeHandler = (input: {
  userId: string;
  runs: Record<string, unknown>[];
}) => void;

const inboundHandlers = new Set<BotRunInboundChangeHandler>();
const subscriptionsByUser = new Map<string, { unsubscribe: () => void }>();

function stitchRunDocuments(
  part1Docs: TrackerRunPartDocument[],
  part2Docs: TrackerRunPartDocument[],
): Record<string, unknown>[] {
  const extendedById = new Map<string, TrackerRunPartDocument>();
  for (const document of part2Docs) {
    if (document?.id) {
      extendedById.set(document.id, document);
    }
  }

  return part1Docs
    .map((part1) => stitchTrackerRunCollections(part1, part1.id ? extendedById.get(part1.id) : null))
    .filter((run): run is Record<string, unknown> => run !== null);
}

async function notifyInboundRunsChanged(userId: string): Promise<void> {
  const db = getActiveBotRunTrackerRxDatabase(userId);
  if (!db) {
    return;
  }

  const [part1Docs, part2Docs] = await Promise.all([
    db.run_part_1.find().exec(),
    db.run_part_2.find().exec(),
  ]);
  const runs = stitchRunDocuments(part1Docs, part2Docs);

  for (const handler of inboundHandlers) {
    handler({ userId, runs });
  }
}

export function registerBotRunInboundChangeHandler(handler: BotRunInboundChangeHandler | null): void {
  if (!handler) {
    return;
  }
  inboundHandlers.add(handler);
}

export async function bindBotRunTrackerRxDBInboundSync(userId: string): Promise<void> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return;
  }

  subscriptionsByUser.get(normalizedUserId)?.unsubscribe();

  const db = await getOrInitBotRunTrackerRxDatabase(normalizedUserId);
  const subscription = db.run_part_1.find().$.subscribe(() => {
    void notifyInboundRunsChanged(normalizedUserId).catch((error) => {
      logger.warn('[rxdb] inbound run notification failed', { userId: normalizedUserId, error });
    });
  });

  subscriptionsByUser.set(normalizedUserId, subscription);
}

export function unbindBotRunTrackerRxDBInboundSync(userId: string): void {
  const normalizedUserId = userId.trim();
  subscriptionsByUser.get(normalizedUserId)?.unsubscribe();
  subscriptionsByUser.delete(normalizedUserId);
}
