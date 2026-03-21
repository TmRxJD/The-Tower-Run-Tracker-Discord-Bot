import { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { editRun, getLocalRunSummary, getUserSettings, logRun } from '../tracker-api-client';
import { createSuccessButtons, createLoadingEmbed } from '../ui/tracker-ui';
import { buildEditFieldPickerPayload } from '../ui/tracker-review-payloads';
import { buildSubmissionResultEmbed } from '../ui/tracker-submission-embeds';
import { handleError } from './error-handlers';
import { buildSubmitPayload, sendRawParseMessage } from './review-data-helpers';
import { asTrackReplyInteraction, ensureType, isTrackReviewFlowEnabled, resolveOwnedPendingInteraction, type ReviewInteraction, updateReviewMessage } from './review-interaction-helpers';
import { applySubmittedReviewEditValues, buildCurrentReviewReplyPayload, buildReviewEditFieldModal, buildReviewNoteModal, buildTypeSelectionReviewReplyPayload, getSelectedReviewFields, getSelectedReviewValue, renderDataReviewOrSubmit, renderUpdatedReviewAfterNote, resolveUpdatedPendingOrReplyExpired, resolveUpdatedPendingOrUpdateReviewMessage } from './review-edit-modal-helpers';
import { submitLifetimePendingRun } from './review-lifetime-submission';
import { buildCanonicalRunData, buildCoverageSource, buildRunTypeCounts, buildShareableRunPayload, buildSubmitRunData, resolveDuplicateRunInfo, resolveScreenshotUrl, resolveSubmissionIds, type LocalRunSummary, type SubmissionSyncResult } from './review-submission-helpers';
import { updatePendingRun, deletePendingRun } from '../pending-run-store';
import { TRACKER_IDS, withToken, withTokenAndField } from '../track-custom-ids';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import { setShareableRun } from '../share/share-state';
import { autoShareToConfiguredLogChannel } from '../share/auto-log-channel-share';
import type { TrackerBotClient } from '../../../core/tracker-bot-client';
import type { PendingRecordLike } from '../shared/track-review-records';
import { ANALYTICS_EVENT_RUN_TRACKER_UPLOAD } from '@tmrxjd/platform/tools';

function reviewUi() {
  return getTrackUiConfig().review;
}

export async function renderDataReview(interaction: TrackReplyInteractionLike, token: string, pending: PendingRecordLike, label: string = 'Extracted') {
  await renderDataReviewOrSubmit(interaction, token, pending, label, getUserSettings, submitPendingRun);
}

export async function handleTypeSelection(interaction: ReviewInteraction) {
  try {
    const component = interaction as MessageComponentInteraction;
    const typeRaw = getSelectedReviewValue(interaction);
    const resolved = await resolveOwnedPendingInteraction(interaction);
    if (!resolved) {
      return;
    }
    const { token, pending } = resolved;
    if (!isTrackReviewFlowEnabled(pending.userId)) {
      await interaction.deferUpdate().catch(() => {});
      await renderDataReview(asTrackReplyInteraction(component), token, pending);
      return;
    }
    const nextType = ensureType(typeRaw);
    const updated = await updatePendingRun(token, { runData: { ...pending.runData, type: nextType } });
    const updatedPending = await resolveUpdatedPendingOrUpdateReviewMessage(interaction, updated, getTrackUiConfig().manual.sessionExpired);
    if (!updatedPending) {
      return;
    }
    await component.update(buildTypeSelectionReviewReplyPayload(token, updatedPending, nextType)).catch(() => {});
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'type_selection' });
  }
}

export async function handleShowFullParse(interaction: ReviewInteraction) {
  try {
    const resolved = await resolveOwnedPendingInteraction(interaction);
    if (!resolved) {
      return;
    }
    const { pending } = resolved;

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    await sendRawParseMessage(asTrackReplyInteraction(interaction), pending.runData, 'Full Parse');
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'show_full_parse' });
  }
}

export async function handleAddNote(interaction: ReviewInteraction) {
  await handleNoteModal(interaction, 'review');
}

export async function handleEditNotesRequest(interaction: ReviewInteraction) {
  await handleNoteModal(interaction, 'edit');
}

async function handleNoteModal(interaction: ReviewInteraction, returnMode: 'review' | 'edit') {
  try {
    const ui = reviewUi();
    const component = interaction as MessageComponentInteraction;
    const resolved = await resolveOwnedPendingInteraction(interaction);
    if (!resolved) {
      return;
    }
    const { token, pending } = resolved;

    const currentNote = pending.runData?.notes || pending.runData?.note || '';
    const modal = buildReviewNoteModal({
      token,
      title: ui.modals.addNoteTitle,
      label: ui.modals.noteLabel,
      placeholder: ui.modals.notePlaceholder,
      currentNote,
    });

    await component.showModal(modal);

    const submitted = await component.awaitModalSubmit({
      filter: (i: ModalSubmitInteraction) => i.customId === withToken(TRACKER_IDS.review.noteModalPrefix, token) && i.user.id === interaction.user.id,
      time: 300_000,
    });
    try {
      await submitted.deferUpdate();
    } catch {
      /* already acknowledged or expired */
    }
    const noteValue = submitted.fields.getTextInputValue(TRACKER_IDS.review.noteText) || '';
    const updated = await updatePendingRun(token, { runData: { ...pending.runData, notes: noteValue } });
    const updatedPending = await resolveUpdatedPendingOrReplyExpired(component, updated, getTrackUiConfig().manual.sessionExpired);
    if (!updatedPending) {
      return;
    }

    await renderUpdatedReviewAfterNote(asTrackReplyInteraction(component), token, updatedPending, returnMode, renderEditFieldPicker);
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: returnMode === 'edit' ? 'edit_note' : 'add_note' });
  }
}

export async function handleCancel(interaction: ReviewInteraction) {
  const component = interaction as MessageComponentInteraction;
  const parts = interaction.customId.split(':');
  const token = parts.length > 1 ? parts[1] : null;
  if (token) await deletePendingRun(token);
  await component.deferUpdate().catch(() => {});
  const { renderTrackMenu } = await import('./upload-handlers.js');
  await renderTrackMenu(asTrackReplyInteraction(component));
}

export async function handleDataSubmission(interaction: ReviewInteraction) {
  const ui = reviewUi();
  const resolved = await resolveOwnedPendingInteraction(interaction, {
    invalidMessage: ui.messages.interactionInvalid,
    expiredMessage: ui.messages.sessionExpiredStart,
  });
  if (!resolved) {
    return;
  }

  const { token, pending } = resolved;
  await submitPendingRun(interaction, token, pending);
}

async function submitPendingRun(interaction: ReviewInteraction, token: string, pending: PendingRecordLike) {
  const ui = reviewUi();
  const component = interaction as MessageComponentInteraction;

  const { userId, username } = pending;
  const includeType = isTrackReviewFlowEnabled(userId);
  const includeNotes = isTrackReviewFlowEnabled(userId);
  const isLifetimeMode = getTrackerFlowMode(userId) === 'lifetime';

  try {
    const mergedSourceData = {
      ...(pending.canonicalRunData ?? {}),
      ...pending.runData,
    };

    const payload = await buildSubmitPayload(userId, username, mergedSourceData, includeType, includeNotes);
    if ('update' in component && typeof component.update === 'function') {
      await component.update({ embeds: [createLoadingEmbed(ui.messages.processingSubmission)], components: [] });
    } else {
      await interaction.editReply({ embeds: [createLoadingEmbed(ui.messages.processingSubmission)], components: [] }).catch(() => {});
    }

    if (isLifetimeMode) {
      await submitLifetimePendingRun({
        interaction,
        pending,
        token,
        userId,
        username,
        uiMessages: ui.messages,
      });
      return;
    }

    const submitRunData = buildSubmitRunData(pending, payload.runData);
    const canonicalRunData = buildCanonicalRunData(pending, submitRunData);

    let syncResult: SubmissionSyncResult | null = null;

    const { duplicateRunId, duplicateLocalId, shouldUpdateExistingRun } = resolveDuplicateRunInfo(pending, submitRunData);
    const localSummaryBefore = await getLocalRunSummary(userId).catch(() => ({ totalRuns: 0, runTypeCounts: {} as Record<string, number> })) as LocalRunSummary;

    if (shouldUpdateExistingRun) {
      if (duplicateRunId) {
        syncResult = await editRun({
          userId,
          username,
          runData: { ...submitRunData, runId: duplicateRunId },
          canonicalRunData,
          settings: undefined,
          skipLeaderboardRefresh: true,
        });
      } else {
        syncResult = await logRun({
          userId,
          username,
          runData: duplicateLocalId ? { ...submitRunData, localId: duplicateLocalId } : submitRunData,
          canonicalRunData,
          screenshot: null,
          skipLeaderboardRefresh: true,
        });
      }
    } else {
      syncResult = await logRun({
        userId,
        username,
        runData: submitRunData,
        canonicalRunData,
        screenshot: null,
        skipLeaderboardRefresh: true,
      });
    }

    const localSummaryAfter = await getLocalRunSummary(userId).catch(() => ({ totalRuns: 0, runTypeCounts: {} as Record<string, number> })) as LocalRunSummary;
    const runTypeCounts = buildRunTypeCounts({
      localSummaryBefore,
      localSummaryAfter,
      canonicalRunData,
      submitRunData,
      shouldUpdateExistingRun,
    });

    const hasScreenshot = Boolean(pending.screenshot?.url);
    const screenshotUrl = resolveScreenshotUrl(submitRunData);
    const { resolvedRunId, resolvedLocalId } = resolveSubmissionIds({
      syncResult,
      duplicateRunId,
      duplicateLocalId,
      submitRunData,
    });
    const coverageSource = buildCoverageSource(canonicalRunData, resolvedRunId, resolvedLocalId);
    const embed = buildSubmissionResultEmbed({ data: coverageSource, isUpdate: shouldUpdateExistingRun, runTypeCounts, hasScreenshot, screenshotUrl });
    const shareableRun = buildShareableRunPayload(coverageSource, screenshotUrl);

    setShareableRun(userId, {
      run: shareableRun,
      runTypeCounts,
      screenshotUrl,
    });

    await interaction.editReply({ content: undefined, embeds: [embed], components: createSuccessButtons(), files: [] });

    await autoShareToConfiguredLogChannel({
      interaction,
      userId,
      run: shareableRun,
      runTypeCounts,
    });

    if (syncResult?.queuedForCloud && syncResult?.cloudUnavailable) {
      await interaction.editReply({ content: ui.messages.cloudUnavailable }).catch(() => {});
    }

    const trackerClient = interaction.client as TrackerBotClient;
    void trackerClient.persistence?.analytics.log({
      ts: new Date().toISOString(),
      event: ANALYTICS_EVENT_RUN_TRACKER_UPLOAD,
      userId,
      guildId: interaction.guildId ?? undefined,
      commandName: 'track',
      runId: resolvedRunId ?? undefined,
    }).catch(() => {});

    await deletePendingRun(token);
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'dataSubmission' });
    await deletePendingRun(token);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    await interaction.editReply({ content: `${ui.messages.submissionFailedPrefix} (${errMsg})`, embeds: [], components: [] }).catch(() => {});
  }
}

export async function handleEditRequest(interaction: ReviewInteraction) {
  try {
    const component = interaction as MessageComponentInteraction;
    const resolved = await resolveOwnedPendingInteraction(interaction);
    if (!resolved) {
      return;
    }
    const { token, pending } = resolved;
    await renderEditFieldPicker(asTrackReplyInteraction(component), token, pending, 'update');
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'edit_request' });
  }
}

export async function renderEditFieldPicker(
  interaction: TrackReplyInteractionLike,
  token: string,
  pending: PendingRecordLike,
  mode: 'update' | 'editReply' = 'editReply',
) {
  const payload = buildEditFieldPickerPayload(token, pending);
  if (mode === 'update' && 'update' in interaction && typeof interaction.update === 'function') {
    await interaction.update(payload).catch(async () => {
      await interaction.editReply(payload).catch(() => {});
    });
    return;
  }

  await interaction.editReply(payload).catch(() => {});
}

export async function handleEditFieldSelection(interaction: ReviewInteraction) {
  try {
    const ui = reviewUi();
    const component = interaction as MessageComponentInteraction;
    const token = interaction.customId.slice(TRACKER_IDS.review.editFieldPrefix.length);
    const selectedFields = getSelectedReviewFields(interaction);
    if (!token || !selectedFields.length) {
      await updateReviewMessage(interaction, getTrackUiConfig().manual.sessionExpired);
      return;
    }

    const resolved = await resolveOwnedPendingInteraction(interaction, { token });
    if (!resolved) {
      return;
    }
    const { pending } = resolved;

    const labels: Record<string, string> = ui.fieldLabels;
    const { modal, modalFieldList } = buildReviewEditFieldModal({
      token,
      title: ui.modals.editFieldTitle,
      selectedFields,
      labels,
      runData: pending.runData,
    });
    await component.showModal(modal);

    const modalCustomId = withTokenAndField(TRACKER_IDS.review.editModalPrefix, token, modalFieldList);
    const submitted = await component.awaitModalSubmit({
      filter: (i: ModalSubmitInteraction) => i.customId === modalCustomId && i.user.id === interaction.user.id,
      time: 300_000,
    });

    try {
      await submitted.deferUpdate();
    } catch {
      /* ignore */
    }

    const nextRunData = applySubmittedReviewEditValues(pending.runData, selectedFields, (_field, index) => {
      return submitted.fields.getTextInputValue(`${TRACKER_IDS.review.editValue}_${index}`) ?? '';
    });

    const updated = await updatePendingRun(token, { runData: nextRunData });
    const updatedPending = await resolveUpdatedPendingOrReplyExpired(interaction, updated, getTrackUiConfig().manual.sessionExpired);
    if (!updatedPending) {
      return;
    }

    await component.editReply(buildEditFieldPickerPayload(token, updatedPending)).catch(() => {});
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'edit_field_selection' });
  }
}

export async function handleEditDone(interaction: ReviewInteraction) {
  try {
    const component = interaction as MessageComponentInteraction;
    const resolved = await resolveOwnedPendingInteraction(interaction, {
      token: interaction.customId.split(':')[1],
    });
    if (!resolved) {
      return;
    }
    const { token, pending } = resolved;
    await component.deferUpdate().catch(() => {});
    await renderDataReview(asTrackReplyInteraction(component), token, pending);
  } catch (error) {
    await handleError({ client: interaction.client, user: interaction.user, error, context: 'edit_done' });
  }
}

export async function handleSuccessNavigation(interaction: ReviewInteraction) {
  const messages = reviewUi().messages;
  const component = interaction as MessageComponentInteraction;
  const label = interaction.customId.includes('upload_another') ? messages.successNavigationUploadAnother : messages.successNavigationDefault;
  const embeds = ('message' in interaction && interaction.message?.embeds) ? interaction.message.embeds : [];
  await component.update({ content: label, embeds, components: [] }).catch(() => {});
}
