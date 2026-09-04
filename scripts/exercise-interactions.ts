/**
 * Drives the bot's real interaction-acknowledgement path while a real import runs, and
 * measures whether the ACK would have beaten Discord's ~3s deadline.
 *
 * A Discord bot cannot invoke its own slash commands, and automating a user account to do
 * it would breach Discord's terms. But the transport is not what fails in production — the
 * bot fails to ACK because the event loop is busy. That is reproducible without Discord:
 * synthesize the interaction, run it through the same ensureDeferredEphemeralReply the
 * command uses, and time it against real work happening on the same loop.
 *
 * `deferReply` here stands in for the REST call, so the number this reports is the time the
 * interaction spent waiting for the loop — exactly the part that blows the budget. Real
 * network latency is additive on top, which makes this an optimistic measure, not a
 * pessimistic one.
 *
 *   pnpm exercise:interactions -- --writer=chunked --import-runs=800
 *   pnpm exercise:interactions -- --writer=unchunked --import-runs=800
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

function parseArg(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const importRuns = Number(parseArg('import-runs', '800'));
const writer = parseArg('writer', 'chunked');
const interactionCount = Number(parseArg('interactions', '12'));
const interactionEveryMs = Number(parseArg('interval', '150'));

const ACK_BUDGET_MS = 3000;

const sandbox = mkdtempSync(join(tmpdir(), 'exercise-'));
process.env.TRACKER_BOT_RXDB_STORAGE = 'localstorage';
process.env.TRACKER_BOT_RXDB_DATA_DIR = join(sandbox, 'rxdb');

const dist = join(__dirname, '..', 'dist');

/** Only the surface ensureDeferredEphemeralReply actually touches. */
function makeInteraction(index: number, onAck: (waitedMs: number) => void) {
  const createdTimestamp = Date.now();
  return {
    id: `interaction-${index}`,
    createdTimestamp,
    createdAt: new Date(createdTimestamp),
    type: 2,
    user: { id: `bystander-${index}` },
    deferred: false,
    replied: false,
    deferReply: async function deferReply() {
      // The wait before this runs is the loop time the interaction lost.
      onAck(Date.now() - createdTimestamp);
      (this as any).deferred = true;
    },
  } as any;
}

async function main(): Promise<void> {
  const { trackerRunPart1RxJsonSchema, trackerRunPart2RxJsonSchema } = require('@tmrxjd/platform/tools');
  const { ensureBotRunTrackerRxDatabase } = require(join(dist, 'rxdb', 'run-rxdb-store'));
  const { batchUpsertRunPartsToBotRxDB } = require(join(dist, 'rxdb', 'persistence'));
  const { ensureDeferredEphemeralReply } = require(join(dist, 'features', 'track', 'interaction-ack'));

  function buildDoc(schema: any, id: string, user: string, at: number) {
    const doc: any = { id, updatedAt: at, botScopeUserId: user, userId: user, username: user, createdAt: at, type: 'Farming' };
    for (const [key, def] of Object.entries<any>(schema.properties)) {
      if (key in doc) continue;
      const type = Array.isArray(def.type) ? def.type[0] : def.type;
      if (type === 'number' || type === 'integer') doc[key] = Math.round(Math.random() * 1e6);
    }
    return doc;
  }

  const importer = 'discord-importer';
  const db = await ensureBotRunTrackerRxDatabase(importer);

  const part1: any[] = [];
  const part2: any[] = [];
  for (let index = 0; index < importRuns; index += 1) {
    const at = Date.now() - index * 3_600_000;
    part1.push(buildDoc(trackerRunPart1RxJsonSchema, `${importer}-${index}`, importer, at));
    part2.push(buildDoc(trackerRunPart2RxJsonSchema, `${importer}-${index}`, importer, at));
  }

  const acks: { waitedMs: number; ok: boolean }[] = [];

  // Discord stamps an interaction when the user submits it, and it keeps ageing while the
  // bot is blocked. Firing from a loop on the same thread cannot model that: a blocked loop
  // never runs the loop that would create them, so they simply never arrive.
  //
  // Instead each arrival is scheduled up front, and the interaction is stamped with the
  // time it was DUE, not the time the callback finally ran. A timer that fires late because
  // the loop was busy therefore produces exactly the age Discord would have seen.
  const firstArrivalAt = Date.now() + 50;
  const firing = Promise.all(
    Array.from({ length: interactionCount }, (_, index) => {
      const dueAt = firstArrivalAt + index * interactionEveryMs;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          void (async () => {
            const interaction = makeInteraction(index, () => {});
            // Stamp with when it was due, as Discord would have.
            interaction.createdTimestamp = dueAt;
            interaction.createdAt = new Date(dueAt);
            const acknowledged = await ensureDeferredEphemeralReply(interaction);
            const waitedMs = Date.now() - dueAt;
            acks.push({ waitedMs, ok: acknowledged && waitedMs < ACK_BUDGET_MS });
            resolve();
          })();
        }, Math.max(0, dueAt - Date.now()));
      });
    }),
  );

  const importStartedAt = Date.now();
  if (writer === 'unchunked') {
    // The pre-fix write: one bulkUpsert per collection, both at once, no yields.
    await Promise.all([
      db.run_part_1.bulkUpsert(part1),
      db.run_part_2.bulkUpsert(part2),
    ]);
  } else {
    await batchUpsertRunPartsToBotRxDB(db, importer, part1, part2);
  }
  const importMs = Date.now() - importStartedAt;

  await firing;

  const waits = acks.map((ack) => ack.waitedMs);
  const worst = waits.length ? Math.max(...waits) : 0;
  const missed = acks.filter((ack) => !ack.ok).length;

  console.log(JSON.stringify({
    writer,
    importRuns,
    importMs,
    interactionsFired: acks.length,
    worstAckWaitMs: worst,
    medianAckWaitMs: waits.sort((a, b) => a - b)[Math.floor(waits.length / 2)] ?? 0,
    ackBudgetMs: ACK_BUDGET_MS,
    interactionsOverBudget: missed,
    verdict: missed > 0 ? 'WOULD FAIL WITH 10062' : 'all acknowledged in time',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('[exercise] failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* tmp */ }
    process.exit(process.exitCode ?? 0);
  });
