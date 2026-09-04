/**
 * Reproduces the "command does nothing until you run it again" report end to end, through
 * the bot's own code path.
 *
 * The chain:
 *   1. RxStorageInstanceLocalstorage.remove() deletes every document file first and the
 *      index files last. A process death in that window (pm2 restart, deploy, crash) leaves
 *      index entries pointing at documents that no longer exist.
 *   2. query() does ensureNotFalsy(getDoc(docId)) on every indexed row, so the next menu
 *      read throws.
 *   3. loadBotMenuRunSummary catches that and wipes the shared database to recover.
 *   4. The wipe used to leave the live database open, so the reopen hit RxDB DB8 — and a
 *      failed open frees the name, so the NEXT attempt succeeded and the one after failed.
 *
 * Step 4 is what users see as "try it a few times and it works". Because the recovery path
 * is itself broken, the corruption is never cleared and the bot never heals on its own.
 *
 *   pnpm simulate:corruption -- --runs=250 --attempts=8
 *
 * The sandbox has to be the child's cwd from process start: the sqlite KV path is resolved
 * from cwd at module load, and chdir'ing later breaks relative dynamic imports.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

function parseArg(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const runCount = Number(parseArg('runs', '250'));
const attempts = Number(parseArg('attempts', '8'));
const isChild = process.argv.includes('--child');

const VICTIM = 'discord-victim';
const BYSTANDER = 'discord-bystander';

function spawnPhase(sandbox: string, phase: 'seed' | 'read'): number {
  const result = spawnSync(
    process.execPath,
    // Absolute: the child's cwd is the sandbox, so a bare specifier would not resolve.
    [
      '-r', require.resolve('ts-node/register/transpile-only'),
      __filename, '--child', `--phase=${phase}`, `--runs=${runCount}`, `--attempts=${attempts}`,
    ],
    {
      cwd: sandbox,
      stdio: 'inherit',
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(__dirname, '..', 'tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true',
        TRACKER_BOT_RXDB_STORAGE: 'localstorage',
        TRACKER_BOT_RXDB_DATA_DIR: join(sandbox, 'rxdb'),
        BOT_LOG_LEVEL: 'error',
      },
    },
  );
  return result.status ?? 0;
}

function parent(): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'corrupt-sim-'));
  const storageDir = join(sandbox, 'rxdb');

  spawnPhase(sandbox, 'seed');

  // The wipe is interrupted BY the process dying, so the corruption is always read by a
  // fresh process. Doing it in one process would only measure RxDB's query cache.
  const deleted = simulateInterruptedWipe(storageDir, VICTIM);
  console.log();
  console.log(`simulated a wipe interrupted by a restart: deleted ${deleted} of ${VICTIM}'s document files, left every index entry pointing at them`);
  console.log('--- bot restarts ---');
  console.log();

  const status = spawnPhase(sandbox, 'read');

  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* sqlite handle; it is in tmp either way */ }
  process.exit(status);
}

/** Simulate a process killed midway through remove(): documents gone, indexes still there. */
function simulateInterruptedWipe(storageDir: string, ownerId: string): number {
  const victims = readdirSync(storageDir)
    .filter((f) => f.includes('-doc-') && f.includes(ownerId));
  for (const victim of victims) {
    unlinkSync(join(storageDir, victim));
  }
  return victims.length;
}

async function child(): Promise<void> {
  const phase = parseArg('phase', 'seed');

  const { trackerRunPart1RxJsonSchema, trackerRunPart2RxJsonSchema } = require('@tmrxjd/platform/tools');
  // Load the BUILT modules, not src: the recovery path uses a dynamic import(), which
  // tsc compiles to require() for CommonJS but ts-node leaves as a native ESM import that
  // cannot resolve. dist is also exactly what pm2 runs in production.
  const dist = join(__dirname, '..', 'dist', 'rxdb');
  const { ensureBotRunTrackerRxDatabase } = require(join(dist, 'run-rxdb-store'));
  const { batchUpsertRunPartsToBotRxDB } = require(join(dist, 'persistence'));
  const { loadBotMenuRunSummary } = require(join(dist, 'run-menu-local-summary'));

  function buildDoc(schema: any, id: string, user: string, at: number, extra: any = {}) {
    const doc: any = { id, updatedAt: at, botScopeUserId: user, userId: user, username: user, createdAt: at };
    for (const [key, def] of Object.entries<any>(schema.properties)) {
      if (key in doc) continue;
      const type = Array.isArray(def.type) ? def.type[0] : def.type;
      if (type === 'number' || type === 'integer') doc[key] = Math.round(Math.random() * 1e6);
    }
    return { ...doc, ...extra };
  }

  const db = phase === 'seed' ? await ensureBotRunTrackerRxDatabase(VICTIM) : null;
  for (const user of (phase === 'seed' ? [VICTIM, BYSTANDER] : [])) {
    const part1: any[] = [];
    const part2: any[] = [];
    for (let i = 0; i < runCount; i += 1) {
      const at = Date.now() - i * 3_600_000;
      const id = `${user}-run-${i}`;
      part1.push(buildDoc(trackerRunPart1RxJsonSchema, id, user, at, {
        type: 'Farming',
        runDate: new Date(at).toISOString().slice(0, 10),
        runTime: new Date(at).toISOString().slice(11, 19),
      }));
      part2.push(buildDoc(trackerRunPart2RxJsonSchema, id, user, at));
    }
    await batchUpsertRunPartsToBotRxDB(db!, user, part1, part2);
  }

  if (phase === 'seed') {
    const healthy = await loadBotMenuRunSummary(VICTIM);
    console.log(`baseline: ${VICTIM}'s menu opens fine, ${healthy.totalRuns} runs`);
    return;
  }

  console.log('both users start running /track:');
  console.log();
  console.log('attempt  user                 result');

  let ok = 0;
  let failed = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const user = attempt % 2 === 0 ? BYSTANDER : VICTIM;
    try {
      const summary = await loadBotMenuRunSummary(user);
      ok += 1;
      console.log(`${String(attempt).padEnd(9)}${user.padEnd(21)}OK (${summary.totalRuns} runs)`);
    } catch (error: any) {
      failed += 1;
      const code = error?.code
        ?? (String(error?.message ?? '').match(/Error-Code: (\w+)/) ?? [])[1]
        ?? String(error?.message ?? 'error').split('\n')[0].slice(0, 60);
      console.log(`${String(attempt).padEnd(9)}${user.padEnd(21)}FAILED — ${code}`);
    }
  }

  console.log(`\n${ok} succeeded, ${failed} failed out of ${attempts}`);
  console.log(failed === 0
    ? 'RECOVERED: the wipe cleared the corruption and every later command worked.'
    : 'NOT RECOVERED: commands keep failing — this is the "run it a few times" symptom.');
}

if (!isChild) {
  parent();
} else {
  child()
    .catch((error) => {
      console.error('[sim] failed', error);
      process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
}
