/**
 * Guards the one platform-resolution failure that a type-check cannot catch.
 *
 * Development links @tmrxjd/platform from a local checkout; production resolves it from the
 * registry (ensure-local-platform defaults to `registry` when DEPLOYMENT_MODE is prod, and
 * .platform-mode is gitignored so a local setting is never inherited). The two drift without
 * the version changing, and the local build is usually ahead of what has been published.
 *
 * A local build therefore proves nothing about the deploy host. `tsc` is authoritative about
 * whether the resolved package satisfies the bot — it follows re-exports into dependencies,
 * which a symbol scan over the package's own files does not (the platform re-exports much of
 * its surface from `thetowersdk`, so such a scan reports types as missing that resolve fine).
 * This deliberately does not re-implement that check; it reports what got resolved, and fails
 * when a production deploy is about to build against a local symlink.
 *
 *   node scripts/verify-platform-api.mjs
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPECIFIER = '@tmrxjd/platform'

function main() {
  const packageRoot = join(repoRoot, 'node_modules', SPECIFIER)
  if (!existsSync(packageRoot)) {
    // Preflight can run before install; that is not a failure to report here.
    console.log(`[platform-verify] ${SPECIFIER} is not installed yet — skipping.`)
    return
  }

  const pinned = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    .dependencies?.[SPECIFIER] ?? '(unpinned)'
  const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
  const linked = lstatSync(packageRoot).isSymbolicLink()
  const origin = linked ? `local checkout at ${realpathSync(packageRoot)}` : 'registry'

  console.log(`[platform-verify] pinned ${pinned}, installed ${installed}, resolved from ${origin}`)

  if (linked && process.env.DEPLOYMENT_MODE === 'prod') {
    console.error('')
    console.error('[platform-verify] a production build is resolving the platform from a local')
    console.error('checkout. The deploy host installs from the registry instead, so this build')
    console.error('proves nothing about what will actually run there.')
    console.error('')
    console.error('Publish the platform at a new version, then update this repo\'s dependency')
    console.error('and lockfile, or run `pnpm platform:use:registry` before building.')
    process.exit(1)
  }

  if (linked) {
    console.log('[platform-verify] note: linked locally, so this build does not reflect the registry copy.')
    console.log('[platform-verify] before deploying, verify against the registry:')
    console.log('[platform-verify]   pnpm platform:use:registry && pnpm install && pnpm type-check')
  }

  console.log('[platform-verify] OK (pnpm type-check remains the authority on API compatibility).')
}

main()
