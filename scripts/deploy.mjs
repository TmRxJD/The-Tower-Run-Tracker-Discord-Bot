/* eslint-env node */
/* global fetch */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

function activateService() {
  try {
    execSync(`pm2 describe ${serviceName}`, { stdio: 'ignore', env: process.env })
    run(`pm2 restart ${serviceName} --update-env`)
  } catch {
    run('pm2 start ecosystem.config.cjs --env production')
  }
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

  execSync(`pnpm view @tmrxjd/platform version --registry ${platformRegistry} --json`, {
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: authToken,
    },
  })
}

async function warnOnGlobalCommands() {
  const deploymentMode = getEnv('DEPLOYMENT_MODE', 'prod')
  if (deploymentMode !== 'dev') {
    return
  }
  const token = getEnv('DEV_DISCORD_TOKEN') || getEnv('DISCORD_TOKEN')
  const clientId = getEnv('DEV_CLIENT_ID') || getEnv('CLIENT_ID')
  const guildId = getEnv('DEV_GUILD_ID')
  if (!token || !clientId || !guildId) {
    return
  }
  const response = await fetch(`https://discord.com/api/v10/applications/${clientId}/commands`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to inspect global commands: ${response.status} ${response.statusText}`)
  }
  const commands = await response.json()
  if (Array.isArray(commands) && commands.length > 0) {
    process.stdout.write('Warning: global Discord commands exist alongside guild deployment and can appear as duplicate commands. Consider running register:commands:clear:global once before validation.\n')
  }
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
  case 'update-platform':
    updatePlatformDependency()
    break
  case 'report':
    report()
    break
  default:
    throw new Error(`Unsupported deploy action: ${action ?? '<missing>'}`)
}
