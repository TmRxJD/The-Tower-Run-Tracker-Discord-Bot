/**
 * Probe: Count actual Appwrite run documents per userId variant and identify
 * the source of the 2-run discrepancy between site (948) and bot (950).
 */
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually
function loadEnv() {
  const envPaths = [
    join(__dirname, '..', '.env.dev'),
    join(__dirname, '..', '.env.prod'),
    join(__dirname, '..', '.env'),
  ];
  const env = {};
  for (const p of envPaths) {
    try {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        env[key] = val;
      }
      console.log(`Loaded env from: ${p}`);
      break;
    } catch {}
  }
  return env;
}

const env = loadEnv();
const ENDPOINT = env.APPWRITE_ENDPOINT;
const PROJECT_ID = env.APPWRITE_PROJECT_ID;
const API_KEY = env.APPWRITE_API_KEY;
const DB_ID = env.APPWRITE_RUNS_DATABASE_ID ?? 'run-tracker-data';
const COLL_ID = env.APPWRITE_RUNS_COLLECTION_ID ?? 'runs';

if (!ENDPOINT || !PROJECT_ID || !API_KEY) {
  console.error('Missing required env vars (APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY)');
  process.exit(1);
}

const { Client, Databases, Query } = await import('node-appwrite');
const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);

const DISCORD_ID = '371914184822095873';
const APPWRITE_ID = '681ab667ce6096096b3b';

async function countDocsForUserId(userId) {
  let total = 0;
  let cursor = null;
  let page = 0;
  while (true) {
    const queries = [
      Query.equal('userId', userId),
      Query.select(['$id', 'userId']),
      Query.limit(5000),
    ];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    const result = await databases.listDocuments(DB_ID, COLL_ID, queries);
    total += result.documents.length;
    page++;
    console.log(`  page ${page}: ${result.documents.length} docs (running total: ${total})`);

    if (result.documents.length < 5000) break;
    cursor = result.documents[result.documents.length - 1].$id;
  }
  return total;
}

console.log(`\nCounting Appwrite docs for Discord ID (${DISCORD_ID}):`);
const discordCount = await countDocsForUserId(DISCORD_ID);

console.log(`\nCounting Appwrite docs for Appwrite account ID (${APPWRITE_ID}):`);
const appwriteCount = await countDocsForUserId(APPWRITE_ID);

console.log('\n=== Summary ===');
console.log(`Docs under Discord ID  (${DISCORD_ID}): ${discordCount}`);
console.log(`Docs under Appwrite ID (${APPWRITE_ID}): ${appwriteCount}`);
console.log(`Combined total: ${discordCount + appwriteCount}`);
console.log(`Bot local count: 950`);
console.log(`Site shows: 948`);
console.log();
if (discordCount > 0 && appwriteCount === 948) {
  console.log('LIKELY CAUSE: Site only queries Appwrite account ID and misses the legacy Discord-snowflake docs.');
  console.log(`Those ${discordCount} legacy runs need to be migrated/re-attributed to the Appwrite account ID.`);
} else {
  console.log('Other discrepancy — review counts above.');
}
