/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RxStorage } from 'rxdb';

export type BotRxStorageMode = 'localstorage' | 'dexie' | 'memory';

const DEFAULT_BOT_RXDB_DATA_DIR = join('.data', 'rxdb-bot-localstorage');

function resolveBotRxStorageMode(): BotRxStorageMode {
  const fromEnv = String(process.env.TRACKER_BOT_RXDB_STORAGE || process.env.TRACKER_RUN_RXDB_NODE_ENGINE || '')
    .trim()
    .toLowerCase();

  if (fromEnv === 'dexie' || fromEnv === 'fake' || fromEnv === 'sqlite') {
    return 'dexie';
  }
  if (fromEnv === 'memory') {
    return 'memory';
  }
  return 'localstorage';
}

function resolveBotRxStorageDirectory(): string {
  const fromEnv = process.env.TRACKER_BOT_RXDB_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(process.cwd(), DEFAULT_BOT_RXDB_DATA_DIR);
}

function ensureFileBackedLocalStorage(): void {
  const nodeGlobal = globalThis as typeof globalThis & {
    localStorage?: Storage;
  };

  if (nodeGlobal.localStorage) {
    return;
  }

  const storageDirectory = resolveBotRxStorageDirectory();
  mkdirSync(storageDirectory, { recursive: true });

  // node-localstorage persists key/value pairs as files on disk.
  const { LocalStorage } = require('node-localstorage') as {
    LocalStorage: new (location: string, quota: number) => Storage;
  };
  // Unlimited quota — node-localstorage defaults to 5 MB which is far too small
  // for large run histories. The only real limit is available disk space.
  const ls = new LocalStorage(storageDirectory, Infinity);

  // node-localstorage throws ENOENT for missing keys instead of returning null like real
  // browser localStorage does. RxDB's bulkUpsert reads before writing, so this crashes on
  // any key that hasn't been written yet.
  const originalGetItem = ls.getItem.bind(ls);
  (ls as Storage).getItem = (key: string): string | null => {
    try {
      return originalGetItem(key);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'ENOENT') return null;
      throw err;
    }
  };

  nodeGlobal.localStorage = ls;
}

function ensureDexieNodePolyfill(): void {
  const { ensureTrackerRunNodeRxDBStorage } = require('@tmrxjd/platform/node') as {
    ensureTrackerRunNodeRxDBStorage: (options: { dbFileName: string }) => void;
  };
  ensureTrackerRunNodeRxDBStorage({ dbFileName: 'tracker-bot-run-rxdb.sqlite' });
}

let storageEnvironmentReady = false;
let cachedStorage: RxStorage<any, any> | null = null;

export function ensureBotRxStorageEnvironment(): BotRxStorageMode {
  if (storageEnvironmentReady) {
    return resolveBotRxStorageMode();
  }

  const mode = resolveBotRxStorageMode();
  if (mode === 'localstorage') {
    ensureFileBackedLocalStorage();
  } else if (mode === 'dexie') {
    ensureDexieNodePolyfill();
  }

  storageEnvironmentReady = true;
  return mode;
}

export async function getBotRxStorage(): Promise<RxStorage<any, any>> {
  if (cachedStorage) {
    return cachedStorage;
  }

  const mode = ensureBotRxStorageEnvironment();

  if (mode === 'memory') {
    const { getRxStorageMemory } = await import('rxdb/plugins/storage-memory');
    cachedStorage = getRxStorageMemory();
    return cachedStorage;
  }

  if (mode === 'dexie') {
    const { getRxStorageDexie } = await import('rxdb/plugins/storage-dexie');
    cachedStorage = getRxStorageDexie();
    return cachedStorage;
  }

  const { getRxStorageLocalstorage } = await import('rxdb/plugins/storage-localstorage');
  const nodeGlobal = globalThis as typeof globalThis & { localStorage?: Storage };
  cachedStorage = getRxStorageLocalstorage({
    localStorage: nodeGlobal.localStorage,
  });
  return cachedStorage;
}

export function getBotRxStorageDirectory(): string | null {
  return resolveBotRxStorageMode() === 'localstorage'
    ? resolveBotRxStorageDirectory()
    : null;
}
