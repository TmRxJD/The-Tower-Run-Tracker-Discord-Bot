import { execSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const action = process.argv[2] ?? 'ensure'
const repoRoot = resolve(import.meta.dirname, '..')
const installedPath = resolve(repoRoot, 'node_modules', '@tmrxjd', 'platform')
const localMonorepoRoot = resolve(repoRoot, '..', '..', 'TrackerWebsite', 'the-tower-run-tracker')
const localPlatformPath = resolve(localMonorepoRoot, 'packages', 'platform')
const localTrackerLanguagesPath = resolve(localMonorepoRoot, 'packages', 'tracker-languages')
const localPlatformDistToolsIndexJs = resolve(localPlatformPath, 'dist', 'tools', 'index.js')
const localPlatformDistPath = resolve(localPlatformPath, 'dist', 'tools', 'index.d.ts')
// Where platform resolves its workspace:* dep on tracker-languages at runtime
const platformPeerModulesDir = resolve(localPlatformPath, 'node_modules', '@tmrxjd')
const platformPeerLanguagesPath = resolve(platformPeerModulesDir, 'tracker-languages')
const modeFilePath = resolve(repoRoot, '.platform-mode')
const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'

function shouldUseLocalPlatform() {
  const mode = resolveMode()
  return mode === 'local' && !isCi && existsSync(localPlatformPath)
}

function resolveDeploymentMode() {
  const deploymentMode = (process.env.DEPLOYMENT_MODE ?? process.env.NODE_ENV ?? '').trim().toLowerCase()
  return deploymentMode === 'prod' || deploymentMode === 'production' ? 'prod' : 'dev'
}

function resolveMode() {
  const envMode = process.env.TMRXJD_PLATFORM_MODE?.trim().toLowerCase()
  if (envMode === 'registry' || envMode === 'local' || envMode === 'auto') {
    return envMode
  }

  if (process.env.DEPLOYMENT_MODE || process.env.NODE_ENV) {
    return resolveDeploymentMode() === 'prod' ? 'registry' : 'local'
  }

  if (existsSync(modeFilePath)) {
    const fileMode = readFileSync(modeFilePath, 'utf8').trim().toLowerCase()
    if (fileMode === 'registry' || fileMode === 'local') {
      return fileMode
    }
  }

  return resolveDeploymentMode() === 'prod' ? 'registry' : 'local'
}

function setMode(nextMode) {
  if (nextMode === 'registry' || nextMode === 'local') {
    writeFileSync(modeFilePath, `${nextMode}\n`, 'utf8')
    return
  }

  if (existsSync(modeFilePath)) {
    unlinkSync(modeFilePath)
  }
}

function reinstallForMode(nextMode) {
  execSync('pnpm install --prefer-frozen-lockfile', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      TMRXJD_PLATFORM_MODE: nextMode,
    },
  })
}

function isSymlinkToLocalPlatform() {
  if (!existsSync(installedPath)) {
    return false
  }

  try {
    const stat = lstatSync(installedPath)
    if (!stat.isSymbolicLink()) {
      return false
    }
    return resolve(dirname(installedPath), readlinkSync(installedPath)) === localPlatformPath
  } catch {
    return false
  }
}

function isSymlinkToLocalTrackerLanguages() {
  if (!existsSync(platformPeerLanguagesPath)) return false
  try {
    const stat = lstatSync(platformPeerLanguagesPath)
    if (!stat.isSymbolicLink()) return false
    return resolve(dirname(platformPeerLanguagesPath), readlinkSync(platformPeerLanguagesPath)) === localTrackerLanguagesPath
  } catch {
    return false
  }
}

function linkTrackerLanguages() {
  if (!existsSync(localTrackerLanguagesPath)) {
    process.stdout.write(`[platform] tracker-languages not found at ${localTrackerLanguagesPath}, skipping peer link\n`)
    return
  }
  if (isSymlinkToLocalTrackerLanguages()) {
    process.stdout.write('[platform] tracker-languages peer link already active\n')
    return
  }
  rmSync(platformPeerLanguagesPath, { recursive: true, force: true })
  mkdirSync(platformPeerModulesDir, { recursive: true })
  symlinkSync(localTrackerLanguagesPath, platformPeerLanguagesPath, process.platform === 'win32' ? 'junction' : 'dir')
  process.stdout.write(`[platform] linked tracker-languages peer from ${localTrackerLanguagesPath}\n`)
}

function unlinkTrackerLanguages() {
  if (!isSymlinkToLocalTrackerLanguages()) return
  rmSync(platformPeerLanguagesPath, { recursive: true, force: true })
  process.stdout.write('[platform] removed tracker-languages peer link\n')
}

function ensureLocalPlatformBuild() {
  if (existsSync(localPlatformDistPath) && existsSync(localPlatformDistToolsIndexJs)) {
    return
  }
  process.stdout.write(`[platform] building local package at ${localPlatformPath}\n`)
  execSync('pnpm run build', {
    cwd: localPlatformPath,
    stdio: 'inherit',
    env: process.env,
  })
}

function linkLocalPlatform() {
  if (!shouldUseLocalPlatform()) {
    process.stdout.write('[platform] using published package resolution\n')
    return
  }

  if (isSymlinkToLocalPlatform()) {
    process.stdout.write('[platform] local package link already active\n')
    linkTrackerLanguages()
    return
  }

  ensureLocalPlatformBuild()
  rmSync(installedPath, { recursive: true, force: true })
  mkdirSync(dirname(installedPath), { recursive: true })
  symlinkSync(localPlatformPath, installedPath, process.platform === 'win32' ? 'junction' : 'dir')
  process.stdout.write(`[platform] linked local package from ${localPlatformPath}\n`)
  linkTrackerLanguages()
}

function ensurePublishedPlatform() {
  if (shouldUseLocalPlatform()) {
    process.stdout.write('[platform] using local package resolution\n')
    return
  }

  unlinkTrackerLanguages()

  if (!isSymlinkToLocalPlatform() && existsSync(installedPath)) {
    process.stdout.write('[platform] published package already active\n')
    return
  }

  process.stdout.write('[platform] restoring published package resolution\n')
  rmSync(installedPath, { recursive: true, force: true })
  reinstallForMode('registry')
}

function ensurePlatformResolution() {
  if (shouldUseLocalPlatform()) {
    linkLocalPlatform()
    return
  }

  ensurePublishedPlatform()
}

function printStatus() {
  if (isSymlinkToLocalPlatform()) {
    process.stdout.write(`mode=${resolveMode()}\nactive=local\npath=${localPlatformPath}\n`)
    return
  }

  process.stdout.write(`mode=${resolveMode()}\nactive=${shouldUseLocalPlatform() ? 'published-installed-local-available' : 'published'}\npath=${installedPath}\n`)
}

function useRegistry() {
  setMode('registry')
  ensurePublishedPlatform()
}

function useLocal() {
  setMode('local')
  linkLocalPlatform()
}

function useAuto() {
  setMode('auto')
  ensurePlatformResolution()
}

switch (action) {
  case 'ensure':
  case 'link':
    ensurePlatformResolution()
    break
  case 'use-local':
    useLocal()
    break
  case 'use-registry':
    useRegistry()
    break
  case 'use-auto':
    useAuto()
    break
  case 'status':
    printStatus()
    break
  default:
    throw new Error(`Unsupported action: ${action}`)
}