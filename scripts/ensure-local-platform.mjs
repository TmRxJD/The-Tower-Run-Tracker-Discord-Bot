import { execSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const action = process.argv[2] ?? 'ensure'
const repoRoot = resolve(import.meta.dirname, '..')
const installedPath = resolve(repoRoot, 'node_modules', '@tmrxjd', 'platform')
const localPlatformPath = resolve(repoRoot, '..', '..', 'TrackerWebsite', 'the-tower-run-tracker', 'packages', 'platform')
const localPlatformDistPath = resolve(localPlatformPath, 'dist', 'tools', 'index.d.ts')
const modeFilePath = resolve(repoRoot, '.platform-mode')
const mode = resolveMode()
const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
const shouldUseLocal = mode !== 'registry' && !isCi && existsSync(localPlatformPath)

function resolveMode() {
  const envMode = process.env.TMRXJD_PLATFORM_MODE?.trim().toLowerCase()
  if (envMode === 'registry' || envMode === 'auto') {
    return envMode
  }

  if (!existsSync(modeFilePath)) {
    return 'auto'
  }

  const fileMode = readFileSync(modeFilePath, 'utf8').trim().toLowerCase()
  return fileMode === 'registry' ? 'registry' : 'auto'
}

function setMode(nextMode) {
  if (nextMode === 'registry') {
    writeFileSync(modeFilePath, 'registry\n', 'utf8')
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

function ensureLocalPlatformBuild() {
  if (existsSync(localPlatformDistPath)) {
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
  if (!shouldUseLocal) {
    process.stdout.write('[platform] using published package resolution\n')
    return
  }

  if (isSymlinkToLocalPlatform()) {
    process.stdout.write('[platform] local package link already active\n')
    return
  }

  ensureLocalPlatformBuild()
  rmSync(installedPath, { recursive: true, force: true })
  mkdirSync(dirname(installedPath), { recursive: true })
  symlinkSync(localPlatformPath, installedPath, process.platform === 'win32' ? 'junction' : 'dir')
  process.stdout.write(`[platform] linked local package from ${localPlatformPath}\n`)
}

function printStatus() {
  if (isSymlinkToLocalPlatform()) {
    process.stdout.write(`mode=${mode}\nactive=local\npath=${localPlatformPath}\n`)
    return
  }

  process.stdout.write(`mode=${mode}\nactive=${shouldUseLocal ? 'published-installed-local-available' : 'published'}\npath=${installedPath}\n`)
}

function useRegistry() {
  setMode('registry')
  rmSync(installedPath, { recursive: true, force: true })
  reinstallForMode('registry')
}

function useLocal() {
  setMode('auto')
  linkLocalPlatform()
}

switch (action) {
  case 'ensure':
  case 'link':
    linkLocalPlatform()
    break
  case 'use-local':
    useLocal()
    break
  case 'use-registry':
    useRegistry()
    break
  case 'status':
    printStatus()
    break
  default:
    throw new Error(`Unsupported action: ${action}`)
}