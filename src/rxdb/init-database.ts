import type { RxCollection, RxDatabase, RxJsonSchema } from 'rxdb';
import { createRxDatabase, removeRxDatabase } from 'rxdb/plugins/core';
import {
  type TrackerRunPartDocument,
  type TrackerRunPartRxJsonSchema,
} from '@tmrxjd/platform/tools';
import { botRunPart1RxJsonSchema, botRunPart2RxJsonSchema } from './bot-run-schemas';
import { logger } from '../core/logger';
import {
  botRxStorageNeedsQuarantine,
  ensureBotRxStorageEnvironment,
  getBotRxStorage,
  quarantineBotRxStorage,
} from './bot-rx-storage';

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

    async function createAndCollect(): Promise<BotRunTrackerRxDatabase> {
      // Fetched per attempt: discarding the store replaces the storage instance.
      const db = await createRxDatabase({
        name: SHARED_BOT_RUN_RXDB_NAME,
        storage: await getBotRxStorage(),
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

      await discardStoredSharedDatabase('schema mismatch (DB6)');
      return await createAndCollect();
    }
  })().catch((error) => {
    sharedInitPromise = null;
    throw error;
  });

  return sharedInitPromise;
}

/**
 * Drops the persisted shared database. With the localstorage engine that is a directory
 * quarantine (instant); removeRxDatabase deletes one file per document synchronously and
 * froze the whole bot for hours on a full-size cache. Other engines delete in memory.
 */
async function discardStoredSharedDatabase(reason: string): Promise<void> {
  if (botRxStorageNeedsQuarantine()) {
    const quarantined = await quarantineBotRxStorage(reason);
    logger.warn('[rxdb] discarded local run cache', { reason, quarantined });
    return;
  }

  await removeRxDatabase(SHARED_BOT_RUN_RXDB_NAME, await getBotRxStorage()).catch(() => {});
}

export async function resetSharedBotRunTrackerRxDatabase(): Promise<void> {
  sharedInitPromise = null;
  ensureBotRxStorageEnvironment();
  await discardStoredSharedDatabase('reset requested');
}

/** @deprecated Use initSharedBotRunTrackerRxDatabase. Per-user DBs hit RxDB COL23 limits. */
export async function initBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  void scopeId;
  return initSharedBotRunTrackerRxDatabase();
}
