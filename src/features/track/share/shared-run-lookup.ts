import { AttachmentBuilder, type Client, type EmbedBuilder } from 'discord.js';
import { appendCapturedHistoryFooter } from './captured-history-footer';
import { getLastRun, getUserSettings } from '../tracker-api-client';
import { getLocalRuns } from '../local-run-store';
import { getEffectiveUserSharedSettings } from '../../../services/user-shared-settings-db';
import { type TrackerRunDeltaResult, computeTrackerRunDeltaBaseline } from '@tmrxjd/platform/tools';
import { buildPerHourChartAttachment } from '../ui/per-hour-chart-helpers';
import { buildShareEmbed } from './share-embed';
import { resolveShareEmbedOptions } from './share-embed-options';
import { readShareSnapshot } from './share-snapshot-store';

export type SharedRunContext = {
  run: Record<string, unknown>;
  sharerName: string;
  runTypeCounts?: Record<string, number>;
  historyVerified?: boolean;
  historyCapturedAt?: number;
  chartBase64?: string;
  deltaResult?: TrackerRunDeltaResult | null;
};

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function findSharedRun(userId: string, runRef: string): Promise<Record<string, unknown> | null> {
  const runs = await getLocalRuns(userId).catch(() => []);
  const match = runs.find(run => readTrimmedString(run.localId) === runRef || readTrimmedString(run.runId) === runRef);
  return match ? { ...match } : null;
}

async function resolveSharerName(client: Client, userId: string, run: Record<string, unknown>): Promise<string> {
  const discordUser = await client.users.fetch(userId).catch(() => null);
  return readTrimmedString(discordUser?.globalName)
    || readTrimmedString(discordUser?.username)
    || readTrimmedString(run.username);
}

/**
 * Re-reads the shared run so the buttons keep working indefinitely: the live run store is
 * preferred (freshest, richest data), with a durable snapshot as the permanent fallback for
 * when the run was deleted or this process never had it.
 */
export async function resolveSharedRunContext(client: Client, userId: string, runRef: string): Promise<SharedRunContext | null> {
  if (/^S-[a-f0-9]{32}$/.test(runRef)) {
    const snapshot = await readShareSnapshot(`${userId}:${runRef}`);
    if (!snapshot || snapshot.userId !== userId || snapshot.ref !== `${userId}:${runRef}`) return null;
    return { run: { ...snapshot.run }, sharerName: snapshot.sharerName || 'Unknown', runTypeCounts: snapshot.runTypeCounts, historyVerified: snapshot.historyVerified, deltaResult: snapshot.deltaResult,
      historyCapturedAt: snapshot.historyCapturedAt, chartBase64: snapshot.chartBase64 };
  }
  // Legacy posted buttons retain their existing lookup semantics; do not rewrite old posts.
  let run = await findSharedRun(userId, runRef);
  let snapshotName: string | undefined;

  if (!run) {
    const snapshot = await readShareSnapshot(`${userId}:${runRef}`);
    run = snapshot?.run ? { ...snapshot.run } : null;
    snapshotName = snapshot?.sharerName;
  }

  if (!run) return null;

  const sharerName = await resolveSharerName(client, userId, run) || snapshotName || 'Unknown';
  return { run, sharerName };
}

/** Rebuilds the full (uncollapsed) share exactly as the sharer's settings render it, chart included. */
export async function buildExpandedSharePayload(
  client: Client,
  userId: string,
  context: SharedRunContext,
): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  const discordUser = await client.users.fetch(userId).catch(() => null);
  const settings = await getUserSettings(userId, { localOnly: true }).catch(() => null);
  const summary = await getLastRun(userId, { cloudSyncMode: 'none' }).catch(() => null);
  const allRuns = (summary?.allRuns ?? []) as Record<string, unknown>[];
  const runType = readTrimmedString(context.run.type) || 'Farming';

  const sharedSettings = await getEffectiveUserSharedSettings(userId, { localOnly: true }).catch(() => ({ runDeltaMode: 'disabled' as const }));
  const calculatedDelta = Object.keys(context.runTypeCounts ?? {}).length > 0 && sharedSettings.runDeltaMode !== 'disabled' && allRuns.length > 1
    ? computeTrackerRunDeltaBaseline(allRuns, runType, sharedSettings.runDeltaMode, undefined, context.run) ?? undefined
    : undefined;

  const deltaResult = context.deltaResult !== undefined ? context.deltaResult ?? undefined : calculatedDelta;
  const embed = buildShareEmbed({
    user: {
      username: discordUser?.username ?? context.sharerName,
      displayName: context.sharerName,
      displayAvatarURL: discordUser ? () => discordUser.displayAvatarURL() : undefined,
    },
    run: context.run,
    runTypeCounts: context.runTypeCounts ?? summary?.runTypeCounts ?? {},
    deltaResult,
    options: resolveShareEmbedOptions(settings),
  });

  if (context.historyVerified === false) {
    embed.setTitle(embed.data.title + ' (locally saved)');
    embed.setFooter({ text: 'Offline fallback: counts and comparisons use saved history and pending runs.' });
  }
  appendCapturedHistoryFooter(embed, context.historyCapturedAt);
  const capturedChart = context.chartBase64 && context.chartBase64.length <= 4 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(context.chartBase64)
    ? new AttachmentBuilder(Buffer.from(context.chartBase64, 'base64'), { name: 'per-hour-chart.png' }) : null;
  const chartAttachment = settings?.shareChart === false ? null : context.historyCapturedAt !== undefined ? capturedChart
    : allRuns.length >= 2 ? await buildPerHourChartAttachment(allRuns, runType).catch(() => null) : null;
  if (chartAttachment) embed.setImage('attachment://per-hour-chart.png');

  return { embed, files: chartAttachment ? [chartAttachment] : [] };
}
