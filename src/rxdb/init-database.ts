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

/**
 * The live instance, tracked so a reset can close it.
 *
 * Dropping the reference is not enough. RxDB refuses to create a second database with the
 * same name while the first is still open (DB8), and each storage instance stays
 * subscribed to the localstorage plugin's module-global change stream — where its handler
 * re-parses every subsequent write. An unclosed database therefore both locks out its own
 * replacement and taxes every write that follows.
 */
let sharedDatabase: BotRunTrackerRxDatabase | null = null;

function asRxJsonSchema(schema: TrackerRunPartRxJsonSchema): RxJsonSchema<TrackerRunPartDocument> {
  return schema as RxJsonSchema<TrackerRunPartDocument>;
}

/** Close without letting a teardown failure mask the error that prompted it. */
async function closeQuietly(db: BotRunTrackerRxDatabase | null): Promise<void> {
  if (!db) return;
  await db.close().catch(() => {});
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

      try {
        if (!db.run_part_1) {
          await db.addCollections({
            run_part_1: { schema: asRxJsonSchema(botRunPart1RxJsonSchema) },
            run_part_2: { schema: asRxJsonSchema(botRunPart2RxJsonSchema) },
          });
        }
      } catch (error) {
        // The database opened but is unusable. Leaving it open would make the retry below
        // — and every later open — fail with DB8.
        await closeQuietly(db);
        throw error;
      }

      sharedDatabase = db;
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

  // Close before removing. removeRxDatabase deletes the stored data but leaves a live
  // instance open, and that instance is what makes the next open fail with DB8.
  const previous = sharedDatabase;
  sharedDatabase = null;
  await closeQuietly(previous);

  ensureBotRxStorageEnvironment();
  const storage = await getBotRxStorage();
  await removeRxDatabase(SHARED_BOT_RUN_RXDB_NAME, storage).catch(() => {});
}

/** @deprecated Use initSharedBotRunTrackerRxDatabase. Per-user DBs hit RxDB COL23 limits. */
export async function initBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  void scopeId;
  return initSharedBotRunTrackerRxDatabase();
}
