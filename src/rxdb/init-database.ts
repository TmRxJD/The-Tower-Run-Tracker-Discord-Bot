import type { RxCollection, RxDatabase, RxJsonSchema } from 'rxdb';
import { createRxDatabase, removeRxDatabase } from 'rxdb/plugins/core';
import {
  type TrackerRunPartDocument,
  type TrackerRunPartRxJsonSchema,
} from '@tmrxjd/platform/tools';
import { botRunPart1RxJsonSchema, botRunPart2RxJsonSchema } from './bot-run-schemas';
import { ensureBotRxStorageEnvironment, getBotRxStorage } from './bot-rx-storage';

const SHARED_BOT_RUN_RXDB_NAME = 'tracker_bot_rxdb_shared';

export type BotRunPartRxCollection = RxCollection<TrackerRunPartDocument>;

export type BotRunTrackerRxDatabase = RxDatabase<{
  run_part_1: BotRunPartRxCollection;
  run_part_2: BotRunPartRxCollection;
}>;

let sharedInitPromise: Promise<BotRunTrackerRxDatabase> | null = null;

function asRxJsonSchema(schema: TrackerRunPartRxJsonSchema): RxJsonSchema<TrackerRunPartDocument> {
  return schema as RxJsonSchema<TrackerRunPartDocument>;
}

export async function initSharedBotRunTrackerRxDatabase(): Promise<BotRunTrackerRxDatabase> {
  if (sharedInitPromise) {
    return sharedInitPromise;
  }

  sharedInitPromise = (async () => {
    ensureBotRxStorageEnvironment();
    const storage = await getBotRxStorage();

    async function createAndCollect(): Promise<BotRunTrackerRxDatabase> {
      const db = await createRxDatabase({
        name: SHARED_BOT_RUN_RXDB_NAME,
        storage,
        multiInstance: false,
      }) as BotRunTrackerRxDatabase;

      if (!db.run_part_1) {
        await db.addCollections({
          run_part_1: { schema: asRxJsonSchema(botRunPart1RxJsonSchema) },
          run_part_2: { schema: asRxJsonSchema(botRunPart2RxJsonSchema) },
        });
      }

      return db;
    }

    try {
      return await createAndCollect();
    } catch (error: unknown) {
      // DB6 = schema hash mismatch. RxDB is a local cache of Appwrite data, so
      // wiping and recreating is safe — the next sync pass repopulates from cloud.
      const isSchemaError = error instanceof Error && (error as { code?: string }).code === 'DB6';
      if (!isSchemaError) throw error;

      await removeRxDatabase(SHARED_BOT_RUN_RXDB_NAME, storage).catch(() => {});
      return await createAndCollect();
    }
  })().catch((error) => {
    sharedInitPromise = null;
    throw error;
  });

  return sharedInitPromise;
}

export async function resetSharedBotRunTrackerRxDatabase(): Promise<void> {
  sharedInitPromise = null;
  ensureBotRxStorageEnvironment();
  const storage = await getBotRxStorage();
  await removeRxDatabase(SHARED_BOT_RUN_RXDB_NAME, storage).catch(() => {});
}

/** @deprecated Use initSharedBotRunTrackerRxDatabase. Per-user DBs hit RxDB COL23 limits. */
export async function initBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  void scopeId;
  return initSharedBotRunTrackerRxDatabase();
}
