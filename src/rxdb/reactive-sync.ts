import { stitchTrackerRunCollections } from '@tmrxjd/platform/tools';

import { logger } from '../core/logger';

import { BOT_RUN_RXDB_SCOPE_USER_ID_FIELD } from './bot-run-schemas';

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
  const db = getActiveBotRunTrackerRxDatabase();
  if (!db) {
    return;
  }

  const selector = { [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: userId.trim() };
  const [part1Docs, part2Docs] = await Promise.all([
    db.run_part_1.find({ selector }).exec(),
    db.run_part_2.find({ selector }).exec(),
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
  const selector = { [BOT_RUN_RXDB_SCOPE_USER_ID_FIELD]: normalizedUserId };
  let part1CollectionReady = false;
  let part2CollectionReady = false;
  let notifyDebounceToken = 0;

  const scheduleInboundNotify = () => {
    if (!part1CollectionReady || !part2CollectionReady) {
      return;
    }

    const token = ++notifyDebounceToken;
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (token !== notifyDebounceToken) {
          return;
        }
        void notifyInboundRunsChanged(normalizedUserId).catch((error) => {
          logger.warn('[rxdb] inbound run notification failed', { userId: normalizedUserId, error });
        });
      });
    });
  };

  const part1Subscription = db.run_part_1.find({ selector }).$.subscribe(() => {
    part1CollectionReady = true;
    scheduleInboundNotify();
  });
  const part2Subscription = db.run_part_2.find({ selector }).$.subscribe(() => {
    part2CollectionReady = true;
    scheduleInboundNotify();
  });

  subscriptionsByUser.set(normalizedUserId, {
    unsubscribe: () => {
      part1Subscription.unsubscribe();
      part2Subscription.unsubscribe();
    },
  });
}

export function unbindBotRunTrackerRxDBInboundSync(userId: string): void {
  const normalizedUserId = userId.trim();
  subscriptionsByUser.get(normalizedUserId)?.unsubscribe();
  subscriptionsByUser.delete(normalizedUserId);
}
