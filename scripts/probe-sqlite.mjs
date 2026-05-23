import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', '.data', 'indexeddb', 'tracker-bot-idb.sqlite');
console.log('DB path:', dbPath);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.error('Failed to open DB:', err.message); process.exit(1); }
});

const query = (sql, params = []) => new Promise((resolve, reject) =>
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
);

try {
  const tables = await query("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('Tables:', tables.map(t => t.name).join(', '));

  // All keys (first 30)
  const keys = await query('SELECT key, updatedAt FROM kv ORDER BY updatedAt DESC LIMIT 30');
  console.log('KV keys (latest 30):');
  for (const k of keys) console.log(' ', k.key, '@', new Date(k.updatedAt).toISOString());

  // Main local store
  const store = await query("SELECT value FROM kv WHERE key = 'tracker-local-store:v1'");
  if (store.length) {
    const parsed = JSON.parse(store[0].value);
    const userIds = Object.keys(parsed.users ?? {});
    console.log('\nLocal store users:', userIds);
    const uid = '371914184822095873';
    const userBucket = parsed.users?.[uid];
    if (userBucket) {
      const runs = userBucket.runs ?? [];
      console.log('Runs for', uid, ':', runs.length);
      const target = runs.find(r => r.runId === '6a107f63000053f12bed');
      console.log('Target run (6a107f63000053f12bed):', JSON.stringify(target ?? 'NOT FOUND', null, 2));
      const near7870 = runs.filter(r => Number(r.wave) >= 7860 && Number(r.wave) <= 7880);
      console.log('Runs near wave 7870:', JSON.stringify(near7870.map(r => ({ runId: r.runId, wave: r.wave, date: r.date })), null, 2));
    } else {
      console.log('\nNo bucket for', uid, '— users in store:', userIds);
    }
  } else {
    console.log('\nNo tracker-local-store:v1 entry');
  }

  // Cloud sync queue (inside tracker-local-store:v1 .queue field)
  const localStoreRow = await query("SELECT value FROM kv WHERE key = 'tracker-local-store:v1'");
  if (localStoreRow.length) {
    const parsed = JSON.parse(localStoreRow[0].value);
    const queue = parsed.queue ?? [];
    const forUser = queue.filter(i => i.userId === '371914184822095873');
    console.log('\nCloud sync queue (tracker-local-store:v1 .queue):');
    console.log('  Total queue items:', queue.length);
    console.log('  Items for 371914184822095873:', forUser.length);
    console.log('  Queue detail:', JSON.stringify(forUser.map(i => ({
      op: i.op,
      runId: i.runId,
      localId: i.localId,
      wave: i.runData?.wave ?? i.wave,
      retryCount: i.retryCount,
      lastError: i.lastError,
    })), null, 2));
    const targetInQueue = forUser.find(i => i.runId === '6a107f63000053f12bed');
    console.log('  Target run in sync queue?', targetInQueue ? JSON.stringify(targetInQueue) : 'NOT IN QUEUE');
  }

  // Pending-run-store (pre-confirmation OCR buffer)
  const queue = await query("SELECT value, updatedAt FROM kv WHERE key = 'tracker-pending-runs:v1'");
  console.log('\ntracker-pending-runs:v1 row count:', queue.length);
  if (queue.length) {
    console.log('  updatedAt:', queue[0].updatedAt);
    const raw = queue[0].value;
    console.log('  raw length:', raw.length, 'chars');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    console.log('  item count:', items.length);
    const byUser = {};
    for (const item of items) {
      const uid = item.userId ?? 'unknown';
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(item);
    }
    for (const [uid, userItems] of Object.entries(byUser)) {
      const ages = userItems.map(i => Math.round((Date.now() - (i.createdAt ?? 0)) / 60000));
      const waves = userItems.map(i => i.runData?.wave ?? i.canonicalRunData?.wave ?? '?');
      const hasScreenshot = userItems.filter(i => i.screenshot).length;
      const runSources = [...new Set(userItems.map(i => i.runSource ?? 'unknown'))];
      console.log(`  userId=${uid}: ${userItems.length} items`);
      console.log(`    ages (min): ${Math.min(...ages)}, max: ${Math.max(...ages)}`);
      console.log(`    waves: ${waves.slice(0, 10).join(', ')}${waves.length > 10 ? ' ...' : ''}`);
      console.log(`    hasScreenshot: ${hasScreenshot}/${userItems.length}`);
      console.log(`    runSources: ${runSources.join(', ')}`);
    }
  } else {
    console.log('  No tracker-pending-runs:v1 row in database');
  }
} catch (e) {
  console.error('Error:', e.message);
}

db.close();
