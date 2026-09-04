import type { BotRunTrackerRxDatabase } from './init-database';

import { initSharedBotRunTrackerRxDatabase } from './init-database';

import { recordDiagnostic, recordRxDatabaseGrant, summarizeRecentRxDatabaseGrants } from '../core/diagnostics';



let sharedDatabase: BotRunTrackerRxDatabase | null = null;

let initPromise: Promise<BotRunTrackerRxDatabase> | null = null;



export async function getOrInitBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  recordRxDatabaseGrant(scopeId);

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

/**
 * Drops the in-memory database so the next use reopens it, keeping all stored data.
 *
 * Used after an out-of-band index repair: RxDB's query and document caches would otherwise
 * keep serving the pre-repair view. This is the cheap alternative to
 * destroySharedBotRunTrackerRxDatabase, which deletes every user's cached runs.
 */
export async function reopenSharedBotRunTrackerRxDatabase(trigger = 'unspecified'): Promise<void> {
  const { closeSharedBotRunTrackerRxDatabase } = await import('./init-database.js');
  recordDiagnostic('rxdb.reopen', {
    trigger,
    hadOpenDatabase: sharedDatabase !== null,
    hadInitInFlight: initPromise !== null,
    ...summarizeRecentRxDatabaseGrants(),
  });
  sharedDatabase = null;
  initPromise = null;
  await closeSharedBotRunTrackerRxDatabase();
}

export async function destroySharedBotRunTrackerRxDatabase(trigger = 'unspecified'): Promise<void> {
  const { resetSharedBotRunTrackerRxDatabase } = await import('./init-database.js');

  // Recorded before the caches are cleared: this wipe is process-wide, so the grant
  // summary is the evidence for how many other users' in-flight work it can break.
  recordDiagnostic('rxdb.destroy', {
    trigger,
    hadOpenDatabase: sharedDatabase !== null,
    hadInitInFlight: initPromise !== null,
    ...summarizeRecentRxDatabaseGrants(),
  });

  sharedDatabase = null;
  initPromise = null;
  await resetSharedBotRunTrackerRxDatabase();

  // The window between clearing the caches above and the wipe completing is where a
  // concurrent getOrInit can build a database that this reset then deletes.
  recordDiagnostic('rxdb.destroy', {
    trigger,
    phase: 'completed',
    ...summarizeRecentRxDatabaseGrants(),
  });
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


