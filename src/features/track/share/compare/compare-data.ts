import { Query } from 'node-appwrite';
import { z } from 'zod';
import { trackerRunCloudDocumentReadSchema, TRACKER_RUN_MAIN_COLLECTION_ID, resolveTrackerRunCloudDocumentId } from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../../../persistence/appwrite-client';
import { getLocalRuns, getLocalSettings } from '../../local-run-store';
import { resolveBotRunCloudIdentity } from '../../run-cloud-identity';
import { fetchBotStitchedRunCloudDocumentsByIds } from '../../run-cloud-pair-client';
import { compareTrackerRunsForMenuSort } from '../../../../rxdb/run-menu-local-summary';
import { readShareSnapshot } from '../share-snapshot-store';
import { buildShareSnapshotRef, parseShareRunRef } from '../share-run-ref';

const runSchema = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({ ref: z.string(), userId: z.string(), sharerName: z.string(), run: runSchema,
  runTypeCounts: z.record(z.string(), z.number()).optional(), historyVerified: z.boolean().optional(),
  deltaResult: z.unknown().optional() });
export type CompareRun = Record<string, unknown>;
export interface CompareChoice {
  source: 'local' | 'cloud'; id: string; runId?: string; profileId: string | null;
  preview: CompareRun;
}
export interface CompareShared { run: CompareRun; sharerName: string }
const profile = (run: CompareRun) => typeof run.profileId === 'string' && run.profileId.trim() ? run.profileId.trim() : null;
const preview = (run: CompareRun): CompareRun => Object.fromEntries(['tier', 'tierDisplay', 'wave', 'type', 'runDate', 'date', 'profileId'].map(key => [key, run[key]]));

/** Compare the captured public version, never silently substitute a newer private sharer run. */
export async function loadSharedCompareSnapshot(ref: string): Promise<CompareShared | null> {
  const parsed = parseShareRunRef(ref);
  if (!parsed) return null;
  const snapshot = snapshotSchema.safeParse(await readShareSnapshot(ref));
  if (!snapshot.success || snapshot.data.userId !== parsed.userId || snapshot.data.ref !== ref) return null;
  if (/^S-[a-f0-9]{32}$/.test(parsed.runRef)
    && buildShareSnapshotRef(parsed.userId, snapshot.data.run, snapshot.data.runTypeCounts ?? {}, snapshot.data.historyVerified !== false,
      snapshot.data.deltaResult as Parameters<typeof buildShareSnapshotRef>[4]) !== ref) return null;
  return { run: structuredClone(snapshot.data.run), sharerName: snapshot.data.sharerName };
}

export async function loadCompareChoices(userId: string): Promise<{ choices: CompareChoice[]; recentOnly: boolean; unlinked: boolean }> {
  const local = (await getLocalRuns(userId)).filter(run => run.userId === userId && !run.deletedAt && run.localId);
  if (local.length) return {
    choices: [...local].sort(compareTrackerRunsForMenuSort).map(run => ({ source: 'local', id: run.localId, runId: run.runId, profileId: profile(run), preview: preview(run) })),
    recentOnly: false, unlinked: false,
  };
  const settings = await getLocalSettings(userId);
  if (settings.cloudSyncEnabled === false) return { choices: [], recentOnly: false, unlinked: false };
  const identity = await resolveBotRunCloudIdentity(userId);
  const { databases } = createAppwriteClient();
  const choices: CompareChoice[] = [];
  const seen = new Set<string>();
  // Only a bounded main-record chooser read, with extended data fetched for the chosen ID.
  for (const ownerId of new Set(identity.lookupUserIds)) {
    const page = await databases.listDocuments('run-tracker-data', TRACKER_RUN_MAIN_COLLECTION_ID,
      [Query.equal('userId', ownerId), Query.orderDesc('$createdAt'), Query.limit(100)]);
    if (!Array.isArray(page.documents)) throw new Error('Run choices could not be verified');
    for (const raw of page.documents) {
      const parsed = trackerRunCloudDocumentReadSchema.parse(raw);
      const id = resolveTrackerRunCloudDocumentId(parsed);
      if (parsed.userId !== ownerId || !id) throw new Error('Run choice ownership could not be verified');
      if (parsed.deletedAt || seen.has(id)) continue;
      seen.add(id);
      choices.push({ source: 'cloud', id, runId: id, profileId: profile(parsed), preview: preview(parsed) });
    }
  }
  return { choices, recentOnly: true, unlinked: !identity.cloudWriteUserId };
}

/** Re-read exactly the owner's selected run; browser/custom-ID supplied run IDs are never accepted. */
export async function readOwnedCompareRun(userId: string, choice: CompareChoice): Promise<CompareRun | null> {
  const settings = await getLocalSettings(userId);
  let local: CompareRun | undefined;
  if (choice.source === 'local') {
    local = (await getLocalRuns(userId)).find(run => run.localId === choice.id && run.userId === userId && !run.deletedAt);
    if (!local || profile(local) !== choice.profileId || (local.runId || undefined) !== choice.runId) return null;
    if (!choice.runId || settings.cloudSyncEnabled === false) return { ...local };
  }
  if (!choice.runId || settings.cloudSyncEnabled === false) return null;
  const identity = await resolveBotRunCloudIdentity(userId);
  const rows = await fetchBotStitchedRunCloudDocumentsByIds([choice.runId]);
  if (rows.length !== 1) return null;
  const run = runSchema.parse(rows[0]);
  if (resolveTrackerRunCloudDocumentId(run) !== choice.runId || !identity.lookupUserIds.includes(String(run.userId ?? ''))
    || profile(run) !== choice.profileId || run.deletedAt) return null;
  return run;
}
