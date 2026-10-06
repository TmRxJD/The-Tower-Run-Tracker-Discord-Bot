import { ButtonBuilder } from 'discord.js';
import { buildCurrentReviewReplyPayload } from './review-edit-modal-helpers';
import type { PendingRecordLike } from '../shared/track-review-records';
import { TRACKER_IDS, withTokenAndField } from '../track-custom-ids';
import { submissionDraftVersion } from '../submission-draft';

export function submissionFlowNotice(mode: unknown): string {
  if (mode !== 'track' && mode !== 'lifetime') {
    return 'The original flow for this review is unavailable. Your input has not been discarded; normal session expiry still applies. Start /track and paste the complete run report again, or use /lifetime to upload your lifetime screenshot.';
  }
  return `This review belongs to /${mode}. Reopen that flow before submitting, or start a fresh review with the complete report.`;
}

export function buildSubmissionRetryPayload(token: string, pending: PendingRecordLike & { historyRetryRequired?: boolean }) {
  const payload = buildCurrentReviewReplyPayload(token, pending);
  for (const row of payload.components) for (const component of row.components) {
    if (component instanceof ButtonBuilder && 'custom_id' in component.data
      && component.data.custom_id?.startsWith(TRACKER_IDS.review.acceptPrefix)) {
      component.setCustomId(withTokenAndField(TRACKER_IDS.review.acceptPrefix, token, submissionDraftVersion(pending)));
      if (pending.historyRetryRequired) component.setLabel('Retry');
    }
  }
  return payload;
}
