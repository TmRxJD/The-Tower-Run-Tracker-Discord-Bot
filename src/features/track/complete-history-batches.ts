import { Query } from 'node-appwrite';

// Appwrite permits 4,096 characters per query. Leave margin and bound rows too.
const MAX_QUERY_LENGTH = 4_000;
const MAX_BATCH_ROWS = 500;

/** Pack exact IDs without assuming a fixed ID length or dropping missing extended rows. */
export function buildCompleteHistoryExtendedBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const id of ids) {
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || Query.equal('$id', [...batch, id]).length > MAX_QUERY_LENGTH)) {
      batches.push(batch);
      batch = [];
    }
    // Cloud IDs have already passed the platform schema and Appwrite ID boundary.
    // Refuse an unrepresentable single ID instead of silently omitting it.
    if (Query.equal('$id', [id]).length > MAX_QUERY_LENGTH) throw new Error('Run history ID cannot fit a bounded query.');
    batch.push(id);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
