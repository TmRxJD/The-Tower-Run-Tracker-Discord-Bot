import type { BotRunTrackerRxDatabase } from './init-database';
import { initSharedBotRunTrackerRxDatabase } from './init-database';
import { recordDiagnostic, recordRxDatabaseGrant, summarizeRecentRxDatabaseGrants } from '../core/diagnostics';
import { logger } from '../core/logger';

let sharedDatabase: BotRunTrackerRxDatabase | null = null;
let initPromise: Promise<BotRunTrackerRxDatabase> | null = null;
let destroyPromise: Promise<void> | null = null;

export async function getOrInitBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  recordRxDatabaseGrant(scopeId);

  // A recovery in progress replaces the store underneath us; wait for it rather than
  // handing out a handle that is about to be retired.
  if (destroyPromise) {
    await destroyPromise;
  }

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
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
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
 * Throws the shared run cache away so it rebuilds from the cloud. Concurrent callers share
 * one recovery: several users tripping over the same corruption at once must not each
 * start their own wipe.
 */
export function destroySharedBotRunTrackerRxDatabase(trigger = 'unspecified'): Promise<void> {
  destroyPromise ??= runDestroy(trigger).finally(() => {
    destroyPromise = null;
  });
  return destroyPromise;
}

async function runDestroy(trigger: string): Promise<void> {
  const { resetSharedBotRunTrackerRxDatabase } = await import('./init-database.js');

  // Recorded before the caches are cleared: this wipe is process-wide, so the grant
  // summary is the evidence for how many other users' in-flight work it can break.
  recordDiagnostic('rxdb.destroy', {
    trigger,
    hadOpenDatabase: sharedDatabase !== null,
    hadInitInFlight: initPromise !== null,
    ...summarizeRecentRxDatabaseGrants(),
  });

  // Let an in-flight init settle so it cannot build a database the reset then deletes.
  await initPromise?.catch(() => null);

  const previous = sharedDatabase;
  sharedDatabase = null;
  initPromise = null;

  // Release the old handle before its backing store is swapped out.
  await previous?.close().catch((error: unknown) => {
    logger.warn('[rxdb] closing the previous database before reset failed', error);
  });

  await resetSharedBotRunTrackerRxDatabase();

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
