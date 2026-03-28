import { logger } from '../core/logger';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { type AnalyticsEventDocument, type GuildDocument, type UserSettingsDocument, userSettingsDocumentSchema } from '../persistence/types';

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
const allowMemoryFallback = String(process.env.TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK || '').toLowerCase() === 'true';
const trackerKvDbPath = join(process.cwd(), '.data', 'indexeddb', 'tracker-bot-idb.sqlite');

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

function allSqlRows<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve((rows as T[]) ?? []);
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
      await runSql(
        db,
        'CREATE TABLE IF NOT EXISTS tracker_guilds (guildId TEXT PRIMARY KEY, firstSeen TEXT NOT NULL, guildPrefs TEXT)'
      );
      await runSql(
        db,
        'CREATE TABLE IF NOT EXISTS tracker_users (userId TEXT PRIMARY KEY, username TEXT, defaultTracker TEXT, defaultRunType TEXT, scanLanguage TEXT, decimalPreference TEXT, shareSettings TEXT, lastSeen TEXT, updatedAt TEXT NOT NULL)'
      );
      await runSql(
        db,
        'CREATE TABLE IF NOT EXISTS tracker_analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, userId TEXT, guildId TEXT, commandName TEXT, runId TEXT, meta TEXT)'
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

type GuildRow = {
  guildId: string;
  firstSeen: string;
  guildPrefs: string | null;
};

type UserRow = {
  userId: string;
  username: string | null;
  defaultTracker: string | null;
  defaultRunType: string | null;
  scanLanguage: string | null;
  decimalPreference: string | null;
  shareSettings: string | null;
  lastSeen: string | null;
  updatedAt: string;
};

type AnalyticsRow = {
  ts: string;
  event: string;
  userId: string | null;
  guildId: string | null;
  commandName: string | null;
  runId: string | null;
  meta: string | null;
};

function normalizeGuildRow(row: GuildRow): GuildDocument {
  return {
    guildId: row.guildId,
    firstSeen: row.firstSeen,
    guildPrefs: row.guildPrefs ?? undefined,
  };
}

function normalizeUserRow(row: UserRow): UserSettingsDocument {
  return userSettingsDocumentSchema.parse({
    userId: row.userId,
    username: row.username ?? undefined,
    defaultTracker: row.defaultTracker ?? undefined,
    defaultRunType: row.defaultRunType ?? undefined,
    scanLanguage: row.scanLanguage ?? undefined,
    decimalPreference: row.decimalPreference ?? undefined,
    shareSettings: row.shareSettings ?? undefined,
    lastSeen: row.lastSeen ?? undefined,
    updatedAt: row.updatedAt,
  });
}

function normalizeAnalyticsRow(row: AnalyticsRow): AnalyticsEventDocument {
  return {
    ts: row.ts,
    event: row.event,
    userId: row.userId ?? undefined,
    guildId: row.guildId ?? undefined,
    commandName: row.commandName ?? undefined,
    runId: row.runId ?? undefined,
    meta: row.meta ?? undefined,
  };
}

export async function getTrackerGuild(guildId: string): Promise<GuildDocument | null> {
  const db = await getTrackerBotDb();
  if (!db) {
    return null;
  }

  const row = await getSqlRow<GuildRow>(db, 'SELECT guildId, firstSeen, guildPrefs FROM tracker_guilds WHERE guildId = ?', [guildId]);
  return row ? normalizeGuildRow(row) : null;
}

export async function upsertTrackerGuild(document: GuildDocument): Promise<void> {
  const db = await getTrackerBotDb();
  if (!db) {
    throw new Error(`Tracker guild persistence unavailable (dbPath=${trackerKvDbPath}).`);
  }

  const firstSeen = document.firstSeen ?? new Date().toISOString();
  await runSql(
    db,
    'INSERT INTO tracker_guilds (guildId, firstSeen, guildPrefs) VALUES (?, ?, ?) ON CONFLICT(guildId) DO UPDATE SET firstSeen = excluded.firstSeen, guildPrefs = excluded.guildPrefs',
    [document.guildId, firstSeen, document.guildPrefs ?? null],
  );
}

export async function deleteTrackerGuild(guildId: string): Promise<void> {
  const db = await getTrackerBotDb();
  if (!db) {
    throw new Error(`Tracker guild persistence unavailable (dbPath=${trackerKvDbPath}).`);
  }

  await runSql(db, 'DELETE FROM tracker_guilds WHERE guildId = ?', [guildId]);
}

export async function getTrackerUserSettings(userId: string): Promise<UserSettingsDocument | null> {
  const db = await getTrackerBotDb();
  if (!db) {
    return null;
  }

  const row = await getSqlRow<UserRow>(
    db,
    'SELECT userId, username, defaultTracker, defaultRunType, scanLanguage, decimalPreference, shareSettings, lastSeen, updatedAt FROM tracker_users WHERE userId = ?',
    [userId],
  );
  return row ? normalizeUserRow(row) : null;
}

export async function upsertTrackerUserSettings(document: UserSettingsDocument): Promise<void> {
  const db = await getTrackerBotDb();
  if (!db) {
    throw new Error(`Tracker user persistence unavailable (dbPath=${trackerKvDbPath}).`);
  }

  const parsedDocument = userSettingsDocumentSchema.parse({
    ...document,
    updatedAt: document.updatedAt ?? new Date().toISOString(),
  });
  const updatedAt = parsedDocument.updatedAt ?? new Date().toISOString();
  await runSql(
    db,
    'INSERT INTO tracker_users (userId, username, defaultTracker, defaultRunType, scanLanguage, decimalPreference, shareSettings, lastSeen, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(userId) DO UPDATE SET username = excluded.username, defaultTracker = excluded.defaultTracker, defaultRunType = excluded.defaultRunType, scanLanguage = excluded.scanLanguage, decimalPreference = excluded.decimalPreference, shareSettings = excluded.shareSettings, lastSeen = excluded.lastSeen, updatedAt = excluded.updatedAt',
    [
      parsedDocument.userId,
      parsedDocument.username ?? null,
      parsedDocument.defaultTracker ?? null,
      parsedDocument.defaultRunType ?? null,
      parsedDocument.scanLanguage ?? null,
      parsedDocument.decimalPreference ?? null,
      parsedDocument.shareSettings ?? null,
      parsedDocument.lastSeen ?? null,
      updatedAt,
    ],
  );
}

export async function appendTrackerAnalyticsEvent(event: AnalyticsEventDocument): Promise<void> {
  const db = await getTrackerBotDb();
  if (!db) {
    throw new Error(`Tracker analytics persistence unavailable (dbPath=${trackerKvDbPath}).`);
  }

  await runSql(
    db,
    'INSERT INTO tracker_analytics (ts, event, userId, guildId, commandName, runId, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      event.ts,
      event.event,
      event.userId ?? null,
      event.guildId ?? null,
      event.commandName ?? null,
      event.runId ?? null,
      event.meta ?? null,
    ],
  );
}

export async function listTrackerAnalyticsBetween(startIso: string, endIso: string): Promise<AnalyticsEventDocument[]> {
  const db = await getTrackerBotDb();
  if (!db) {
    return [];
  }

  const rows = await allSqlRows<AnalyticsRow>(
    db,
    'SELECT ts, event, userId, guildId, commandName, runId, meta FROM tracker_analytics WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1000',
    [startIso, endIso],
  );
  return rows.map(normalizeAnalyticsRow);
}
