import { AttachmentBuilder } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  createNapiRsCanvasChartRenderRuntime,
  renderAnalyticsLineChartPng,
} from '@tmrxjd/platform/tools';
import { parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';

const runtime = createNapiRsCanvasChartRenderRuntime((w, h) => createCanvas(w, h));

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = parseNumberInput(standardizeNotation(String(val)));
  return Number.isFinite(n) ? n : null;
}

function toDurationHours(run: Record<string, unknown>): number | null {
  const raw = String(run.roundDuration ?? run.duration ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) / 3600;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) / 3600;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n / 3600 : null;
}

function perHour(metric: unknown, run: Record<string, unknown>): number | null {
  const val = toNum(metric);
  const dur = toDurationHours(run);
  if (val === null || dur === null || dur <= 0) return null;
  return val / dur;
}

function moduleShards(run: Record<string, unknown>): number {
  return (toNum(run.cannonShardsFetched) ?? 0)
    + (toNum(run.armorShardsFetched) ?? 0)
    + (toNum(run.generatorShardsFetched) ?? 0)
    + (toNum(run.coreShardsFetched) ?? 0);
}

function resolveRunTimestamp(run: Record<string, unknown>): number {
  const dateStr = String(run.date ?? run.runDate ?? '').trim();
  const timeStr = String(run.time ?? run.runTime ?? '').trim();
  if (!dateStr) return 0;
  const combined = timeStr ? `${dateStr} ${timeStr}` : dateStr;
  const parsed = Date.parse(combined);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Return the ISO date string (YYYY-MM-DD) for a timestamp, or null. */
function toDateKey(ts: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

/** Average an array of numbers, ignoring nulls. Returns null if no values. */
function avgOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Build a per-hour 7-day trend chart attachment for a given run type.
 * Groups runs by calendar day over the last 7 days and plots daily averages,
 * showing trend/momentum rather than raw historical run counts.
 * Returns null if there is insufficient data (fewer than 2 distinct days with data).
 */
export async function buildPerHourChartAttachment(
  allRuns: Record<string, unknown>[],
  runType: string,
): Promise<AttachmentBuilder | null> {
  const nowMs = Date.now();
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

  const sameType = allRuns
    .filter(r => String(r.type ?? 'Farming').trim().toLowerCase() === runType.trim().toLowerCase())
    .filter(r => {
      const ts = resolveRunTimestamp(r);
      return ts > 0 && ts >= sevenDaysAgoMs;
    })
    .sort((a, b) => resolveRunTimestamp(a) - resolveRunTimestamp(b));

  if (sameType.length < 1) return null;

  // Build ordered list of the 7 calendar days (today and the 6 before it)
  const dayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  // Group runs by calendar day
  const byDay = new Map<string, Record<string, unknown>[]>();
  for (const r of sameType) {
    const key = toDateKey(resolveRunTimestamp(r));
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(r);
  }

  const daysWithData = dayKeys.filter(k => byDay.has(k));
  if (daysWithData.length < 2) return null;

  // Only chart days that have actual run data — no empty slots
  const activeKeys = daysWithData;
  const labels = activeKeys.map(k => k.slice(5)); // MM-DD

  function dailyAvg(key: string, fn: (r: Record<string, unknown>) => number | null): number | null {
    const runs = byDay.get(key);
    if (!runs || runs.length === 0) return null;
    const vals = runs.map(fn).filter((v): v is number => v !== null);
    return avgOf(vals);
  }

  const coinsData: (number | null)[] = activeKeys.map(k =>
    dailyAvg(k, r => toNum(r.coinsPerHour) ?? perHour(r.totalCoins ?? r.coins, r)),
  );
  const cellsData: (number | null)[] = activeKeys.map(k =>
    dailyAvg(k, r => toNum(r.cellsPerHour) ?? perHour(r.totalCells ?? r.cells, r)),
  );
  const diceData: (number | null)[] = activeKeys.map(k =>
    dailyAvg(k, r => toNum(r.rerollShardsPerHour ?? r.dicePerHour) ?? perHour(r.totalDice ?? r.rerollShards ?? r.dice, r)),
  );
  const shardsData: (number | null)[] = activeKeys.map(k =>
    dailyAvg(k, r => { const s = moduleShards(r); return s > 0 ? perHour(s, r) : null; }),
  );

  // Order: [Coins, Dice, Cells, Shards] so that the renderer's alternating left/right
  // axis assignment (even=left, odd=right) places Coins+Cells on the left and Dice+Shards on the right.
  // legendOrder remaps display to [Coins, Cells, Dice, Shards].
  const datasets = [
    ...(coinsData.some(v => v !== null)
      ? [{ label: 'Coins/hr', values: coinsData, color: '#F9A825' }]
      : []),
    ...(diceData.some(v => v !== null)
      ? [{ label: 'Dice/hr', values: diceData, color: '#F44336' }]
      : []),
    ...(cellsData.some(v => v !== null)
      ? [{ label: 'Cells/hr', values: cellsData, color: '#4CAF50' }]
      : []),
    ...(shardsData.some(v => v !== null)
      ? [{ label: 'Shards/hr', values: shardsData, color: '#42A5F5' }]
      : []),
  ];

  if (datasets.length === 0) return null;

  // Build legendOrder: indices into datasets that produce display order [Coins, Cells, Dice, Shards].
  // Dataset build order is [Coins(0), Dice(1), Cells(2), Shards(3)] when all four are present.
  // Map label names back to their indices for robustness when some metrics are absent.
  const labelToIdx = new Map(datasets.map((ds, i) => [ds.label, i]));
  const legendOrder = ['Coins/hr', 'Cells/hr', 'Dice/hr', 'Shards/hr']
    .map(l => labelToIdx.get(l))
    .filter((i): i is number => i !== undefined);

  try {
    const png = await renderAnalyticsLineChartPng(
      { title: '7-Day Per-Hour Trend', labels, datasets, width: 900, height: 380, separateAxes: true, legendOrder },
      runtime,
    );
    return new AttachmentBuilder(Buffer.from(png), { name: 'per-hour-chart.png' });
  } catch {
    return null;
  }
}
