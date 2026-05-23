import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', '.data', 'indexeddb', 'tracker-bot-idb.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
const query = (sql) => new Promise((res, rej) => db.all(sql, [], (e, r) => e ? rej(e) : res(r)));

const [row] = await query("SELECT value FROM kv WHERE key = 'tracker-local-store:v1'");
const parsed = JSON.parse(row.value);
const runs = parsed.users?.['371914184822095873']?.runs ?? [];

const withRunId = runs.filter(r => r.runId);
const withoutRunId = runs.filter(r => !r.runId);

console.log(`Total runs: ${runs.length}`);
console.log(`With runId (synced to cloud): ${withRunId.length}`);
console.log(`Without runId (local only): ${withoutRunId.length}`);

if (withoutRunId.length) {
  console.log('\nLocal-only runs (no runId):');
  for (const r of withoutRunId) {
    console.log(`  localId=${r.localId ?? 'none'} wave=${r.wave} tier=${r.tier} date=${r.date ?? r.runDate} source=${r.source ?? 'unknown'}`);
  }
}

// Also check for duplicate runIds
const runIds = withRunId.map(r => r.runId);
const uniqueRunIds = new Set(runIds);
const dupeCount = runIds.length - uniqueRunIds.size;
if (dupeCount > 0) {
  console.log(`\nDuplicate runIds: ${dupeCount}`);
  const seen = new Set();
  const dupes = [];
  for (const r of withRunId) {
    if (seen.has(r.runId)) dupes.push(r);
    seen.add(r.runId);
  }
  for (const r of dupes.slice(0, 10)) {
    console.log(`  dupe runId=${r.runId} wave=${r.wave} date=${r.date ?? r.runDate}`);
  }
}

db.close();
