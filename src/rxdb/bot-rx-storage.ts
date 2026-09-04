/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import { mkdirSync, unlinkSync } from 'node:fs';
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

  // node-localstorage's removeItem is O(n) in the number of stored keys: it walks the whole
  // _metaKeyMap to decrement every index above the one being removed, and splices _keys.
  // Deleting a whole collection is therefore O(n^2) and fully synchronous — measured at
  // 4.1s for 6000 document files, past the ~3s Discord allows for an interaction ACK, so a
  // schema-mismatch wipe on startup would fail every command running at the time.
  //
  // That bookkeeping exists only to support key(n) and length. RxDB's localstorage engine
  // uses getItem, setItem and removeItem and nothing else, so dropping it is safe here and
  // makes the delete linear: 723ms for the same 6000 files.
  //
  // The trade is that _keys is no longer pruned, so it keeps entries for deleted keys.
  // Nothing reads it, and removals only happen during a wipe, so the growth is bounded by
  // how often that occurs.
  const originalRemoveItem = ls.removeItem.bind(ls);
  const removeWithoutIndexFixup = (key: string): void => {
    // node-localstorage rewrites only the empty-string key before lookup; every other key
    // is used verbatim. RxDB never stores one, but defer to the original if it ever does.
    if (key === '') {
      originalRemoveItem(key);
      return;
    }
    const metaKeyMap = (ls as unknown as { _metaKeyMap: Record<string, { key: string; size: number }> })._metaKeyMap;
    const meta = metaKeyMap[key];
    if (!meta) return;
    delete metaKeyMap[key];
    const bookkeeping = ls as unknown as { length: number; _bytesInUse: number };
    bookkeeping.length -= 1;
    bookkeeping._bytesInUse -= meta.size;
    try {
      unlinkSync(join(storageDirectory, meta.key));
    } catch {
      // Already gone — the wipe is idempotent by design.
    }
  };
  (ls as Storage).removeItem = removeWithoutIndexFixup;

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
