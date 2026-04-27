import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { getPendingRun } from '../pending-run-store';
import { toPendingRecord, type PendingRecordLike } from '../shared/track-review-records';
import { parseTrackerToken } from '../track-custom-ids';

export type ReviewInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export function ensureType(value: unknown) {
  if (!value) return 'Farming';
  const text = String(value).trim();
  const allowed = ['Farming', 'Overnight', 'Tournament', 'Milestone', 'Dissonance'];
  const match = allowed.find((option) => option.toLowerCase() === text.toLowerCase());
  return match || 'Farming';
}

export function isTrackReviewFlowEnabled(userId: string) {
  return getTrackerFlowMode(userId) === 'track';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isTrackReplyLike(value: unknown): value is TrackReplyInteractionLike {
  if (!isRecord(value)) {
    return false;
  }

  const record = value;
  const user = isRecord(record.user) ? record.user : null;
  return typeof record.user === 'object'
    && record.user !== null
    && !!user
    && typeof user.id === 'string'
    && typeof user.username === 'string'
    && typeof record.deferReply === 'function'
    && typeof record.reply === 'function'
    && typeof record.editReply === 'function';
}

export function asTrackReplyInteraction(interaction: unknown): TrackReplyInteractionLike {
  if (!isTrackReplyLike(interaction)) {
    throw new Error('Interaction does not satisfy the tracker reply contract');
  }

  return interaction;
}

export async function updateReviewMessage(interaction: ReviewInteraction, content: string) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
}

export async function resolveOwnedPendingInteraction(
  interaction: ReviewInteraction,
  options?: { token?: string; invalidMessage?: string; expiredMessage?: string },
): Promise<{ token: string; pending: PendingRecordLike } | null> {
  const token = options?.token ?? resolvePendingToken(interaction);
  if (!token) {
    await updateReviewMessage(interaction, options?.invalidMessage ?? getTrackUiConfig().manual.sessionExpired);
    return null;
  }

  const pending = toPendingRecord(await getPendingRun(token));
  if (!pending || pending.userId !== interaction.user.id) {
    await updateReviewMessage(interaction, options?.expiredMessage ?? getTrackUiConfig().manual.sessionExpired);
    return null;
  }

  return { token, pending };
}

function resolvePendingToken(interaction: ReviewInteraction): string | null {
  return parseTrackerToken(interaction.customId || '');
}