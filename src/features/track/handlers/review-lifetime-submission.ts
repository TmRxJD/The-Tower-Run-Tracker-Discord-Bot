import { saveLifetimeEntry } from '../tracker-api-client';
import { deletePendingRun } from '../pending-run-store';
import { createSuccessButtons } from '../ui/tracker-ui';
import { buildLifetimeSubmissionResultEmbed } from '../ui/tracker-submission-embeds';
import type { TrackerBotClient } from '../../../core/tracker-bot-client';
import type { PendingRecordLike, RunDataRecord } from '../shared/track-review-records';
import { ANALYTICS_EVENT_LIFETIME_TRACKER_UPLOAD } from '@tmrxjd/platform/tools';
import type { ReviewInteraction } from './review-interaction-helpers';

type LifetimeUiMessages = {
  cloudUnavailable: string;
};

type LifetimeResult = {
  allEntries?: unknown[];
  cloudUnavailable?: boolean;
};

export function buildLifetimeEntryPayload(pending: PendingRecordLike) {
  const screenshotUrl = pending.screenshot?.url ?? null;

  return {
    entryData: {
      ...pending.runData,
      date: pending.runData.date ?? new Date().toISOString().split('T')[0],
    },
    entryId: typeof pending.runData.runId === 'string' ? pending.runData.runId : undefined,
    screenshotUrl,
  };
}

export function buildLifetimeSubmissionArtifacts(params: {
  pending: PendingRecordLike;
  lifetimeResult: LifetimeResult;
  screenshotUrl: string | null;
}) {
  const allEntries = Array.isArray(params.lifetimeResult.allEntries) ? params.lifetimeResult.allEntries : [];
  const latest = allEntries[0] && typeof allEntries[0] === 'object'
    ? allEntries[0] as RunDataRecord
    : params.pending.runData;
  const hasScreenshot = Boolean(params.screenshotUrl);
  const embed = buildLifetimeSubmissionResultEmbed({
    data: latest,
    isUpdate: Boolean(params.pending.runData?.runId),
    totalEntries: allEntries.length,
    hasScreenshot,
  });
  const files = hasScreenshot && params.screenshotUrl
    ? [{ attachment: params.screenshotUrl, name: 'screenshot.png' }]
    : [];

  return { embed, files };
}

export async function submitLifetimePendingRun(params: {
  interaction: ReviewInteraction;
  pending: PendingRecordLike;
  token: string;
  userId: string;
  username: string;
  uiMessages: LifetimeUiMessages;
}) {
  const payload = buildLifetimeEntryPayload(params.pending);
  const lifetimeResult = await saveLifetimeEntry({
    userId: params.userId,
    username: params.username,
    ...payload,
  });

  const { embed, files } = buildLifetimeSubmissionArtifacts({
    pending: params.pending,
    lifetimeResult,
    screenshotUrl: payload.screenshotUrl,
  });

  await params.interaction.editReply({ content: undefined, embeds: [embed], components: createSuccessButtons(), files }).catch(() => {
    return params.interaction.editReply({ content: undefined, embeds: [embed], components: createSuccessButtons(), files: [] });
  });

  if (lifetimeResult.cloudUnavailable) {
    await params.interaction.editReply({ content: params.uiMessages.cloudUnavailable }).catch(() => {});
  }

  const trackerClient = params.interaction.client as TrackerBotClient;
  void trackerClient.persistence?.analytics.log({
    ts: new Date().toISOString(),
    event: ANALYTICS_EVENT_LIFETIME_TRACKER_UPLOAD,
    userId: params.userId,
    guildId: params.interaction.guildId ?? undefined,
    commandName: 'lifetime',
  }).catch(() => {});

  await deletePendingRun(params.token);
}