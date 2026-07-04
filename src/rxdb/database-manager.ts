import type { BotRunTrackerRxDatabase } from './init-database';

import { initSharedBotRunTrackerRxDatabase } from './init-database';



let sharedDatabase: BotRunTrackerRxDatabase | null = null;

let initPromise: Promise<BotRunTrackerRxDatabase> | null = null;



export async function getOrInitBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  void scopeId;

  if (sharedDatabase) {

    return sharedDatabase;

  }



  if (initPromise) {

    return initPromise;

  }



  initPromise = initSharedBotRunTrackerRxDatabase()

    .then((db) => {

      sharedDatabase = db;

      return db;

    })

    .catch((error) => {

      initPromise = null;

      throw error;

    });



  const db = await initPromise;

  initPromise = null;

  return db;

}



export function getActiveBotRunTrackerRxDatabase(scopeId?: string): BotRunTrackerRxDatabase | null {
  void scopeId;

  return sharedDatabase;

}



export async function releaseBotRunTrackerRxDatabase(scopeId: string): Promise<void> {

  const { unbindBotRunTrackerRxDBInboundSync } = await import('./reactive-sync.js');

  unbindBotRunTrackerRxDBInboundSync(scopeId);

}

export async function destroySharedBotRunTrackerRxDatabase(): Promise<void> {
  const { resetSharedBotRunTrackerRxDatabase } = await import('./init-database.js');
  sharedDatabase = null;
  initPromise = null;
  await resetSharedBotRunTrackerRxDatabase();
}



export function getRunTrackerDatabaseManagerStats(): {

  openDatabases: number;

  openCollectionsEstimate: number;

  maxOpenDatabases: number;

} {

  return {

    openDatabases: sharedDatabase ? 1 : 0,

    openCollectionsEstimate: sharedDatabase ? 2 : 0,

    maxOpenDatabases: 1,

  };

}


