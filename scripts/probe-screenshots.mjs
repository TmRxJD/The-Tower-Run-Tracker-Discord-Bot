import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', '.data', 'indexeddb', 'tracker-bot-idb.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.error('Failed to open DB:', err.message); process.exit(1); }
});

const query = (sql) => new Promise((res, rej) => db.all(sql, [], (e, r) => e ? rej(e) : res(r)));

const [row] = await query("SELECT value FROM kv WHERE key = 'tracker-local-store:v1'");
const parsed = JSON.parse(row.value);
const runs = parsed.users?.['371914184822095873']?.runs ?? [];

const withScreenshot = runs.filter(r => r.screenshotUrl);
const withoutScreenshot = runs.filter(r => !r.screenshotUrl && r.runId);

console.log(`Runs total: ${runs.length}`);
console.log(`Runs with screenshotUrl: ${withScreenshot.length}`);
console.log(`Runs with runId but no screenshotUrl: ${withoutScreenshot.length}`);

const discordUrls = withScreenshot.filter(r => {
  const u = r.screenshotUrl ?? '';
  return u.includes('discord') || u.includes('cdn.') || u.includes('media.');
});
const appwriteUrls = withScreenshot.filter(r => {
  const u = r.screenshotUrl ?? '';
  return u.includes('/storage/buckets/') || u.includes('appwrite');
});
const otherUrls = withScreenshot.filter(r => !discordUrls.includes(r) && !appwriteUrls.includes(r));

console.log(`\nScreenshot URL breakdown:`);
console.log(`  Appwrite storage: ${appwriteUrls.length}`);
console.log(`  Discord CDN:      ${discordUrls.length}`);
console.log(`  Other:            ${otherUrls.length}`);

console.log(`\nSample Appwrite screenshot URLs (last 5):`);
for (const r of appwriteUrls.slice(-5)) {
  console.log(`  wave=${r.wave} runId=${String(r.runId ?? '').slice(0, 12)} url=${String(r.screenshotUrl ?? '').slice(0, 120)}`);
}

if (discordUrls.length) {
  console.log(`\nSample Discord CDN URLs (should be 0):`);
  for (const r of discordUrls.slice(0, 3)) {
    console.log(`  wave=${r.wave} runId=${String(r.runId ?? '').slice(0, 12)} url=${String(r.screenshotUrl ?? '').slice(0, 120)}`);
  }
}

if (otherUrls.length) {
  console.log(`\nOther URL samples:`);
  for (const r of otherUrls.slice(0, 3)) {
    console.log(`  wave=${r.wave} url=${String(r.screenshotUrl ?? '').slice(0, 120)}`);
  }
}

db.close();
