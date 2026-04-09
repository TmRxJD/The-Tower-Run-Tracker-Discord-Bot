import { spawn } from 'node:child_process'
import process from 'node:process'

const APP_PORT = Number(process.env.TRACKERBOT_DEV_PORT || 5176)
const HEALTH_URL = `http://127.0.0.1:${APP_PORT}/json/version`

function resolveForceRestart() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--force-restart')) return true
  if (args.has('--no-force-restart')) return false
  return false
}

const FORCE_RESTART = resolveForceRestart()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runCommand(command, args) {
  return await new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += String(chunk || '')
    })

    child.stderr.on('data', chunk => {
      stderr += String(chunk || '')
    })

    child.on('error', error => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() })
    })

    child.on('close', code => {
      resolve({ code: Number(code) || 0, stdout, stderr })
    })
  })
}

async function fetchHealth(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(url, timeoutMs = 15000) {
  const started = Date.now()
  while ((Date.now() - started) < timeoutMs) {
    if (await fetchHealth(url)) return true
    await sleep(400)
  }
  return false
}

async function listListeningPids(port) {
  if (process.platform === 'win32') {
    const psScript = [
      `$conns = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue`,
      'if ($conns) { $conns | Select-Object -ExpandProperty OwningProcess -Unique }',
    ].join('; ')
    const result = await runCommand('powershell', ['-NoProfile', '-Command', psScript])
    if (result.code !== 0) return []
    return String(result.stdout || '')
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
  }

  const result = await runCommand('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  if (result.code !== 0) return []
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    void 0
  }
}

async function killPortListeners(port) {
  const pids = await listListeningPids(port)
  if (pids.length === 0) return
  process.stdout.write(`[TRACKERBOT-DEV] killing listener(s) on port ${port}: ${pids.join(', ')}\n`)
  for (const pid of pids) {
    await killPid(pid)
  }
  await sleep(350)
}

function pipeOutput(child, label) {
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`))
}

function startProcess(label, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: process.env,
  })
  pipeOutput(child, label)
  return child
}

async function main() {
  process.stdout.write(`[TRACKERBOT-DEV] mode: ${FORCE_RESTART ? 'force-restart' : 'reuse-healthy'}\n`)
  const healthy = await fetchHealth(HEALTH_URL)
  if (healthy && !FORCE_RESTART) {
    process.stdout.write(`[TRACKERBOT-DEV] dev runtime already healthy on port ${APP_PORT}; reusing existing process\n`)
    return
  }

  await killPortListeners(APP_PORT)

  const app = startProcess('APP', 'pnpm', ['run', 'dev:app'])
  const ready = await waitForHealth(HEALTH_URL)
  process.stdout.write(`[TRACKERBOT-DEV] app healthy: ${ready}\n`)
  if (!ready) {
    app.kill('SIGINT')
    throw new Error(`Dev runtime failed to become healthy on port ${APP_PORT}`)
  }

  process.stdout.write('[TRACKERBOT-DEV] READY: app online\n')
  const exitCode = await new Promise(resolve => {
    app.on('close', code => resolve(Number(code) || 0))
  })
  process.exit(Number(exitCode) || 0)
}

main().catch(error => {
  process.stderr.write(`[TRACKERBOT-DEV] fatal error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})