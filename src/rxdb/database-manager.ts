import type { BotRunTrackerRxDatabase } from './init-database';
import { initBotRunTrackerRxDatabase } from './init-database';

const databaseByScope = new Map<string, BotRunTrackerRxDatabase>();
const initPromiseByScope = new Map<string, Promise<BotRunTrackerRxDatabase>>();

export async function getOrInitBotRunTrackerRxDatabase(scopeId: string): Promise<BotRunTrackerRxDatabase> {
  const normalizedScope = scopeId.trim();
  if (!normalizedScope) {
    throw new Error('Bot run tracker RxDB scope id is required.');
  }

  const cached = databaseByScope.get(normalizedScope);
  if (cached) {
    return cached;
  }

  const inFlight = initPromiseByScope.get(normalizedScope);
  if (inFlight) {
    return inFlight;
  }

  const initPromise = initBotRunTrackerRxDatabase(normalizedScope).then((db) => {
    databaseByScope.set(normalizedScope, db);
    initPromiseByScope.delete(normalizedScope);
    return db;
  }).catch((error) => {
    initPromiseByScope.delete(normalizedScope);
    throw error;
  });

  initPromiseByScope.set(normalizedScope, initPromise);
  return initPromise;
}

export function getActiveBotRunTrackerRxDatabase(scopeId: string): BotRunTrackerRxDatabase | null {
  return databaseByScope.get(scopeId.trim()) ?? null;
}
