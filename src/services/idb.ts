import { logger } from '../core/logger';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';

interface KvRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

type KvBackend = 'sqlite' | 'memory';

export interface TrackerKvStorageStatus {
  backend: KvBackend;
  persistent: boolean;
  dbPath: string;
}

let database: sqlite3.Database | null = null;
let dbReady: Promise<sqlite3.Database> | null = null;
let storageUnavailable = false;
const inMemoryKv = new Map<string, KvRecord>();
const trackerKvDbPath = join(process.cwd(), '.data', 'indexeddb', 'tracker-bot-idb.sqlite');
const allowMemoryFallback = String(process.env.TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK || '').toLowerCase() === 'true';

function formatStorageError(error: unknown): string {
  if (error instanceof Error) {
    const [firstLine] = error.message.split('\n');
    return firstLine || error.name;
  }
  return 'Unknown storage error';
}

function runSql(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getSqlRow<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

async function getTrackerBotDb(): Promise<sqlite3.Database | null> {
  if (storageUnavailable) {
    if (!allowMemoryFallback) {
      throw new Error(`Persistent Tracker KV storage unavailable (dbPath=${trackerKvDbPath}).`);
    }
    return null;
  }

  if (database) {
    return database;
  }

  if (dbReady) {
    try {
      database = await dbReady;
      return database;
    } catch {
      return null;
    }
  }

  dbReady = (async () => {
    try {
      const dataDir = join(process.cwd(), '.data', 'indexeddb');
      mkdirSync(dataDir, { recursive: true });

      const db = await new Promise<sqlite3.Database>((resolve, reject) => {
        const handle = new sqlite3.Database(trackerKvDbPath, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(handle);
        });
      });

      await runSql(
        db,
        'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL)'
      );
      return db;
    } catch (error) {
      storageUnavailable = true;
      const detail = formatStorageError(error);
      if (allowMemoryFallback) {
        logger.warn(`SQLite KV backend unavailable; using in-memory fallback store (${detail})`);
      } else {
        logger.error(`SQLite KV backend unavailable and memory fallback is disabled (${detail})`);
      }
      throw error;
    }
  })();

  try {
    database = await dbReady;
    return database;
  } catch {
    return null;
  }
}

export async function getTrackerKv<T>(key: string): Promise<T | null> {
  const db = await getTrackerBotDb();
  if (!db) {
    if (!allowMemoryFallback) {
      throw new Error(`Persistent Tracker KV read unavailable (key=${key}, dbPath=${trackerKvDbPath}).`);
    }
    const row = inMemoryKv.get(key);
    return (row?.value as T) ?? null;
  }

  try {
    const row = await getSqlRow<{ value: string }>(db, 'SELECT value FROM kv WHERE key = ?', [key]);
    if (!row) {
      return null;
    }
    return JSON.parse(row.value) as T;
  } catch (error) {
    storageUnavailable = true;
    const detail = formatStorageError(error);
    if (!allowMemoryFallback) {
      logger.error(`SQLite KV read failed and memory fallback is disabled (${detail})`);
      throw error;
    }
    logger.warn(`SQLite KV read failed; switching to in-memory fallback store (${detail})`);
    const row = inMemoryKv.get(key);
    return (row?.value as T) ?? null;
  }
}

export async function setTrackerKv(key: string, value: unknown): Promise<void> {
  const db = await getTrackerBotDb();
  const record: KvRecord = {
    key,
    value,
    updatedAt: Date.now(),
  };

  if (!db) {
    if (!allowMemoryFallback) {
      throw new Error(`Persistent Tracker KV write unavailable (key=${key}, dbPath=${trackerKvDbPath}).`);
    }
    inMemoryKv.set(key, record);
    return;
  }

  try {
    await runSql(
      db,
      'INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
      [record.key, JSON.stringify(record.value), record.updatedAt]
    );
  } catch (error) {
    storageUnavailable = true;
    const detail = formatStorageError(error);
    if (!allowMemoryFallback) {
      logger.error(`SQLite KV write failed and memory fallback is disabled (${detail})`);
      throw error;
    }
    logger.warn(`SQLite KV write failed; switching to in-memory fallback store (${detail})`);
    inMemoryKv.set(key, record);
  }
}

export async function getTrackerKvStorageStatus(): Promise<TrackerKvStorageStatus> {
  const db = await getTrackerBotDb();
  return {
    backend: db ? 'sqlite' : 'memory',
    persistent: Boolean(db),
    dbPath: trackerKvDbPath,
  };
}

export async function assertTrackerKvPersistentStorage(): Promise<void> {
  const status = await getTrackerKvStorageStatus();
  if (!status.persistent) {
    throw new Error(`Tracker KV is not persistent (backend=${status.backend}, dbPath=${status.dbPath})`);
  }

  const probeKey = '__tracker_kv_persistence_probe__';
  const probeValue = { at: Date.now(), nonce: Math.random().toString(36).slice(2) };
  await setTrackerKv(probeKey, probeValue);
  const roundTrip = await getTrackerKv<typeof probeValue>(probeKey);
  if (!roundTrip || roundTrip.nonce !== probeValue.nonce) {
    throw new Error(`Tracker KV probe round-trip failed (dbPath=${status.dbPath})`);
  }
}
