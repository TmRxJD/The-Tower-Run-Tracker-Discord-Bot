import type { AttachmentBuilder, Client, EmbedBuilder } from 'discord.js';
import { getLastRun, getUserSettings } from '../tracker-api-client';
import { getLocalRuns } from '../local-run-store';
import { getEffectiveUserSharedSettings } from '../../../services/user-shared-settings-db';
import { computeTrackerRunDeltaBaseline } from '@tmrxjd/platform/tools';
import { buildPerHourChartAttachment } from '../ui/per-hour-chart-helpers';
import { buildShareEmbed } from './share-embed';
import { resolveShareEmbedOptions } from './share-embed-options';
import { readShareSnapshot } from './share-snapshot-store';

export type SharedRunContext = {
  run: Record<string, unknown>;
  sharerName: string;
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
  const settings = await getUserSettings(userId).catch(() => null);
  const summary = await getLastRun(userId, { cloudSyncMode: 'none' }).catch(() => null);
  const allRuns = (summary?.allRuns ?? []) as Record<string, unknown>[];
  const runType = readTrimmedString(context.run.type) || 'Farming';

  const sharedSettings = await getEffectiveUserSharedSettings(userId).catch(() => ({ runDeltaMode: 'disabled' as const }));
  const deltaResult = sharedSettings.runDeltaMode !== 'disabled' && allRuns.length > 1
    ? computeTrackerRunDeltaBaseline(allRuns, runType, sharedSettings.runDeltaMode) ?? undefined
    : undefined;

  const embed = buildShareEmbed({
    user: {
      username: discordUser?.username ?? context.sharerName,
      displayName: context.sharerName,
      displayAvatarURL: discordUser ? () => discordUser.displayAvatarURL() : undefined,
    },
    run: context.run,
    runTypeCounts: summary?.runTypeCounts ?? {},
    deltaResult,
    options: resolveShareEmbedOptions(settings),
  });

  const chartAttachment = settings?.shareChart !== false && allRuns.length >= 2
    ? await buildPerHourChartAttachment(allRuns, runType).catch(() => null)
    : null;
  if (chartAttachment) embed.setImage('attachment://per-hour-chart.png');

  return { embed, files: chartAttachment ? [chartAttachment] : [] };
}
