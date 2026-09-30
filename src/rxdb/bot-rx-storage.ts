/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { mkdirSync, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
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
  if (fromEnv === 'localstorage') {
    return 'localstorage';
  }
  // The cache mirrors Appwrite, so it is rebuilt after a restart. The localstorage engine
  // blocks the event loop for seconds per bulk write (7.2s for 1,359 runs, versus 134ms in
  // memory) and is opt-in for that reason. Cloud-sync-off users are backed up separately.
  return 'memory';
}

function resolveBotRxStorageDirectory(): string {
  const fromEnv = process.env.TRACKER_BOT_RXDB_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(process.cwd(), DEFAULT_BOT_RXDB_DATA_DIR);
}

// node-localstorage is synchronous fs, one file per key. Deleting a large store key by key
// (what removeRxDatabase does) blocks the event loop for hours, so a store is never wiped
// in-process: it is renamed aside in one step and purged by a detached process instead.
const QUARANTINE_MARKER = '.quarantine-';
const QUARANTINE_MIN_INTERVAL_MS = 10 * 60 * 1000;
let lastQuarantineAt = 0;

let activeLocalStorage: Storage | null = null;

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
  activeLocalStorage = ls;

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

/** Whether wiping the bot RxDB has to go through {@link quarantineBotRxStorage}. */
export function botRxStorageNeedsQuarantine(): boolean {
  return resolveBotRxStorageMode() === 'localstorage';
}

function retireLocalStorage(ls: Storage | null): void {
  if (!ls) return;
  const retired = () => {
    throw new Error('Bot RxDB storage was retired; the handle is no longer valid.');
  };
  // Anything still holding the old handle must fail loudly instead of writing into the
  // replacement store with a stale in-memory key list.
  ls.setItem = retired;
  ls.removeItem = retired;
  ls.clear = retired;
}

/**
 * Discards the on-disk RxDB cache without blocking the event loop.
 *
 * The directory is renamed aside (one atomic step), a fresh empty store is opened in its
 * place, and the old directory is deleted by a detached process. Callers must drop their
 * own RxDB handles first. Returns the quarantine path, or null when the active storage
 * engine has no directory to move (memory/dexie — use removeRxDatabase there).
 */
export async function quarantineBotRxStorage(reason: string): Promise<string | null> {
  if (resolveBotRxStorageMode() !== 'localstorage') {
    return null;
  }

  // A store that keeps corrupting must not turn into a rename/repopulate loop.
  const now = Date.now();
  if (lastQuarantineAt > 0 && now - lastQuarantineAt < QUARANTINE_MIN_INTERVAL_MS) {
    throw new Error(`Bot RxDB storage was quarantined ${Math.round((now - lastQuarantineAt) / 1000)}s ago; refusing to do it again (${reason}).`);
  }

  const directory = resolveBotRxStorageDirectory();
  const target = `${directory}${QUARANTINE_MARKER}${now}`;

  retireLocalStorage(activeLocalStorage);
  await rename(directory, target);
  lastQuarantineAt = now;

  activeLocalStorage = null;
  cachedStorage = null;
  storageEnvironmentReady = false;
  delete (globalThis as { localStorage?: Storage }).localStorage;
  // node-localstorage memoises instances by path, so re-opening the same directory would
  // hand back the retired instance with its stale key list. Dropping the module gives the
  // replacement store a clean instance map.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${sep}node-localstorage${sep}`)) {
      delete require.cache[key];
    }
  }
  ensureBotRxStorageEnvironment();

  purgeQuarantinedBotRxStorage();
  return target;
}

/**
 * Deletes every quarantined store next to the live one. Runs in a detached node process so
 * removing ~150k files neither blocks this process nor occupies the libuv threadpool that
 * DNS lookups for Discord and Appwrite depend on. Safe to call repeatedly: removal is
 * idempotent and a directory that is already gone is ignored.
 */
export function purgeQuarantinedBotRxStorage(): void {
  if (resolveBotRxStorageMode() !== 'localstorage') {
    return;
  }

  const directory = resolveBotRxStorageDirectory();
  const parent = dirname(directory);
  const prefix = `${basename(directory)}${QUARANTINE_MARKER}`;

  let stale: string[];
  try {
    stale = readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(parent, name));
  } catch {
    return;
  }

  if (stale.length === 0) {
    return;
  }

  // Deleted in paced batches: the bot reads this same volume synchronously, and an
  // unthrottled delete of ~150k files made its reads slow enough to stall the event loop
  // for seconds at a time.
  const script = [
    'const fs=require("fs"),path=require("path");',
    'const sleep=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);',
    'for(const d of process.argv.slice(1)){try{',
    'const names=fs.readdirSync(d);',
    'for(let i=0;i<names.length;i++){try{fs.rmSync(path.join(d,names[i]),{recursive:true,force:true})}catch{}if(i%100===99)sleep(50)}',
    'fs.rmSync(d,{recursive:true,force:true,maxRetries:5,retryDelay:250})',
    '}catch{}}',
  ].join('');
  try {
    const child = spawn(process.execPath, ['-e', script, ...stale], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_LOW);
      } catch {
        // Lowering priority is best effort.
      }
    }
    child.unref();
  } catch {
    // Purging is housekeeping; the directories are picked up again on the next start.
  }
}
