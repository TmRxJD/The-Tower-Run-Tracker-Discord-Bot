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

/**
 * Build a per-hour rolling average chart attachment for a given run type.
 * Returns null if there is insufficient data (fewer than 2 runs).
 */
export async function buildPerHourChartAttachment(
  allRuns: Record<string, unknown>[],
  runType: string,
): Promise<AttachmentBuilder | null> {
  const sameType = allRuns
    .filter(r => String(r.type ?? 'Farming').trim().toLowerCase() === runType.trim().toLowerCase())
    .sort((a, b) => resolveRunTimestamp(a) - resolveRunTimestamp(b));

  const sliced = sameType.slice(-30);
  if (sliced.length < 2) return null;

  const labels = sliced.map(r => {
    const raw = String(r.date ?? r.runDate ?? '').trim()
    return raw.length >= 10 ? raw.slice(5, 10) : raw || `${sliced.indexOf(r) + 1}`
  })
  const coinsData: (number | null)[] = sliced.map(r => toNum(r.coinsPerHour) ?? perHour(r.totalCoins ?? r.coins, r));
  const cellsData: (number | null)[] = sliced.map(r => toNum(r.cellsPerHour) ?? perHour(r.totalCells ?? r.cells, r));
  const diceData: (number | null)[] = sliced.map(r =>
    toNum(r.rerollShardsPerHour ?? r.dicePerHour) ?? perHour(r.totalDice ?? r.rerollShards ?? r.dice, r),
  );
  const shardsData: (number | null)[] = sliced.map(r => { const s = moduleShards(r); return s > 0 ? perHour(s, r) : null; });

  const datasets = [
    ...(coinsData.some(v => v !== null)
      ? [{ label: 'Coins Per Hour', values: coinsData, color: '#F9A825' }]
      : []),
    ...(cellsData.some(v => v !== null)
      ? [{ label: 'Cells Per Hour', values: cellsData, color: '#4CAF50' }]
      : []),
    ...(diceData.some(v => v !== null)
      ? [{ label: 'Dice Per Hour', values: diceData, color: '#F44336' }]
      : []),
    ...(shardsData.some(v => v !== null)
      ? [{ label: 'Shards Per Hour', values: shardsData, color: '#42A5F5' }]
      : []),
  ];

  if (datasets.length === 0) return null;

  try {
    const png = await renderAnalyticsLineChartPng(
      { title: 'Rolling Avg (7 Days) Per-Hour', labels, datasets, width: 900, height: 380, separateAxes: true },
      runtime,
    );
    return new AttachmentBuilder(Buffer.from(png), { name: 'per-hour-chart.png' });
  } catch {
    return null;
  }
}
