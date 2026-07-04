/**
 * Wipe local run data for one Discord user (RxDB docs + legacy KV + sync cursors).
 * Keeps settings and Discord↔Appwrite identity mapping.
 *
 * Usage: node scripts/wipe-user-run-store.mjs <discordUserId>
 * Restart the bot after running so RxDB reloads from disk.
 */
import { createRequire } from 'module';
import { readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const botRoot = join(__dirname, '..');
const rxdbDir = join(botRoot, '.data', 'rxdb-bot-localstorage');
const dbPath = join(botRoot, '.data', 'indexeddb', 'tracker-bot-idb.sqlite');

const userId = process.argv[2]?.trim();
if (!userId) {
  console.error('Usage: node scripts/wipe-user-run-store.mjs <discordUserId>');
  process.exit(1);
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function getSqlRow(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function wipeRxdbDocs() {
  // Partial per-user doc deletes leave RxDB localstorage indexes inconsistent.
  // Wipe the entire shared RxDB cache; cloud sync restores it on next /track.
  let deleted = 0;
  for (const name of readdirSync(rxdbDir)) {
    unlinkSync(join(rxdbDir, name));
    deleted += 1;
  }
  return { scanned: deleted, deleted };
}

async function wipeSqliteKv(db) {
  const keysToDelete = [
    `tracker:last-cloud-delta-check:${userId}`,
    `tracker-rxdb-legacy-seeded:${userId}`,
    `tracker:permanent-deleted-run-ids:v1:${userId}`,
    `tracker:run-docs-hydrated:v1:${userId}`,
  ];

  let deletedKeys = 0;
  for (const key of keysToDelete) {
    const result = await runSql(db, 'DELETE FROM kv WHERE key = ?', [key]);
    deletedKeys += result.changes ?? 0;
  }

  const storeRow = await getSqlRow(db, 'SELECT value FROM kv WHERE key = ?', ['tracker-local-store:v1']);
  let legacyRunsCleared = 0;
  let queueItemsRemoved = 0;
  if (storeRow?.value) {
    const store = JSON.parse(storeRow.value);
    const bucket = store.users?.[userId];
    if (bucket) {
      legacyRunsCleared = Array.isArray(bucket.runs) ? bucket.runs.length : 0;
      bucket.runs = [];
      if (bucket.lifetime && typeof bucket.lifetime === 'object') {
        bucket.lifetime.entries = [];
        bucket.lifetime.updatedAt = 0;
      }
    }
    if (Array.isArray(store.queue)) {
      const before = store.queue.length;
      store.queue = store.queue.filter((item) => item?.userId !== userId);
      queueItemsRemoved = before - store.queue.length;
    }
    await runSql(
      db,
      'INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
      ['tracker-local-store:v1', JSON.stringify(store), Date.now()],
    );
  }

  return { deletedKeys, legacyRunsCleared, queueItemsRemoved };
}

const db = await openDb();
try {
  const rxdb = await wipeRxdbDocs();
  const kv = await wipeSqliteKv(db);
  console.log(JSON.stringify({
    userId,
    rxdbDocsDeleted: rxdb.deleted,
    rxdbDocsScanned: rxdb.scanned,
    kvKeysDeleted: kv.deletedKeys,
    legacyKvRunsCleared: kv.legacyRunsCleared,
    queueItemsRemoved: kv.queueItemsRemoved,
    kept: [
      `tracker:discord-appwrite-id:v1:${userId}`,
      'cloudSyncEnabled settings',
    ],
    nextStep: 'Restart the Discord bot, then run /track to trigger bulk cloud import.',
  }, null, 2));
} finally {
  await closeDb(db);
}
