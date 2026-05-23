/**
 * Probe: Find the 2 Appwrite run docs that the site can't see.
 * Queries all docs for the Discord snowflake userId and checks whether each
 * doc's $permissions includes the Appwrite account ID (so site session can read it).
 */
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  for (const p of [join(__dirname, '..', '.env.dev'), join(__dirname, '..', '.env.prod')]) {
    try {
      const env = {};
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
      return env;
    } catch {}
  }
  return {};
}

const env = loadEnv();
const { Client, Databases, Query } = await import('node-appwrite');
const client = new Client().setEndpoint(env.APPWRITE_ENDPOINT).setProject(env.APPWRITE_PROJECT_ID).setKey(env.APPWRITE_API_KEY);
const databases = new Databases(client);

const DB_ID = env.APPWRITE_RUNS_DATABASE_ID ?? 'run-tracker-data';
const COLL_ID = env.APPWRITE_RUNS_COLLECTION_ID ?? 'runs';
const DISCORD_ID = '371914184822095873';
const APPWRITE_ID = '681ab667ce6096096b3b';
const EXPECTED_PERMISSION = `user:${APPWRITE_ID}`;

// Fetch all docs under the Discord snowflake userId
async function fetchAllDocs(userId) {
  const all = [];
  let cursor = null;
  while (true) {
    const queries = [
      Query.equal('userId', userId),
      Query.limit(5000),
    ];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const result = await databases.listDocuments(DB_ID, COLL_ID, queries);
    all.push(...result.documents);
    if (result.documents.length < 5000) break;
    cursor = result.documents[result.documents.length - 1].$id;
  }
  return all;
}

console.log('Fetching all docs under Discord ID...');
const discordDocs = await fetchAllDocs(DISCORD_ID);
console.log(`Total: ${discordDocs.length}`);

// Find docs that don't have a read permission for the Appwrite account ID
const missingPermission = discordDocs.filter(doc => {
  const perms = doc.$permissions ?? [];
  return !perms.some(p => p.includes(APPWRITE_ID) && p.startsWith('read'));
});

console.log(`\nDocs missing read permission for Appwrite account (${APPWRITE_ID}): ${missingPermission.length}`);
for (const doc of missingPermission) {
  console.log(`  $id=${doc.$id} wave=${doc.wave ?? '?'} tier=${doc.tier ?? '?'} date=${doc.$createdAt?.slice(0,10)}`);
  console.log(`    permissions: ${JSON.stringify(doc.$permissions)}`);
}

if (missingPermission.length === 0) {
  console.log('\nAll Discord-ID docs have the Appwrite account read permission.');
  console.log('The 2-run discrepancy may be a site display/pagination issue, not a permission issue.');
}
