/**
 * Storage-engine benchmark for the menu summary read path.
 *
 * The 10062 "Unknown interaction" reports are caused by the event loop being blocked, not
 * by the tracker being slow: RxDB's localstorage engine reads every document through
 * node-localstorage's synchronous fs, so one user's menu open freezes the process for
 * everyone else and their `deferReply()` misses Discord's ~3s token deadline.
 *
 * Wall time alone does not capture that. What matters is how long the loop is unable to
 * run anything, so this samples loop lag while the summary is in flight and reports the
 * worst stall next to the ACK budget it has to fit inside.
 *
 * One storage engine per process: the mode is resolved from env once and the storage is
 * cached for the process lifetime, so two modes cannot be compared in-process.
 *
 *   pnpm bench:storage -- --mode=localstorage --runs=1500
 *   pnpm bench:storage -- --mode=dexie --runs=1500
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

type BenchMode = 'localstorage' | 'dexie' | 'memory';

const ACK_BUDGET_MS = 3000;
/** Fine enough to catch a stall well under the ACK budget without perturbing the run. */
const LAG_SAMPLE_INTERVAL_MS = 20;

function parseArg(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const mode = parseArg('mode', 'localstorage') as BenchMode;
const runCount = Number(parseArg('runs', '1500'));
const userCount = Number(parseArg('users', '3'));
const iterations = Number(parseArg('iterations', '3'));
const incrementalWrites = Number(parseArg('incremental-writes', '25'));
const keepData = process.argv.includes('--keep-data');

// Must be set before anything imports the storage module, which reads env at first use.
const dataDir = mkdtempSync(join(tmpdir(), 'bench-rxdb-'));
process.env.TRACKER_BOT_RXDB_STORAGE = mode;
process.env.TRACKER_BOT_RXDB_DATA_DIR = dataDir;

/**
 * A timer that measures its own lateness. The drift is exactly the time the loop spent
 * unable to run anything else — which is the time a competing interaction would have sat
 * unacknowledged.
 */
function startLagSampler() {
  const lags: number[] = [];
  let expectedAt = Date.now() + LAG_SAMPLE_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    lags.push(Math.max(0, now - expectedAt));
    expectedAt = now + LAG_SAMPLE_INTERVAL_MS;
  }, LAG_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      const maxLagMs = lags.length ? Math.max(...lags) : 0;
      return {
        maxLagMs,
        totalBlockedMs: lags.reduce((sum, lag) => sum + lag, 0),
        samples: lags.length,
      };
    },
  };
}

/**
 * Fills every numeric field the real schema declares so the synthetic documents land in
 * the same size class as production ones (~4 KB). Document size drives both the per-file
 * read and the JSON.parse, so undersized fixtures would flatter the slow engine.
 */
function buildDocument(
  schema: { properties: Record<string, { type?: string }> },
  id: string,
  scopeUserId: string,
  updatedAt: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id,
    updatedAt,
    botScopeUserId: scopeUserId,
  };

  for (const [key, definition] of Object.entries(schema.properties)) {
    if (key in doc) continue;
    const type = Array.isArray(definition.type) ? definition.type[0] : definition.type;
    if (type === 'number' || type === 'integer') {
      doc[key] = Math.round(Math.random() * 1_000_000);
    } else if (type === 'boolean') {
      doc[key] = false;
    }
  }

  return { ...doc, ...overrides };
}

async function main(): Promise<void> {
  // require, not dynamic import: ts-node hooks the CJS loader only, and these have to be
  // loaded lazily so the env above is in place before the storage module reads it.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { trackerRunPart1RxJsonSchema, trackerRunPart2RxJsonSchema } = require('@tmrxjd/platform/tools');
  const { ensureBotRunTrackerRxDatabase } = require('../src/rxdb/run-rxdb-store');
  const { batchUpsertRunPartsToBotRxDB } = require('../src/rxdb/persistence');
  const { loadBotMenuRunSummary } = require('../src/rxdb/run-menu-local-summary');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const db = await ensureBotRunTrackerRxDatabase('bench-seed');
  const userIds = Array.from({ length: userCount }, (_, index) => `bench-user-${index + 1}`);

  const seedSampler = startLagSampler();
  const seedStartedAt = Date.now();
  for (const userId of userIds) {
    const part1: Record<string, unknown>[] = [];
    const part2: Record<string, unknown>[] = [];
    for (let index = 0; index < runCount; index += 1) {
      const id = `${userId}-run-${index}`;
      // Spread across ~60 days so the 7-day analytics window stitches a realistic slice
      // rather than every run or none.
      const runDate = new Date(Date.now() - index * 60 * 60 * 1000);
      part1.push(buildDocument(trackerRunPart1RxJsonSchema, id, userId, runDate.getTime(), {
        userId,
        username: userId,
        type: index % 3 === 0 ? 'Tournament' : 'Farming',
        runDate: runDate.toISOString().slice(0, 10),
        runTime: runDate.toISOString().slice(11, 19),
        createdAt: runDate.getTime(),
      }));
      part2.push(buildDocument(trackerRunPart2RxJsonSchema, id, userId, runDate.getTime(), { userId }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await batchUpsertRunPartsToBotRxDB(db, userId, part1 as any, part2 as any);
  }
  const seedMs = Date.now() - seedStartedAt;
  const seedLag = seedSampler.stop();

  // A delta sync or a fresh upload writes a handful of runs at a time. That is the write
  // shape that runs while other users are mid-command, so it is the one whose stall
  // decides whether their deferReply() survives.
  const incrementalUserId = userIds[0];
  const incrementalPart1: Record<string, unknown>[] = [];
  const incrementalPart2: Record<string, unknown>[] = [];
  for (let index = 0; index < incrementalWrites; index += 1) {
    const id = `${incrementalUserId}-incr-${Date.now()}-${index}`;
    const at = Date.now() - index * 60_000;
    incrementalPart1.push(buildDocument(trackerRunPart1RxJsonSchema, id, incrementalUserId, at, {
      userId: incrementalUserId,
      username: incrementalUserId,
      type: 'Farming',
      runDate: new Date(at).toISOString().slice(0, 10),
      runTime: new Date(at).toISOString().slice(11, 19),
      createdAt: at,
    }));
    incrementalPart2.push(buildDocument(trackerRunPart2RxJsonSchema, id, incrementalUserId, at, { userId: incrementalUserId }));
  }

  const incrementalSampler = startLagSampler();
  const incrementalStartedAt = Date.now();
  await batchUpsertRunPartsToBotRxDB(db, incrementalUserId, incrementalPart1 as any, incrementalPart2 as any);
  const incrementalMs = Date.now() - incrementalStartedAt;
  const incrementalLag = incrementalSampler.stop();

  // The first read pays one-time costs (index parse, lazy init) that later reads do not,
  // and it is also the read a restarted bot serves, so report it separately.
  const results: { iteration: number; wallMs: number; maxLagMs: number; totalBlockedMs: number; totalRuns: number }[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const userId = userIds[(iteration - 1) % userIds.length];
    const sampler = startLagSampler();
    const startedAt = Date.now();
    const summary = await loadBotMenuRunSummary(userId);
    const wallMs = Date.now() - startedAt;
    const lag = sampler.stop();
    results.push({
      iteration,
      wallMs,
      maxLagMs: lag.maxLagMs,
      totalBlockedMs: lag.totalBlockedMs,
      totalRuns: summary.totalRuns,
    });
  }

  const worstReadLagMs = Math.max(...results.map((result) => result.maxLagMs));
  const worstLagMs = Math.max(worstReadLagMs, seedLag.maxLagMs, incrementalLag.maxLagMs);
  const report = {
    mode,
    runsPerUser: runCount,
    users: userCount,
    totalDocuments: runCount * userCount * 2,
    seed: {
      totalMs: seedMs,
      maxLagMs: seedLag.maxLagMs,
      totalBlockedMs: seedLag.totalBlockedMs,
    },
    incrementalWrite: {
      runs: incrementalWrites,
      totalMs: incrementalMs,
      maxLagMs: incrementalLag.maxLagMs,
      totalBlockedMs: incrementalLag.totalBlockedMs,
    },
    iterations: results,
    worstReadLagMs,
    worstLagMs,
    ackBudgetMs: ACK_BUDGET_MS,
    // The only pass/fail that matters: could a bystander's deferReply() have survived?
    wouldDropInteraction: worstLagMs >= ACK_BUDGET_MS,
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error('[bench] failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!keepData) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    // RxDB keeps handles open; nothing here is worth waiting on.
    process.exit(process.exitCode ?? 0);
  });
