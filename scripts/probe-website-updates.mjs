import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import sqlite3 from 'sqlite3';

// Read-only: never initialize storage, advance a checkpoint, or send Discord messages.
const rows = await new Promise((resolveRows, reject) => {
  const db = new sqlite3.Database(resolve('.data/indexeddb/tracker-bot-idb.sqlite'), sqlite3.OPEN_READONLY, error => {
    if (error) { reject(error); return; }
    db.all('SELECT key,value FROM kv WHERE key IN (?,?)', ['website-updates-mirror:v1', 'website-updates-status:v1'], (queryError, result) => {
      db.close();
      if (queryError) reject(queryError); else resolveRows(result);
    });
  });
});
const values = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]));
const state = values['website-updates-mirror:v1'];
const status = values['website-updates-status:v1'];
const entries = Object.values(state?.entries ?? {});
const rawPm2 = execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const service = JSON.parse(rawPm2.slice(rawPm2.search(/^\[\s*(\{|\])/m))).find(entry => entry.name === 'trackerbot');
const gateway = JSON.parse(readFileSync('.data/gateway-readiness.json', 'utf8'));
const output = {
  process: { pid: service?.pid, status: service?.pm2_env.status, restarts: service?.pm2_env.restart_time, uptime: service?.pm2_env.pm_uptime },
  gateway,
  status,
  checkpoint: state ? {
    source: state.source, channel: state.channel, baselineAt: state.baselineAt,
    entries: entries.length, baselineEntries: entries.filter(entry => entry.baseline).length,
    mirroredEntries: entries.filter(entry => !entry.baseline).length,
    messages: entries.flatMap(entry => entry.parts).filter(part => part.messageId).length,
    pending: entries.flatMap(entry => entry.parts).filter(part => part.pending).length,
  } : null,
  currentProcessReady: gateway.pid === service?.pid && gateway.discord.ready
    && Date.now() - Date.parse(gateway.utc) < 90_000 && Date.parse(gateway.utc) >= service?.pm2_env.pm_uptime,
  currentProcessPoll: status?.pid === service?.pid && status?.ok === true
    && Date.now() - status.checkedAt < 120_000 && status.checkedAt >= service?.pm2_env.pm_uptime,
};
if (process.argv.includes('--source')) {
  const require = createRequire(import.meta.url);
  const { fetchPublishedUpdates } = require('../dist/features/website-updates/source.js');
  const releases = await fetchPublishedUpdates();
  output.liveSource = { entries: releases.length, latestTitle: releases[0].title, latestDate: releases[0].date, latestHash: releases[0].hash,
    matchesLastPoll: status?.latestHash === releases[0].hash };
}
console.log(JSON.stringify(output, null, 2));
if (!output.currentProcessReady || !output.currentProcessPoll || !state) process.exitCode = 1;
