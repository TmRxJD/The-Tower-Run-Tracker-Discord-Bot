import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { TRACKER_IDS, withToken, withTokenAndField } from '../track-custom-ids';
import { toPendingRecord, type PendingRecordLike, type RunDataRecord } from '../shared/track-review-records';
import { applyEditFieldValue, buildReviewPayload, getCurrentEditFieldValue } from '../ui/tracker-review-payloads';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { ensureType, isTrackReviewFlowEnabled, type ReviewInteraction, updateReviewMessage } from './review-interaction-helpers';

type BuildReviewNoteModalInput = {
  token: string;
  title: string;
  label: string;
  placeholder: string;
  currentNote?: unknown;
};

type BuildReviewEditFieldModalInput = {
  token: string;
  title: string;
  selectedFields: string[];
  labels: Record<string, string>;
  runData: RunDataRecord;
};

export function getSelectedReviewValue(interaction: ReviewInteraction): string | null {
  if ('values' in interaction && Array.isArray(interaction.values) && interaction.values[0]) {
    return interaction.values[0];
  }
  const value = (interaction as unknown as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

export function getSelectedReviewFields(interaction: ReviewInteraction): string[] {
  const selectedFieldsRaw = ('values' in interaction && Array.isArray(interaction.values))
    ? interaction.values
    : [];
  return Array.from(new Set(selectedFieldsRaw)).slice(0, 5);
}

export function buildReviewNoteModal(input: BuildReviewNoteModalInput): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(withToken(TRACKER_IDS.review.noteModalPrefix, input.token))
    .setTitle(input.title);
  const noteInput = new TextInputBuilder()
    .setCustomId(TRACKER_IDS.review.noteText)
    .setLabel(input.label)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder(input.placeholder)
    .setValue(String(input.currentNote || ''));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
  return modal;
}

export function buildReviewEditFieldModal(input: BuildReviewEditFieldModalInput): {
  modal: ModalBuilder;
  modalFieldList: string;
} {
  const modalFieldList = input.selectedFields.join(',');
  const modal = new ModalBuilder()
    .setCustomId(withTokenAndField(TRACKER_IDS.review.editModalPrefix, input.token, modalFieldList))
    .setTitle(input.title);

  input.selectedFields.forEach((field, index) => {
    const currentValue = getCurrentEditFieldValue(input.runData, field);
    const editInput = new TextInputBuilder()
      .setCustomId(`${TRACKER_IDS.review.editValue}_${index}`)
      .setLabel(input.labels[field] ?? field)
      .setStyle(field === 'notes' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field !== 'notes')
      .setValue(currentValue.slice(0, 4000));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(editInput));
  });

  return {
    modal,
    modalFieldList,
  };
}

export function applySubmittedReviewEditValues(
  runData: RunDataRecord,
  selectedFields: string[],
  getFieldValue: (field: string, index: number) => string,
): RunDataRecord {
  let nextRunData = { ...runData };
  selectedFields.forEach((field, index) => {
    nextRunData = applyEditFieldValue(nextRunData, field, getFieldValue(field, index));
  });
  return nextRunData;
}

export function resolveUpdatedPendingRecord(updated: unknown): PendingRecordLike | null {
  return toPendingRecord(updated);
}

export async function replyWithReviewSessionExpired(
  interaction: Pick<ReviewInteraction, 'editReply'>,
  message: string,
): Promise<void> {
  await interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
}

export async function resolveUpdatedPendingOrReplyExpired(
  interaction: Pick<ReviewInteraction, 'editReply'>,
  updated: unknown,
  message: string,
): Promise<PendingRecordLike | null> {
  const updatedPending = resolveUpdatedPendingRecord(updated);
  if (updatedPending) {
    return updatedPending;
  }

  await replyWithReviewSessionExpired(interaction, message);
  return null;
}

export async function resolveUpdatedPendingOrUpdateReviewMessage(
  interaction: ReviewInteraction,
  updated: unknown,
  message: string,
): Promise<PendingRecordLike | null> {
  const updatedPending = resolveUpdatedPendingRecord(updated);
  if (updatedPending) {
    return updatedPending;
  }

  await updateReviewMessage(interaction, message);
  return null;
}

export function buildCurrentReviewReplyPayload(
  token: string,
  pending: PendingRecordLike,
  label?: string,
) {
  return buildReviewPayload({
    token,
    pending,
    label,
    includeType: isTrackReviewFlowEnabled(pending.userId),
    includeNotes: isTrackReviewFlowEnabled(pending.userId),
    selectedType: ensureType(pending.runData.type || pending.defaultRunType),
  });
}

export function buildTypeSelectionReviewReplyPayload(
  token: string,
  pending: PendingRecordLike,
  nextType: string,
) {
  return buildCurrentReviewReplyPayload(token, {
    ...pending,
    runData: {
      ...pending.runData,
      type: nextType,
    },
  });
}

export async function renderUpdatedReviewAfterNote(
  interaction: TrackReplyInteractionLike,
  token: string,
  pending: PendingRecordLike,
  returnMode: 'review' | 'edit',
  renderEditFieldPicker: (
    interaction: TrackReplyInteractionLike,
    token: string,
    pending: PendingRecordLike,
    mode: 'update' | 'editReply',
  ) => Promise<void>,
): Promise<void> {
  if (returnMode === 'edit') {
    await renderEditFieldPicker(interaction, token, pending, 'editReply');
    return;
  }

  await interaction.editReply(buildCurrentReviewReplyPayload(token, pending)).catch(() => {});
}

export async function renderDataReviewOrSubmit(
  interaction: TrackReplyInteractionLike,
  token: string,
  pending: PendingRecordLike,
  label: string,
  getUserSettings: (userId: string) => Promise<{ confirmBeforeSubmit?: boolean } | null>,
  submitPendingRun: (interaction: ReviewInteraction, token: string, pending: PendingRecordLike) => Promise<void>,
): Promise<void> {
  const settings = await getUserSettings(pending.userId).catch(() => null);
  const shouldConfirmBeforeSubmit = settings?.confirmBeforeSubmit !== false;
  if (!shouldConfirmBeforeSubmit) {
    await submitPendingRun(interaction as ReviewInteraction, token, pending);
    return;
  }

  await interaction.editReply({
    ...buildCurrentReviewReplyPayload(token, pending, label),
    files: [],
  }).catch(() => {});
}