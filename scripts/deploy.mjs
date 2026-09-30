/* eslint-env node */
/* global fetch */

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const action = process.argv[2]
const serviceName = 'trackerbot'
const envFilePath = '.env.prod'
const envKeys = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'APPWRITE_RUNS_DATABASE_ID',
  'APPWRITE_RUNS_COLLECTION_ID',
  'APPWRITE_SETTINGS_DATABASE_ID',
  'APPWRITE_SETTINGS_COLLECTION_ID',
  'APPWRITE_RUNS_BUCKET_ID',
  'APPWRITE_LIFETIME_DATABASE_ID',
  'APPWRITE_LIFETIME_COLLECTION_ID',
  'APPWRITE_LEADERBOARD_DATABASE_ID',
  'APPWRITE_LEADERBOARD_COLLECTION_ID',
  'APPWRITE_ANALYTICS_COLLECTION_ID',
  'APPWRITE_USER_SETTINGS_COLLECTION_ID',
  'APPWRITE_GUILDS_COLLECTION_ID',
  'APPWRITE_API_KEY',
  'TRACKERAI_BRIDGE_URL',
  'TRACKERAI_BRIDGE_TOKEN',
  'TRACKERAI_CLOUD_AI_ENDPOINT',
  'TRACKERAI_CLOUD_AI_API_KEY',
  'TRACKERAI_CLOUD_VISION_MODEL',
  'AI_TIMEOUT_MS',
  'TRACKER_API_URL',
  'TRACKER_API_KEY',
]
const platformRegistry = getEnv('TMRXJD_PLATFORM_REGISTRY', 'https://npm.pkg.github.com')

function getEnv(name, fallback = '') {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : fallback
}

function run(command, options = {}) {
  execSync(command, {
    stdio: 'inherit',
    env: process.env,
    ...options,
  })
}

function getPackagesAuthToken() {
  return getEnv('NODE_AUTH_TOKEN') || getEnv('GITHUB_PACKAGES_TOKEN') || getEnv('GH_PACKAGES_TOKEN')
}

function writeEnvFile() {
  const lines = [
    'NODE_ENV=production',
    'DEPLOYMENT_MODE=prod',
    `SERVICE_NAME=${getEnv('SERVICE_NAME', serviceName)}`,
  ]
  const platformVersion = getEnv('PLATFORM_VERSION')
  if (platformVersion) {
    lines.push(`PLATFORM_VERSION=${platformVersion}`)
  }
  for (const key of envKeys) {
    const value = getEnv(key)
    if (value) {
      lines.push(`${key}=${value}`)
    }
  }
  writeFileSync(envFilePath, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * A restart only picks up new code if dist/ was rebuilt first, and `pm2 restart --update-env`
 * does not re-read ecosystem.config.cjs, so changes there (e.g. UV_THREADPOOL_SIZE) never
 * applied. A running bot once kept a weeks-old build in memory after a "deploy".
 * DEPLOY_SKIP_BUILD=true skips the rebuild for callers that just ran it.
 */
function activateService() {
  if (getEnv('DEPLOY_SKIP_BUILD') !== 'true') {
    // In-place compile rather than `build` (which rimrafs dist first): the running bot
    // lazy-loads some modules and must not find dist/ missing mid-deploy.
    run('pnpm run build:refresh')
  }
  run(`pm2 startOrRestart ecosystem.config.cjs --only ${serviceName} --env production --update-env`)
}

/**
 * Runs the test suite from a throwaway checkout instead of this folder.
 *
 * Every bot resolves its data (.data, data/, sqlite files) relative to the working directory,
 * and this folder is the live bot's. Tests that touch storage would otherwise read and write
 * production state; one did, and drained a real user's pending cloud write through a mock.
 * A detached git worktree is a clean checkout of exactly what is committed (no .env, no data),
 * node_modules is linked in, and vitest is invoked directly so no pretest hook can touch it.
 */
function runIsolatedTests() {
  const scratch = mkdtempSync(join(tmpdir(), `${serviceName}-ci-`))
  const checkout = join(scratch, 'repo')
  const linkedModules = join(checkout, 'node_modules')
  try {
    run(`git worktree add --detach "${checkout}" HEAD`)
    symlinkSync(resolve('node_modules'), linkedModules, 'junction')
    run('node node_modules/vitest/vitest.mjs run', { cwd: checkout })
  } finally {
    try {
      // Remove the link itself first so deleting the checkout can never follow it into node_modules.
      rmdirSync(linkedModules)
    } catch {
      // Not created, or already gone.
    }
    try {
      run(`git worktree remove --force "${checkout}"`, { stdio: 'ignore' })
    } catch {
      // Fall through to deleting the directory and pruning the stale registration.
    }
    rmSync(scratch, { recursive: true, force: true })
    try {
      run('git worktree prune', { stdio: 'ignore' })
    } catch {
      // Best effort.
    }
  }
}

function readPm2Service() {
  const raw = execSync('pm2 jlist', { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 })
  // pm2 prints banners ahead of the JSON ("[PM2] ..." when its daemon starts or a locally installed
  // pm2 is newer than the running daemon), so the array cannot be found by its first '['. The
  // JSON array is the one that opens a line with an object or closes immediately.
  const start = raw.search(/^\[\s*(\{|\])/m)
  if (start < 0) {
    throw new Error(`Could not find the JSON list in pm2 jlist output:
${raw.slice(0, 600)}`)
  }
  const list = JSON.parse(raw.slice(start))
  return list.find((entry) => entry.name === serviceName)
}

function tailFile(path, bytes = 6000) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.slice(-bytes)
  } catch {
    return '(log unavailable)'
  }
}

/**
 * A green "activate" only means pm2 accepted the command. A bot that crashes on startup
 * restarts in a loop and still looks fine a second later, so watch it for a while: it must
 * stay online and not restart. Fails the deploy (with the error log tail) if it does not.
 */
async function verifyService() {
  const seconds = Number(getEnv('DEPLOY_VERIFY_SECONDS', '30'))
  const first = readPm2Service()
  if (!first) {
    throw new Error(`${serviceName} is not registered with pm2 after activation`)
  }

  const baselineRestarts = first.pm2_env.restart_time
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const current = readPm2Service()
    const problem = !current
      ? 'disappeared from pm2'
      : current.pm2_env.status !== 'online'
        ? `status is ${current.pm2_env.status}`
        : current.pm2_env.restart_time > baselineRestarts
          ? `restarted ${current.pm2_env.restart_time - baselineRestarts} time(s)`
          : null
    if (problem) {
      const errorLog = current?.pm2_env?.pm_err_log_path ?? first.pm2_env.pm_err_log_path
      throw new Error(`${serviceName} is unhealthy after deploy: ${problem}.\n\nLast error log lines:\n${tailFile(errorLog)}`)
    }
  }

  const finalState = readPm2Service()
  const uptimeSeconds = Math.round((Date.now() - finalState.pm2_env.pm_uptime) / 1000)
  process.stdout.write(`${serviceName} healthy: online for ${uptimeSeconds}s with no restarts over a ${seconds}s check\n`)
}

function updatePlatformDependency() {
  const version = getEnv('PLATFORM_VERSION')
  if (!version) {
    throw new Error('PLATFORM_VERSION is required')
  }
  run(`pnpm add @tmrxjd/platform@${version} --save-exact`)
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0])
  if (major !== 22) {
    throw new Error(`Expected Node 22.x, received ${process.versions.node}`)
  }
}

function checkPnpmVersion() {
  const version = execSync('pnpm --version', { encoding: 'utf8', env: process.env }).trim()
  if (version !== '10.8.1') {
    throw new Error(`Expected pnpm 10.8.1, received ${version}`)
  }
}

function checkPm2() {
  execSync('pm2 --version', { stdio: 'ignore', env: process.env })
}

function checkPackageAccess() {
  const authToken = getPackagesAuthToken()
  if (!authToken) {
    throw new Error('GitHub Packages auth is missing. Set NODE_AUTH_TOKEN (or GITHUB_PACKAGES_TOKEN) before installing @tmrxjd/platform.')
  }

  // Do NOT swallow the error: a registry-auth failure here previously surfaced
  // only as "Command failed", which hid why the runner could not read the
  // package. Capture stdout/stderr and re-throw with the real diagnostic.
  try {
    execSync(`pnpm view @tmrxjd/platform version --registry ${platformRegistry} --json`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: authToken,
      },
    })
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `Cannot read @tmrxjd/platform from ${platformRegistry} despite a present auth token. `
      + (detail ? `\n\nRegistry output:\n${detail}` : ''),
    )
  }
}

async function warnOnGlobalCommands() {
  return
}

async function preflight() {
  checkNodeVersion()
  checkPnpmVersion()
  checkPm2()
  checkPackageAccess()
  await warnOnGlobalCommands()
}

function report() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  const platformVersion = packageJson.dependencies?.['@tmrxjd/platform'] ?? packageJson.devDependencies?.['@tmrxjd/platform'] ?? 'n/a'
  const pnpmVersion = execSync('pnpm --version', { encoding: 'utf8', env: process.env }).trim()
  process.stdout.write(`service=${serviceName}\n`)
  process.stdout.write(`node=${process.versions.node}\n`)
  process.stdout.write(`pnpm=${pnpmVersion}\n`)
  process.stdout.write(`platform=${platformVersion}\n`)
  try {
    run(`pm2 status ${serviceName}`)
  } catch {
    process.stdout.write(`pm2_status=unavailable:${serviceName}\n`)
  }
}

switch (action) {
  case 'preflight':
    await preflight()
    break
  case 'write-env':
    writeEnvFile()
    break
  case 'activate':
    activateService()
    break
  case 'test':
    runIsolatedTests()
    break
  case 'verify':
    await verifyService()
    break
  case 'update-platform':
    updatePlatformDependency()
    break
  case 'report':
    report()
    break
  default:
    throw new Error(`Unsupported deploy action: ${action ?? '<missing>'}`)
}
