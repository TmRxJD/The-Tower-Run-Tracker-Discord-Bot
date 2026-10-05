import { logger } from '../../../core/logger';
import { updatePasteDiagnostic } from '../paste-diagnostics';
import { IncompleteRunReportError } from './paste-input-error';
import { logError } from './error-handlers';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { readHistoryFailure } from '../history-failure-diagnostic';
export type PasteFailureContext = 'direct_text_paste' | 'paste_flow_modal' | 'paste_add_run_modal';

export async function reportPasteFailure(interaction: TrackReplyInteractionLike, error: unknown,
  reference: string, stage: 'parse' | 'history' | 'review', context: PasteFailureContext) {
  const reason = error instanceof IncompleteRunReportError ? error.reason
    : stage === 'history' ? 'history_unavailable' : 'internal_error';
  const historyFailure = stage === 'history' ? readHistoryFailure(error) : undefined;
  await updatePasteDiagnostic(reference, { result: error instanceof IncompleteRunReportError ? 'rejected' : 'failed', stage, errorCode: reason,
    ...(historyFailure ? { historyFailure } : {}) });
  if (historyFailure) logger.warn('[paste] history failure', { reference, ...historyFailure });
  if (error instanceof IncompleteRunReportError && reason !== 'unrecognized_report') {
    logger.info('[paste] incomplete input rejected', { reference, reason });
  } else {
    // Unrecognized reports may indicate unsupported formatting or a parser defect. Keep them visible,
    // but never forward an exception message that might echo the report or credentials.
    const safeError = new Error(`Paste ${stage} failed (${reason}; reference ${reference}).`);
    Object.defineProperty(safeError, 'code', { value: reason });
    // Do not forward original stacks: an exception message can inject fake stack-frame lines.
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, safeError, context, null, null, stage);
  }
  const guidance = stage === 'parse' && error instanceof IncompleteRunReportError
    ? 'Please paste the full Battle Report, including Battle Date, Tier, Wave, Real Time, Coins earned, Cells Earned and Reroll Shards Earned. You can also upload a screenshot.'
    : stage === 'parse' ? 'The report could not be processed. Please try again or upload a screenshot.'
      : stage === 'history' ? 'Your run history could not be verified, so no run was saved. Please retry shortly.'
      : 'The report could not be prepared for review. Please try again.';
  await interaction.editReply({ content: `${guidance} Reference: ${reference}`, embeds: [], components: [] }).catch(() => {});
}
