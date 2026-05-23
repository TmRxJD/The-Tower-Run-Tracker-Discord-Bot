/**
 * Probe script: check if a specific run document exists in Appwrite,
 * and list all run documents for a user to understand the reconcile mismatch.
 *
 * Usage: DEPLOYMENT_MODE=dev node scripts/probe-run-appwrite.mjs
 */
import { Client, Databases, Query } from 'node-appwrite';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

// Load env the same way the bot does
const mode = process.env.DEPLOYMENT_MODE ?? 'dev';
for (const f of [`.env.${mode}`, `.env.${mode}.local`, '.env', '.env.local']) {
  const p = resolve(root, f);
  if (existsSync(p)) { dotenvConfig({ path: p, override: true }); console.log(`Loaded env from: ${p}`); break; }
}

const ENDPOINT        = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID      = process.env.APPWRITE_PROJECT_ID;
const API_KEY         = process.env.APPWRITE_API_KEY;
const RUNS_DB         = process.env.APPWRITE_RUNS_DATABASE_ID ?? 'run-tracker-data';
const RUNS_COL        = process.env.APPWRITE_RUNS_COLLECTION_ID ?? 'runs';

if (!ENDPOINT || !PROJECT_ID || !API_KEY) {
  console.error('Missing required env vars. Check APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY');
  process.exit(1);
}

const TARGET_RUN_ID  = '6a107f63000053f12bed';
const DISCORD_USER_ID = '371914184822095873';

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const db = new Databases(client);

console.log('\n=== STEP 1: Direct fetch of target document ===');
try {
  const doc = await db.getDocument(RUNS_DB, RUNS_COL, TARGET_RUN_ID);
  console.log('DOCUMENT EXISTS in Appwrite:');
  console.log(`  $id:      ${doc.$id}`);
  console.log(`  userId:   ${doc.userId}`);
  console.log(`  wave:     ${doc.wave}`);
  console.log(`  $createdAt: ${doc.$createdAt}`);
  console.log(`  $updatedAt: ${doc.$updatedAt}`);
  console.log(`  $permissions: ${JSON.stringify(doc.$permissions ?? [])}`);
} catch (err) {
  const code = err?.code ?? err?.response?.code;
  if (code === 404) {
    console.log(`DOCUMENT NOT FOUND (404) — run "${TARGET_RUN_ID}" was hard-deleted from Appwrite`);
  } else {
    console.log(`Error fetching document:`, err?.message ?? err);
  }
}

console.log('\n=== STEP 2: Query runs with userId == discord_snowflake ===');
try {
  const page = await db.listDocuments(RUNS_DB, RUNS_COL, [
    Query.equal('userId', DISCORD_USER_ID),
    Query.select(['$id', 'userId', 'wave', '$createdAt']),
    Query.orderDesc('$createdAt'),
    Query.limit(10),
  ]);
  console.log(`Found ${page.total} total docs with userId="${DISCORD_USER_ID}"`);
  for (const d of page.documents) {
    console.log(`  $id=${d.$id}  wave=${d.wave}  createdAt=${d.$createdAt}`);
  }
} catch (err) {
  console.log('Error querying by discord userId:', err?.message ?? err);
}

console.log('\n=== STEP 3: Look up Appwrite account linked to discord user ===');
// The bot uses resolveAppwriteIdForDiscordUser — we can replicate by checking
// the identities collection or the users API for the linked OAuth identity.
// This requires admin API access, which the API key may provide.
import { Users } from 'node-appwrite';
const users = new Users(client);
try {
  // Search for users who have a Discord identity linked with the provider userId == DISCORD_USER_ID
  const accountList = await users.list([Query.search('name', 'tmrxjd')]);
  console.log(`Found ${accountList.total} accounts matching "tmrxjd":`);
  for (const u of accountList.users) {
    console.log(`  accountId=${u.$id}  name=${u.name}  email=${u.email}`);
  }
} catch (err) {
  console.log('Could not search users (may need admin scope):', err?.message ?? err);
}

console.log('\n=== STEP 4: Query via resolveAppwriteIdForDiscordUser logic ===');
// The platform resolves discord->appwrite via listIdentities on the Users API
// If we have the Appwrite account ID, query runs by that ID
try {
  const identities = await users.listIdentities([Query.equal('providerUid', DISCORD_USER_ID)]);
  console.log(`Found ${identities.total} identities with providerUid="${DISCORD_USER_ID}":`);
  for (const id of identities.identities) {
    console.log(`  identityId=${id.$id}  userId=${id.userId}  provider=${id.provider}  providerUid=${id.providerUid}`);
    // Now query runs with this appwrite userId
    const runsPage = await db.listDocuments(RUNS_DB, RUNS_COL, [
      Query.equal('userId', id.userId),
      Query.select(['$id', 'userId', 'wave', '$createdAt']),
      Query.orderDesc('$createdAt'),
      Query.limit(10),
    ]);
    console.log(`  Runs with userId="${id.userId}": ${runsPage.total} total`);
    for (const d of runsPage.documents) {
      console.log(`    $id=${d.$id}  wave=${d.wave}  createdAt=${d.$createdAt}`);
    }
  }
} catch (err) {
  console.log('Could not list identities:', err?.message ?? err);
}
