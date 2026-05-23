#!/usr/bin/env node
/**
 * Find run docs that have NEITHER read("users/verified") NOR read("user:681ab667ce6096096b3b")
 * These would be invisible to the site session auth but visible via API key.
 */
import { config as loadDotEnv } from 'dotenv'
import { join } from 'node:path'
import { Client, Databases, Query } from 'node-appwrite'

const originalConsoleWarn = console.warn.bind(console)
console.warn = (...args) => {
  const text = args.map(a => String(a ?? '')).join(' ')
  if (text.includes('The current SDK is built for Appwrite')) return
  originalConsoleWarn(...args)
}

const RUNS_DATABASE_ID = 'run-tracker-data'
const RUNS_COLLECTION_ID = 'runs'
const PAGE_SIZE = 100
const DISCORD_USER_ID = '371914184822095873'
const APPWRITE_USER_ID = '681ab667ce6096096b3b'

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

function hasPermission(doc, permStr) {
  const perms = Array.isArray(doc.$permissions) ? doc.$permissions : []
  return perms.some(p => typeof p === 'string' && p.includes(permStr))
}

async function main() {
  const [discordDocs, appwriteDocs] = await Promise.all([
    fetchAllForUserId(DISCORD_USER_ID),
    fetchAllForUserId(APPWRITE_USER_ID),
  ])

  const allDocs = new Map()
  for (const doc of [...discordDocs, ...appwriteDocs]) {
    allDocs.set(doc.$id, doc)
  }

  const orphans = []
  const categories = { bothPresent: 0, verifiedOnly: 0, userOnly: 0, neither: 0, other: 0 }

  for (const doc of allDocs.values()) {
    const hasVerified = hasPermission(doc, 'users/verified')
    const hasUser = hasPermission(doc, `user:${APPWRITE_USER_ID}`)
    if (hasVerified && hasUser) categories.bothPresent++
    else if (hasVerified && !hasUser) categories.verifiedOnly++
    else if (!hasVerified && hasUser) categories.userOnly++
    else {
      categories.neither++
      orphans.push({
        id: doc.$id,
        userId: doc.userId,
        wave: doc.wave,
        runDate: doc.runDate || doc.date,
        permissions: doc.$permissions,
      })
    }
  }

  console.log(JSON.stringify({
    totalDocs: allDocs.size,
    discordDocs: discordDocs.length,
    appwriteDocs: appwriteDocs.length,
    permissionCategories: categories,
    orphanCount: orphans.length,
    orphans,
  }, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
