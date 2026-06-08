import type { RxCollection, RxDatabase, RxJsonSchema } from 'rxdb';
import { createRxDatabase } from 'rxdb/plugins/core';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import {
  trackerRunPart1RxJsonSchema,
  trackerRunPart2RxJsonSchema,
  type TrackerRunPartDocument,
  type TrackerRunPartRxJsonSchema,
} from '@tmrxjd/platform/tools';
import { buildTrackerRunRxDatabaseName, ensureTrackerRunNodeRxDBStorage } from '@tmrxjd/platform/node';

const RXDB_SCOPE_PREFIX = 'tracker_bot_rxdb';

export type BotRunPartRxCollection = RxCollection<TrackerRunPartDocument>;
export type BotRunTrackerRxDatabase = RxDatabase<{
  run_part_1: BotRunPartRxCollection;
  run_part_2: BotRunPartRxCollection;
}>;

let nodeStorageReady = false;

function ensureBotRunTrackerNodeStorage(): void {
  if (nodeStorageReady) return;
  ensureTrackerRunNodeRxDBStorage({ dbFileName: 'tracker-bot-run-rxdb.sqlite' });
  nodeStorageReady = true;
}

function asRxJsonSchema(schema: TrackerRunPartRxJsonSchema): RxJsonSchema<TrackerRunPartDocument> {
  return schema as RxJsonSchema<TrackerRunPartDocument>;
}

export async function initBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  ensureBotRunTrackerNodeStorage();

  const db = await createRxDatabase({
    name: buildTrackerRunRxDatabaseName(RXDB_SCOPE_PREFIX, scopeId),
    storage: getRxStorageDexie(),
    ignoreDuplicate: true,
  }) as BotRunTrackerRxDatabase;

  await db.addCollections({
    run_part_1: {
      schema: asRxJsonSchema(trackerRunPart1RxJsonSchema),
    },
    run_part_2: {
      schema: asRxJsonSchema(trackerRunPart2RxJsonSchema),
    },
  });

  return db;
}
