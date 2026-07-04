const CACHE_TTL_MS = 1000 * 60 * 60 * 6

type CachedBuildShare = {
  code: string
  url: string
  expiresAt: number
}

const cache = new Map<string, CachedBuildShare>()

function pruneExpired(now = Date.now()): void {
  for (const [token, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(token)
    }
  }
}

export function storeShareBuildLink(token: string, entry: { code: string; url: string }): void {
  pruneExpired()
  cache.set(token, {
    code: entry.code,
    url: entry.url,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

export function readShareBuildLink(token: string): { code: string; url: string } | null {
  pruneExpired()
  const entry = cache.get(token)
  if (!entry) return null
  return { code: entry.code, url: entry.url }
}

export function createShareBuildToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
