import { getLocalRuns, getQueueItems, getLocalSettings } from '../local-run-store';
import { getPermanentlyDeletedRunIds } from '../run-deletion-tombstones';
import { bindPreparedShareMessage, preparedShareCheckpoint } from './prepared-share';
import { trackerRunReferencesSameEntry } from '@tmrxjd/platform/tools';

export async function capturePreparedShareCheckpoint(userId: string): Promise<string> {
  const [runs, queue, deleted, settings] = await Promise.all([getLocalRuns(userId), getQueueItems(userId), getPermanentlyDeletedRunIds(userId), getLocalSettings(userId)]);
  // A confirmed cloud acknowledgement can retire an intent already represented by
  // the same local run without changing the prepared display. Unrepresented intents
  // and deletions without a durable tombstone still affect visibility.
  const relevant = queue.filter(item => item.op === 'delete' ? !item.runId || !deleted.has(item.runId)
    : item.op === 'upsert' && item.automaticRecovery && item.uploadProfileId !== undefined
      && !runs.some(run => trackerRunReferencesSameEntry({ left: { runId: item.runId, localId: item.localId },
        right: { runId: run.runId, localId: run.localId, fallbackRunId: run.id ?? run.$id } })))
    .map(item => ({ op: item.op, runId: item.runId, localId: item.localId, uploadProfileId: item.uploadProfileId,
      runData: item.runData, canonicalRunData: item.canonicalRunData, duplicateCheckPending: item.duplicateCheckPending }));
  return preparedShareCheckpoint(runs, relevant, [...deleted], settings.cloudSyncEnabled !== false);
}
export function preparedSourceMessageId(interaction: { message?: unknown }): string | null {
  const message = interaction.message as { id?: unknown } | undefined;
  return typeof message?.id === 'string' ? message.id : null;
}
export async function bindPreparedShareSource(token: string | null, userId: string, interaction: { message?: unknown }): Promise<string | null> {
  if (!token) return null;
  let messageId = preparedSourceMessageId(interaction);
  if (!messageId) {
    const source = interaction as { fetchReply?: () => Promise<{ id?: string }> };
    if (source.fetchReply) messageId = (await source.fetchReply().catch(() => null))?.id ?? null;
  }
  return messageId && bindPreparedShareMessage(token, userId, messageId) ? token : null;
}
