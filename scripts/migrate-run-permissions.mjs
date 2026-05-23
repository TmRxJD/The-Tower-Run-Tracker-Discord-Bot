#!/usr/bin/env node
/**
 * One-time migration: patch all run documents that are missing proper
 * user:681ab667ce6096096b3b (read/update/delete) permissions so the site
 * session can manage (delete/update) them without requiring API key auth.
 *
 * Targets:
 *   - docs with userId = Discord snowflake 371914184822095873
 *   - docs with empty $permissions []
 *
 * Sets for each doc:
 *   - userId           → canonical Appwrite account ID
 *   - $permissions     → read + update + delete for user:681ab667ce6096096b3b
 *
 * Safe to re-run: skips docs already fully normalized.
 *
 * Usage:
 *   node scripts/migrate-run-permissions.mjs
 *   node scripts/migrate-run-permissions.mjs --dry-run
 */
import { config as loadDotEnv } from 'dotenv'
import { join } from 'node:path'
import { Client, Databases, Permission, Query, Role } from 'node-appwrite'

const originalConsoleWarn = console.warn.bind(console)
console.warn = (...args) => {
  const text = args.map(a => String(a ?? '')).join(' ')
  if (text.includes('The current SDK is built for Appwrite')) return
  originalConsoleWarn(...args)
}

const RUNS_DATABASE_ID = 'run-tracker-data'
const RUNS_COLLECTION_ID = 'runs'
const RUNS_EXTENDED_COLLECTION_ID = 'runs_extended_data'
const DISCORD_USER_ID = '371914184822095873'
const APPWRITE_USER_ID = '681ab667ce6096096b3b'
const PAGE_SIZE = 100
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 400

const isDryRun = process.argv.includes('--dry-run')

loadDotEnv({ path: join(process.cwd(), '.env.dev') })
loadDotEnv({ path: join(process.cwd(), '.env'), override: false })

const endpoint = process.env.APPWRITE_ENDPOINT
const projectId = process.env.APPWRITE_PROJECT_ID
const apiKey = process.env.APPWRITE_API_KEY
if (!endpoint || !projectId || !apiKey) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY')
  process.exit(1)
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey)
const databases = new Databases(client)

const CANONICAL_PERMS = [
  Permission.read(Role.user(APPWRITE_USER_ID)),
  Permission.update(Role.user(APPWRITE_USER_ID)),
  Permission.delete(Role.user(APPWRITE_USER_ID)),
]

function hasFullPermissions(doc) {
  const perms = Array.isArray(doc.$permissions) ? doc.$permissions : []
  const str = perms.join(' ')
  return (
    str.includes(`read("user:${APPWRITE_USER_ID}")`) &&
    str.includes(`update("user:${APPWRITE_USER_ID}")`) &&
    str.includes(`delete("user:${APPWRITE_USER_ID}")`)
  )
}

function needsNormalization(doc) {
  const docUserId = typeof doc.userId === 'string' ? doc.userId.trim() : ''
  const wrongUserId = docUserId !== APPWRITE_USER_ID
  const missingPerms = !hasFullPermissions(doc)
  return wrongUserId || missingPerms
}

async function fetchAllForUserId(userId) {
  const results = []
  let cursorAfter = null
  while (true) {
    const queries = [
      Query.equal('userId', userId),
      Query.limit(PAGE_SIZE),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ]
    const page = await databases.listDocuments(RUNS_DATABASE_ID, RUNS_COLLECTION_ID, queries)
    const docs = Array.isArray(page.documents) ? page.documents : []
    results.push(...docs)
    if (docs.length < PAGE_SIZE) break
    const last = docs[docs.length - 1]
    cursorAfter = last?.$id ?? null
    if (!cursorAfter) break
  }
  return results
}

async function migrateCollection(collectionId, label) {
  const [discordDocs, appwriteDocs] = await Promise.all([
    fetchAllForUserIdInCollection(collectionId, DISCORD_USER_ID),
    fetchAllForUserIdInCollection(collectionId, APPWRITE_USER_ID),
  ])

  const allDocs = new Map()
  for (const doc of [...discordDocs, ...appwriteDocs]) allDocs.set(doc.$id, doc)

  const toNormalize = Array.from(allDocs.values()).filter(needsNormalization)

  console.log(`[${label}] Total docs: ${allDocs.size}, need normalization: ${toNormalize.length}`)
  if (!toNormalize.length) return { updated: 0, failed: 0 }

  if (isDryRun) {
    console.log(`[${label}] DRY RUN — would update:`, toNormalize.map(d => ({
      id: d.$id,
      userId: d.userId,
      permissions: d.$permissions,
    })))
    return { updated: 0, failed: 0 }
  }

  let updated = 0
  let failed = 0

  for (let i = 0; i < toNormalize.length; i += BATCH_SIZE) {
    const batch = toNormalize.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(async (doc) => {
      try {
        await databases.updateDocument(
          RUNS_DATABASE_ID,
          collectionId,
          doc.$id,
          { userId: APPWRITE_USER_ID },
          CANONICAL_PERMS,
        )
        updated++
        console.log(`[${label}] ✓ ${doc.$id} (was userId=${doc.userId})`)
      } catch (err) {
        failed++
        console.error(`[${label}] ✗ ${doc.$id}`, err?.message ?? err)
      }
    }))
    if (i + BATCH_SIZE < toNormalize.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
    }
  }

  return { updated, failed }
}

async function fetchAllForUserIdInCollection(collectionId, userId) {
  const results = []
  let cursorAfter = null
  while (true) {
    const queries = [
      Query.equal('userId', userId),
      Query.limit(PAGE_SIZE),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ]
    const page = await databases.listDocuments(RUNS_DATABASE_ID, collectionId, queries)
    const docs = Array.isArray(page.documents) ? page.documents : []
    results.push(...docs)
    if (docs.length < PAGE_SIZE) break
    const last = docs[docs.length - 1]
    cursorAfter = last?.$id ?? null
    if (!cursorAfter) break
  }
  return results
}

async function main() {
  if (isDryRun) console.log('=== DRY RUN MODE — no writes will be made ===')

  const runsResult = await migrateCollection(RUNS_COLLECTION_ID, 'runs')

  let extendedResult = { updated: 0, failed: 0 }
  try {
    extendedResult = await migrateCollection(RUNS_EXTENDED_COLLECTION_ID, 'runs_extended_data')
  } catch (err) {
    console.warn('[runs_extended_data] collection unavailable or error, skipping:', err?.message ?? err)
  }

  console.log('\n=== MIGRATION COMPLETE ===')
  console.log('runs:               updated', runsResult.updated, '| failed', runsResult.failed)
  console.log('runs_extended_data: updated', extendedResult.updated, '| failed', extendedResult.failed)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
