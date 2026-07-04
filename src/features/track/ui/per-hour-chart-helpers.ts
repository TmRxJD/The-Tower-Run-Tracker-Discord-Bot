import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  createNapiRsCanvasChartRenderRuntime,
  renderAnalyticsLineChartPng,
} from '@tmrxjd/platform/tools';
import { logger } from '../../../core/logger';
import { parseDurationToHours, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';

const runtime = createNapiRsCanvasChartRenderRuntime((w, h) => createCanvas(w, h));

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = parseNumberInput(standardizeNotation(String(val)));
  return Number.isFinite(n) ? n : null;
}

function toDurationHours(run: Record<string, unknown>): number | null {
  const hours = parseDurationToHours(String(run.roundDuration ?? run.duration ?? ''));
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours;
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

function parseTimestampCandidate(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveRunTimestamp(run: Record<string, unknown>): number {
  const runDateTime = run.runDateTime;
  if (runDateTime && typeof runDateTime === 'object' && !Array.isArray(runDateTime)) {
    const nested = runDateTime as Record<string, unknown>;
    const nestedTs = resolveRunTimestamp({
      date: nested.date ?? nested.runDate,
      time: nested.time ?? nested.runTime,
      runDate: nested.date ?? nested.runDate,
      runTime: nested.time ?? nested.runTime,
    });
    if (nestedTs > 0) return nestedTs;
    for (const candidate of [nested.full, nested.combined]) {
      const parsed = parseTimestampCandidate(candidate);
      if (parsed > 0) return parsed;
    }
  }

  const dateStr = String(run.runDate ?? run.date ?? '').trim();
  const timeStr = String(run.runTime ?? run.time ?? '').trim();
  if (dateStr || timeStr) {
    const parsed = parseTimestampCandidate(`${dateStr} ${timeStr}`.trim());
    if (parsed > 0) return parsed;

    const mdy = dateStr.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
    if (mdy) {
      const month = Number(mdy[1]);
      const day = Number(mdy[2]);
      const year = Number(mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3]);
      if (Number.isFinite(month) && Number.isFinite(day) && Number.isFinite(year)) {
        const isoLikeDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const normalized = parseTimestampCandidate(`${isoLikeDate} ${timeStr}`.trim());
        if (normalized > 0) return normalized;
      }
    }
  }

  for (const candidate of [
    run.updatedAt,
    run.createdAt,
    run.reportTimestamp,
    run.timestamp,
    run['Battle Date'],
    run.battleDate,
  ]) {
    const parsed = parseTimestampCandidate(candidate);
    if (parsed > 0) return parsed;
  }

  return 0;
}

/** Return the ISO date string (YYYY-MM-DD) for a timestamp, or null. */
function toDateKey(ts: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function normalizeRunDateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return `${iso[1]}-${String(parseInt(iso[2], 10)).padStart(2, '0')}-${String(parseInt(iso[3], 10)).padStart(2, '0')}`;
  }
  const mdy = trimmed.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year}-${String(parseInt(mdy[1], 10)).padStart(2, '0')}-${String(parseInt(mdy[2], 10)).padStart(2, '0')}`;
  }
  return trimmed;
}

/** Prefer in-game run date for day buckets; fall back to resolved timestamp UTC day. */
function toChartDayKey(run: Record<string, unknown>): string | null {
  const gameDateKey = normalizeRunDateKey(String(run.runDate ?? run.date ?? ''));
  if (gameDateKey) return gameDateKey;
  const ts = resolveRunTimestamp(run);
  return ts > 0 ? toDateKey(ts) : null;
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
 * Returns null if there is insufficient data (fewer than 2 active days in the window).
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

  // Group runs by game calendar day (runs are already limited to the rolling 7-day window).
  const byDay = new Map<string, Record<string, unknown>[]>();
  for (const r of sameType) {
    const key = toChartDayKey(r);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(r);
  }

  const activeKeys = [...byDay.keys()].sort();
  if (activeKeys.length < 2) return null;

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
  } catch (error) {
    logger.warn('buildPerHourChartAttachment render failed', error);
    return null;
  }
}

export async function resolveMainMenuPerHourChartAttachment(
  allRuns: Record<string, unknown>[],
  preferredRunType: string,
): Promise<{ attachment: AttachmentBuilder | null; runType: string }> {
  const normalizedPreferred = preferredRunType.trim() || 'Farming';
  const tryTypes = [normalizedPreferred];
  for (const run of allRuns) {
    const type = String(run.type ?? 'Farming').trim() || 'Farming';
    if (!tryTypes.some(existing => existing.toLowerCase() === type.toLowerCase())) {
      tryTypes.push(type);
    }
  }

  for (const runType of tryTypes) {
    const attachment = await buildPerHourChartAttachment(allRuns, runType).catch(error => {
      logger.warn('resolveMainMenuPerHourChartAttachment build failed', { runType, error });
      return null;
    });
    if (attachment) {
      return { attachment, runType };
    }
  }

  return { attachment: null, runType: normalizedPreferred };
}

export async function resolvePerHourChartReplyFiles(
  allRuns: Record<string, unknown>[],
  runType: string,
  options?: { enabled?: boolean },
): Promise<AttachmentBuilder[]> {
  if (options?.enabled === false) return [];
  if (!allRuns.length) return [];
  const chartAttachment = await buildPerHourChartAttachment(allRuns, runType).catch(() => null);
  return chartAttachment ? [chartAttachment] : [];
}

export function applyPerHourChartImage(embed: EmbedBuilder, chartFiles: readonly AttachmentBuilder[]): void {
  if (chartFiles.length > 0) {
    embed.setImage('attachment://per-hour-chart.png');
  }
}

export function buildPerHourChartEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2196f3)
    .setTitle('7-Day Per-Hour Trend')
    .setImage('attachment://per-hour-chart.png');
}
