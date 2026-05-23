/**
 * Validates the Discord → Appwrite identity resolver and bidirectional run sync.
 *
 * Run: node --env-file=.env.dev scripts/diagnose-runs-sync.mjs
 *
 * Pass a different Discord snowflake as first CLI arg to test another user:
 *   node --env-file=.env.dev scripts/diagnose-runs-sync.mjs 302767497155837952
 */

import { Client, Databases, Users, Query } from 'node-appwrite';
import { trackerRunCloudDocumentSchema, buildTrackerRunIdentityKey } from '@tmrxjd/platform/tools';

const ENDPOINT = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY;
const RUNS_DB = process.env.APPWRITE_RUNS_DATABASE_ID ?? 'run-tracker-data';
const RUNS_COLLECTION = process.env.APPWRITE_RUNS_COLLECTION_ID ?? 'runs';

if (!ENDPOINT || !PROJECT_ID || !API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID or APPWRITE_API_KEY');
  process.exit(1);
}

const DISCORD_ID = process.argv[2] ?? '371914184822095873';

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const users = new Users(client);

const pass = (label) => console.log(`  + ${label}`);
const fail = (label) => console.log(`  - ${label}`);
const info = (label) => console.log(`  > ${label}`);

async function section(title, fn) {
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('-'.repeat(60));
  try {
    await fn();
  } catch (err) {
    console.error('  ERROR:', err.message ?? err);
  }
}

// 1. Resolve Discord -> Appwrite via listIdentities
let resolvedAppwriteId = null;

await section(`1. listIdentities: Discord ${DISCORD_ID} => Appwrite ID`, async () => {
  const result = await users.listIdentities([
    Query.equal('provider', 'discord'),
    Query.equal('providerUid', DISCORD_ID),
  ]);
  const identity = result.identities?.find(
    i => i.provider === 'discord' && i.providerUid === DISCORD_ID,
  );
  if (identity?.userId) {
    resolvedAppwriteId = identity.userId;
    pass(`Resolved => ${resolvedAppwriteId}`);
    info(`Identity: provider=${identity.provider}, providerEmail=${identity.providerEmail ?? '(none)'}`);
  } else {
    fail(`No Discord OAuth identity found for snowflake ${DISCORD_ID}`);
    info('User may have signed up with email/password instead of Discord OAuth.');
    info('Bot will fall back to querying runs by Discord snowflake only.');
  }
});

// 2. Runs under Discord snowflake (bot-uploaded)
await section(`2. Runs under Discord snowflake userId (bot-uploaded)`, async () => {
  const page = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
    Query.equal('userId', DISCORD_ID),
    Query.orderDesc('$updatedAt'),
    Query.limit(5),
  ]);
  if (page.total > 0) {
    pass(`Found ${page.total} runs with userId = Discord snowflake`);
    for (const doc of page.documents) {
      info(`  wave=${doc.wave}, $updatedAt=${doc.$updatedAt}`);
    }
  } else {
    fail(`No runs found with userId = Discord snowflake ${DISCORD_ID}`);
  }
});

// 3. Runs under Appwrite account ID (site-uploaded)
await section(`3. Runs under Appwrite account ID (site-uploaded)`, async () => {
  if (!resolvedAppwriteId) {
    info('Skipped - no Appwrite ID resolved in step 1');
    return;
  }
  const page = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
    Query.equal('userId', resolvedAppwriteId),
    Query.orderDesc('$updatedAt'),
    Query.limit(5),
  ]);
  if (page.total > 0) {
    pass(`Found ${page.total} runs with userId = Appwrite account ID ${resolvedAppwriteId}`);
    for (const doc of page.documents) {
      info(`  wave=${doc.wave}, username=${doc.username}, $updatedAt=${doc.$updatedAt}`);
    }
  } else {
    info(`No runs found with userId = ${resolvedAppwriteId} (user may only have used the site recently)`);
  }
});

// 4. Bidirectional coverage: lookupUserIds = [snowflake, appwriteId]
await section(`4. Bidirectional coverage: combined lookup`, async () => {
  const lookupUserIds = [DISCORD_ID, resolvedAppwriteId].filter(Boolean);
  info(`lookupUserIds = ${JSON.stringify(lookupUserIds)}`);

  let totalFound = 0;
  for (const candidateId of lookupUserIds) {
    const page = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
      Query.equal('userId', candidateId),
      Query.orderDesc('$updatedAt'),
      Query.limit(3),
    ]);
    info(`  userId=${candidateId}: ${page.total} total runs (showing up to 3)`);
    for (const doc of page.documents) {
      info(`    wave=${doc.wave}, username=${doc.username ?? '-'}, $updatedAt=${doc.$updatedAt}`);
    }
    totalFound += page.total;
  }

  if (totalFound > 0) {
    pass(`Combined lookup returns ${totalFound} runs across all sources`);
  } else {
    fail('No runs found for any lookupUserId');
  }
});

// 5. Delta sync simulation: runs since 10 minutes ago
await section(`5. Delta sync: runs created/updated in last 10 minutes`, async () => {
  const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const lookupUserIds = [DISCORD_ID, resolvedAppwriteId].filter(Boolean);
  info(`since=${sinceIso}`);
  info(`lookupUserIds=${JSON.stringify(lookupUserIds)}`);

  let deltaCount = 0;
  for (const candidateId of lookupUserIds) {
    for (const field of ['$createdAt', '$updatedAt']) {
      const page = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
        Query.equal('userId', candidateId),
        Query.greaterThan(field, sinceIso),
        Query.orderDesc(field),
        Query.limit(10),
      ]);
      if (page.documents.length > 0) {
        pass(`candidateId=${candidateId} field=${field}: ${page.documents.length} recent runs`);
        for (const doc of page.documents) {
          info(`    wave=${doc.wave}, username=${doc.username ?? '-'}, ${field}=${doc[field]}`);
        }
        deltaCount += page.documents.length;
      }
    }
  }

  if (deltaCount === 0) {
    info('No runs uploaded/modified in the last 10 minutes (expected if idle)');
  } else {
    pass(`Delta would have picked up ${deltaCount} run(s)`);
  }
});

// 6. Find runs stored under unexpected userId values (orphaned or third-party IDs)
await section('6. Orphan check: runs by username not under known userIds', async () => {
  if (!resolvedAppwriteId) {
    info('Skipped - no Appwrite ID resolved in step 1');
    return;
  }

  const knownUserIds = new Set([DISCORD_ID, resolvedAppwriteId]);

  // Re-confirm exact totals per known userId
  const snowflakePage = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
    Query.equal('userId', DISCORD_ID), Query.limit(1),
  ]);
  const appwritePage = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, [
    Query.equal('userId', resolvedAppwriteId), Query.limit(1),
  ]);
  info(`userId=${DISCORD_ID}: ${snowflakePage.total} runs`);
  info(`userId=${resolvedAppwriteId}: ${appwritePage.total} runs`);
  info(`Combined Appwrite total (bot perspective): ${snowflakePage.total + appwritePage.total}`);

  // Fetch ALL runs for both userIds and look for documents that have
  // a userId field that doesn't match the queried ID (shouldn't happen, but worth checking)
  const strayIds = new Map(); // unexpectedUserId => count
  for (const uid of knownUserIds) {
    let cursor = null;
    while (true) {
      const q = [Query.equal('userId', uid), Query.limit(100)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, q);
      if (!r.documents.length) break;
      for (const doc of r.documents) {
        if (!knownUserIds.has(doc.userId)) {
          strayIds.set(doc.userId, (strayIds.get(doc.userId) ?? 0) + 1);
        }
      }
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
  }

  if (strayIds.size > 0) {
    fail(`Found runs with unexpected userId values:`);
    for (const [uid, count] of strayIds) {
      info(`  userId=${uid}: ${count} run(s)`);
    }
  } else {
    pass('All queried runs belong to a known userId (snowflake or appwriteId)');
    info('If the site shows more runs than this, those extra are local-only (not uploaded to cloud)');
  }
});

// 7. Schema validation audit: find documents that fail trackerRunCloudDocumentSchema
await section('7. Schema validation audit: which documents fail strict parse?', async () => {
  if (!resolvedAppwriteId) {
    info('Skipped - no Appwrite ID resolved in step 1');
    return;
  }

  const userIds = [DISCORD_ID, resolvedAppwriteId];
  let totalFetched = 0;
  let totalPassed = 0;
  const failures = [];

  for (const uid of userIds) {
    let cursor = null;
    while (true) {
      const q = [Query.equal('userId', uid), Query.limit(100)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, q);
      if (!r.documents.length) break;

      for (const doc of r.documents) {
        totalFetched++;
        const result = trackerRunCloudDocumentSchema.safeParse(doc);
        if (result.success) {
          totalPassed++;
        } else {
          const unknownKeys = [];
          for (const issue of result.error.issues) {
            if (issue.code === 'unrecognized_keys') {
              unknownKeys.push(...issue.keys);
            }
          }
          failures.push({
            $id: doc.$id,
            userId: doc.userId,
            wave: doc.wave,
            $createdAt: doc.$createdAt,
            unknownKeys,
            errorSummary: result.error.issues.map(i => `${i.code}@${i.path.join('.')}`).join('; '),
          });
        }
      }

      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
  }

  info(`Total documents fetched: ${totalFetched}`);
  info(`Schema passed: ${totalPassed}`);
  info(`Schema failed: ${failures.length}`);

  if (failures.length > 0) {
    fail(`${failures.length} document(s) rejected by trackerRunCloudDocumentSchema.strict():`);
    for (const f of failures) {
      info(`  $id=${f.$id}, userId=${f.userId}, wave=${f.wave}, created=${f.$createdAt}`);
      if (f.unknownKeys.length > 0) {
        info(`    Unknown fields: ${f.unknownKeys.join(', ')}`);
      } else {
        info(`    Error: ${f.errorSummary}`);
      }
    }
  } else {
    pass('All documents pass schema validation');
  }
});

// ─── Section 8: Blocked/banned/deleted audit + local SQLite count ────────────
await section('8. Blocked/Banned/Deleted Audit', async () => {
  const userIds = [DISCORD_ID, resolvedAppwriteId].filter(Boolean);

  let blocked = 0, banned = 0, softDeleted = 0, totalAudited = 0;

  for (const uid of userIds) {
    let cursor = null;
    while (true) {
      const q = [Query.equal('userId', uid), Query.limit(100)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(RUNS_DB, RUNS_COLLECTION, q);
      if (!r.documents.length) break;
      for (const doc of r.documents) {
        totalAudited++;
        if (doc.blocked === true) blocked++;
        if (doc.banned === true) banned++;
        if (doc.deletedAt) softDeleted++;
      }
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
  }

  info(`Total audited: ${totalAudited}`);
  info(`blocked=true: ${blocked}`);
  info(`banned=true: ${banned}`);
  info(`deletedAt set: ${softDeleted}`);

  const filtered = blocked + banned + softDeleted;
  if (filtered > 0) {
    info(`Cloud total ${totalAudited} minus filtered (${filtered}) = ${totalAudited - filtered}`);
    if (totalAudited - filtered === 943) pass('Matches bot count (943) — bot filters these documents');
    else if (totalAudited - filtered === 948) pass('Matches site count (948) — site filters these documents');
    else info(`Filtered count ${totalAudited - filtered} does not directly match 943 or 948`);
  } else {
    info('No blocked/banned/soft-deleted documents found — filtering is not the cause');
  }
});

// Summary
console.log('\n' + '='.repeat(60));
console.log('  Summary');
console.log('='.repeat(60));
if (resolvedAppwriteId) {
  pass(`Discord ${DISCORD_ID} => Appwrite ${resolvedAppwriteId}`);
  pass('Both bot-uploaded and site-uploaded runs will be found by the bot');
} else {
  info(`Discord ${DISCORD_ID} has no linked Discord OAuth identity in Appwrite`);
  info('Bot will query by Discord snowflake only (bot-uploaded runs will be found)');
  info('Site-uploaded runs will NOT be visible until the user signs in with Discord OAuth');
}
console.log();
