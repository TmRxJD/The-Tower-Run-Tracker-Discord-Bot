import { ID, Permission, Query, Role } from 'node-appwrite';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  buildTrackerRunIdentityContext,
  buildTrackerQueuedRunReferenceIdentity,
  buildTrackerResolvedRunReference,
  collectTrackerStaleCloudBackedLocalRunReferences,
  buildTrackerLeaderboardRankedMetricRows,
  buildTrackerLeaderboardPayload,
  buildTrackerLeaderboardCloudDocument,
  buildTrackerLifetimeCloudWritePayload,
  buildTrackerRunMainDocumentPayload,
  TRACKER_RUN_EXTENDED_FIELDS,
  createOrUpdateCloudDocumentWithFallback,
  collectTrackerRunScalarFields,
  createOrUpdateCloudDocument,
  deleteTrackerRunCloudDocuments,
  deleteTrackerRunExtendedDocument,
  estimateTrackerRunTimestamp,
  settleRetryQueueItems,
  extractOcrTextLines,
  extractTrackerLeaderboardCompatibilityCandidates,
  extractTrackerRunCoverageData,
  hasMaterialTrackerRunEntryChange,
  hydrateTrackerCloudRun,
  hydrateTrackerRunEntryFromDocument,
  listCloudDocumentsByUserIds,
  normalizeTrackerLeaderboardCompatibilityCandidate,
  normalizeTrackerLifetimeDate,
  normalizeTrackerLifetimeEntryValues,
  parseTrackerLeaderboardBooleanLike,
  parseTrackerLeaderboardCompatibilityBlob,
  normalizeTrackerRunMetricValue,
  normalizeTrackerRunTextValue,
  normalizeTrackerRunType,
  parseTrackerRunCollectionTarget,
  parseTrackerRunDeleteTarget,
  parseTrackerRunExtendedDocumentRecord,
  parseTrackerRunExtendedMutationTarget,
  compareTrackerVerificationSnapshots,
  createTrackerVerificationSnapshot,
  extractTrackerAppwriteUserIdFromJwt,
  isTrackerAppwriteUserId,
  isTrackerCloudAddressableUserId,
  sanitizeTrackerLeaderboardDocumentId,
  stripUndefinedFields,
  syncTrackerRunExtendedDocument,
  trackerLeaderboardCanonicalMetrics,
  trackerRunReferencesSameEntry,
  trackerRunsShareDuplicateIdentity,
  trackerLifetimeCloudDocumentSchema,
  trackerRunCloudDocumentSchema,
  upsertTrackerLeaderboardBestEntry,
  reconcileTrackerRunIds,
} from '@tmrxjd/platform/tools';
import { getAppConfig } from '../../config';
import { logger } from '../../core/logger';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { isUnauthorizedAppwriteError } from '../../persistence/appwrite-error-utils';
import { formatDateToISO, formatTimeTo24h, normalizeDecimalSeparators } from './tracker-helpers';
import {
  extractTrackerImageText,
  getDocumentOrNull,
  preprocessTrackerImageForOcr,
} from '@tmrxjd/platform/node';
import {
  extractDateTimeFromImage,
  formatOCRExtraction,
  parseRunDataFromText,
} from './handlers/upload-helpers';
import type { AttachmentPayload, RunDataPayload, TrackerSettings } from './types';
import { standardizeNotation } from '../../utils/tracker-math';
import {
  estimateLifetimeEntryTimestamp,
  mergeLifetimeEntriesDelta,
  sortLifetimeEntriesByTimestamp,
} from './shared/tracker-parity-core';
import { canonicalizeTrackerRunData } from './shared/run-data-normalization';
import {
  getLocalLifetime,
  getLocalRuns,
  getLocalSettings,
  getLocalSettingsRecord,
  getQueueItems,
  markQueueItemFailed,
  mergeCloudRuns,
  queueCloudDelete,
  queueCloudSettings,
  queueCloudUpsert,
  releaseQueuedItemsForImmediateRetry,
  removeLocalRun,
  removeQueueItem,
  bulkUpsertLocalRuns,
  upsertLocalRun,
  updateLocalLifetime,
  updateLocalSettings,
} from './local-run-store';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';
import { runDirectVisionOcr } from './vision-ocr-client';

type RunRecord = Record<string, unknown>;

type TrackerRun = RunRecord & {
  runId?: string;
  type?: string;
  date?: string;
  runDate?: string;
  time?: string;
  runTime?: string;
  updatedAt?: number | string;
  wave?: string | number;
  tier?: string | number;
  tierDisplay?: string | number;
  roundDuration?: string;
  duration?: string;
  totalCoins?: string | number;
  coins?: string | number;
  totalCells?: string | number;
  cells?: string | number;
  totalDice?: string | number;
  rerollShards?: string | number;
  dice?: string | number;
  totalEnemies?: string | number;
  destroyedByOrbs?: string | number;
  taggedByDeathWave?: string | number;
  destroyedInSpotlight?: string | number;
  destroyedInGoldenBot?: string | number;
  screenshotUrl?: string;
};

type MigrationProgress = {
  processed: number;
  total: number;
  percent: number;
};

type MigrationOptions = {
  onProgress?: (progress: MigrationProgress) => Promise<void> | void;
};

type CloudTrackerSettings = TrackerSettings & {
  updatedAt?: string;
};

type CloudLeaderboardEntry = {
  metric: typeof trackerLeaderboardCanonicalMetrics[number];
  tier: string;
  username: string;
  userId: string;
  value: string;
  numericValue: number;
  banned: boolean;
  runId: string | null;
  sourceType: string;
  sourceId: string | null;
  guildId: string | null;
  verified: boolean;
};

const MAX_QUEUE_RETRY_COUNT = 8;

type GetLastRunOptions = {
  cloudSyncMode?: 'full' | 'latest' | 'none';
};

/**
 * Resolves the cloud identity for a userId (Discord snowflake or Appwrite account ID).
 *
 * Queries the Appwrite Users API to find the Appwrite account linked via Discord OAuth,
 * so runs uploaded from the site (which use the Appwrite account ID as userId) are also
 * found when the bot queries for a Discord user's runs.
 *
 * Results are cached in-memory + SQLite KV (24-hour TTL) by the resolver.
 */
async function getRunCloudIdentity(userId: string): Promise<{
  ownerUserId: string;
  lookupUserIds: string[];
  permissionUserIds: string[];
}> {
  const normalized = userId.trim();
  const resolvedAppwriteId = await resolveAppwriteIdForDiscordUser(normalized);
  const jwtAppwriteUserId = extractTrackerAppwriteUserIdFromJwt(process.env.APPWRITE_JWT);

  // Appwrite account ID is the canonical userId for all run documents.
  // It is provider-agnostic: Discord, Google, or any future OAuth provider all
  // resolve to the same stable Appwrite account ID via listIdentities.
  // Fall back to the input value only when resolution is unavailable (e.g. a
  // test account with no linked OAuth identity).
  const identity = buildTrackerRunIdentityContext({
    appwriteUserId: resolvedAppwriteId ?? (isTrackerAppwriteUserId(normalized) ? normalized : null),
    permissionAppwriteUserId: resolvedAppwriteId ?? jwtAppwriteUserId ?? (isTrackerAppwriteUserId(normalized) ? normalized : null),
    discordUserId: normalized,
    extraUserIds: [normalized, resolvedAppwriteId],
  });
  const ownerUserId = identity.ownerUserId ?? normalized;

  return {
    ownerUserId,
    lookupUserIds: identity.lookupUserIds,
    permissionUserIds: identity.permissionUserIds,
  };
}

function canUseCloudForUserId(userId: string, operation: string): boolean {
  if (isTrackerCloudAddressableUserId(userId)) return true;
  logger.warn(`Skipping cloud ${operation}: missing cloud-addressable user ID`, { userId });
  return false;
}

async function resolveCloudOperationUserId(userId: string, operation: string): Promise<string | null> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    logger.warn(`Skipping cloud ${operation}: missing cloud-addressable user ID`, { userId });
    return null;
  }

  if (isTrackerCloudAddressableUserId(normalizedUserId)) {
    return normalizedUserId;
  }

  try {
    const { ownerUserId, lookupUserIds } = await getRunCloudIdentity(normalizedUserId);
    if (isTrackerCloudAddressableUserId(ownerUserId)) {
      return ownerUserId;
    }

    const fallbackUserId = lookupUserIds.find(candidate => isTrackerCloudAddressableUserId(candidate));
    if (fallbackUserId) {
      return fallbackUserId;
    }
  } catch (error) {
    logger.warn(`Skipping cloud ${operation}: unable to resolve cloud identity`, {
      userId: normalizedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  logger.warn(`Skipping cloud ${operation}: missing cloud-addressable user ID`, { userId: normalizedUserId });
  return null;
}

export async function shouldShowMigrationNoticeForUser(): Promise<boolean> {
  return false;
}

export async function parseBattleReport(battleReport: string) {
  return {
    runData: parseRunDataFromText(battleReport),
    source: 'local',
  } as Record<string, unknown>;
}

type ParsedOcrResult = {
  source: 'cloud-vision' | 'local-gutenye';
  text: string[];
  runData: Record<string, unknown>;
};

function buildRunDataFromFormattedOcr(formatted: Record<string, unknown>): Record<string, unknown> {
  const roundDuration = String(formatted.roundDuration ?? formatted.duration ?? '');
  const totalCoins = formatted.totalCoins ?? formatted.coins ?? '';
  const totalCells = formatted.totalCells ?? formatted.cells ?? '';
  const totalDice = formatted.totalDice ?? formatted.rerollShards ?? '';
  const killedBy = String(formatted.killedBy ?? 'Apathy');

  return {
    ...formatted,
    duration: roundDuration,
    roundDuration,
    coins: totalCoins,
    totalCoins,
    cells: totalCells,
    totalCells,
    rerollShards: totalDice,
    totalDice,
    killedBy,
    type: String(formatted.type ?? 'Farming'),
    ['Coins Earned']: totalCoins,
    ['Cells Earned']: totalCells,
    ['Reroll Shards Earned']: totalDice,
    ['Killed By']: killedBy,
  };
}

function parseOcrRunDataFromLines(lines: string[]): Record<string, unknown> {
  const joined = lines.join('\n').trim();
  if (!joined) {
    throw new Error('OCR returned no text');
  }

  return parseRunDataFromText(joined);
}

async function runLocalGutenyeOcr(file: AttachmentPayload): Promise<ParsedOcrResult> {
  const imageBuffer = await preprocessTrackerImageForOcr(Buffer.from(file.data));
  const gutenyeResult = await extractTrackerImageText(imageBuffer);
  const text = extractOcrTextLines(gutenyeResult);
  const dateTimeInfo = await extractDateTimeFromImage({
    name: file.filename,
    filename: file.filename,
  });

  try {
    return {
      source: 'local-gutenye',
      text,
      runData: parseOcrRunDataFromLines(text),
    };
  } catch {
    return {
      source: 'local-gutenye',
      text,
      runData: buildRunDataFromFormattedOcr(
        formatOCRExtraction(gutenyeResult, dateTimeInfo, '', '.', 'English') as Record<string, unknown>
      ),
    };
  }
}

export async function runOCR(file: AttachmentPayload) {
  try {
    const visionResult = await runDirectVisionOcr(file);
    const modelRunData = visionResult.runData;

    try {
      const parsedRunData = parseOcrRunDataFromLines(visionResult.textLines);
      return {
        source: 'cloud-vision' as const,
        text: visionResult.textLines,
        runData: {
          ...modelRunData,
          ...parsedRunData,
        },
      };
    } catch (error) {
      if (Object.keys(modelRunData).length > 0) {
        return {
          source: 'cloud-vision' as const,
          text: visionResult.textLines,
          runData: modelRunData,
        };
      }

      throw error;
    }
  } catch (error) {
    logger.warn(`cloud OCR unavailable; falling back to local OCR: ${error instanceof Error ? error.message : 'unknown cloud OCR failure'}`);
    return await runLocalGutenyeOcr(file);
  }
}

function appwriteIds() {
  const cfg = getAppConfig();
  const runsTarget = parseTrackerRunCollectionTarget({
    databaseId: cfg.appwrite.runsDatabaseId,
    collectionId: cfg.appwrite.runsCollectionId,
  });
  const settingsTarget = parseTrackerRunCollectionTarget({
    databaseId: cfg.appwrite.settingsDatabaseId,
    collectionId: cfg.appwrite.settingsCollectionId,
  });
  const lifetimeTarget = parseTrackerRunCollectionTarget({
    databaseId: cfg.appwrite.lifetimeDatabaseId,
    collectionId: cfg.appwrite.lifetimeCollectionId,
  });
  const leaderboardTarget = parseTrackerRunCollectionTarget({
    databaseId: cfg.appwrite.leaderboardDatabaseId,
    collectionId: cfg.appwrite.leaderboardCollectionId,
  });
  return {
    runsDatabaseId: runsTarget.databaseId,
    runsCollectionId: runsTarget.collectionId,
    settingsDatabaseId: settingsTarget.databaseId,
    settingsCollectionId: settingsTarget.collectionId,
    lifetimeDatabaseId: lifetimeTarget.databaseId,
    lifetimeCollectionId: lifetimeTarget.collectionId,
    leaderboardDatabaseId: leaderboardTarget.databaseId,
    leaderboardCollectionId: leaderboardTarget.collectionId,
  };
}

const RUN_DOCUMENTS_PAGE_SIZE = 5000;
const RUNS_EXTENDED_COLLECTION_ID = 'runs_extended_data';
const RUNS_EXTENDED_SCHEMA_VERSION = 1;
const RUNS_HYDRATION_COOLDOWN_MS = 5 * 60 * 1000;
const LIFETIME_HYDRATION_COOLDOWN_MS = 5 * 60 * 1000;
const RUN_HYDRATION_MARKER_KEY_PREFIX = 'tracker:run-docs-hydrated:v1:';

const lazyMigrationCheckedUsers = new Set<string>();
const runsHydratedAtByUser = new Map<string, number>();
const lifetimeHydratedAtByUser = new Map<string, number>();
const backgroundRunHydrationByUser = new Map<string, Promise<void>>();

const QUEUED_SCREENSHOT_DIR = join(process.cwd(), '.data', 'queued-screenshots');
const OFFLINE_SCREENSHOT_DIR = join(process.cwd(), '.data', 'offline-screenshots');
const OFFLINE_SCREENSHOT_LIMIT = 10;

type RunHydrationMarker = {
  hydratedAt: number;
  localRunCount: number;
  source: 'run-docs';
};

function runHydrationMarkerKey(userId: string): string {
  return `${RUN_HYDRATION_MARKER_KEY_PREFIX}${userId}`;
}

async function getRunHydrationMarker(userId: string): Promise<RunHydrationMarker | null> {
  return getTrackerKv<RunHydrationMarker>(runHydrationMarkerKey(userId));
}

async function setRunHydrationMarker(userId: string, localRunCount: number): Promise<void> {
  await setTrackerKv(runHydrationMarkerKey(userId), {
    hydratedAt: Date.now(),
    localRunCount: Math.max(0, Math.floor(localRunCount)),
    source: 'run-docs',
  } satisfies RunHydrationMarker);
}

function pickString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str.length ? str : undefined;
}

function formatTrackerCloudError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  const typed = error as { code?: unknown; type?: unknown; message?: unknown };
  return {
    code: typed?.code,
    type: typed?.type,
    message: typed?.message,
  };
}

function forceWebDefaultTrackerPatch(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    ...settings,
    defaultTracker: 'Web',
  };
}

function normalizeShareSettingsPatch(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    ...settings,
    shareTier: settings.shareTier ?? true,
    shareWave: settings.shareWave ?? true,
    shareDuration: settings.shareDuration ?? true,
    shareKilledBy: settings.shareKilledBy ?? true,
    shareTotalCoins: settings.shareTotalCoins ?? true,
    shareTotalCells: settings.shareTotalCells ?? true,
    shareTotalDice: settings.shareTotalDice ?? true,
    shareDeathDefy: settings.shareDeathDefy ?? true,
    shareCoinsPerHour: settings.shareCoinsPerHour ?? true,
    shareCellsPerHour: settings.shareCellsPerHour ?? true,
    shareDicePerHour: settings.shareDicePerHour ?? true,
    shareNotes: settings.shareNotes ?? true,
    shareCoverage: settings.shareCoverage ?? true,
    shareScreenshot: settings.shareScreenshot ?? true,
  };
}

function forceWebDefaultTrackerSettings<T extends TrackerSettings & { cloudSyncEnabled?: boolean }>(settings: T): T {
  return {
    ...settings,
    defaultTracker: 'Web',
  } as T;
}

function normalizeShareSettingsDefaults<T extends TrackerSettings & { cloudSyncEnabled?: boolean }>(settings: T): T {
  return {
    ...settings,
    shareTier: settings.shareTier ?? true,
    shareWave: settings.shareWave ?? true,
    shareDuration: settings.shareDuration ?? true,
    shareKilledBy: settings.shareKilledBy ?? true,
    shareTotalCoins: settings.shareTotalCoins ?? true,
    shareTotalCells: settings.shareTotalCells ?? true,
    shareTotalDice: settings.shareTotalDice ?? true,
    shareDeathDefy: settings.shareDeathDefy ?? true,
    shareCoinsPerHour: settings.shareCoinsPerHour ?? true,
    shareCellsPerHour: settings.shareCellsPerHour ?? true,
    shareDicePerHour: settings.shareDicePerHour ?? true,
    shareNotes: settings.shareNotes ?? true,
    shareCoverage: settings.shareCoverage ?? true,
    shareScreenshot: settings.shareScreenshot ?? true,
  } as T;
}

async function listRunDocumentsForHydration(userId: string): Promise<RunRecord[]> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { lookupUserIds } = await getRunCloudIdentity(userId);

  // Run base docs and extended docs in parallel — they query different collections
  const [baseDocuments, extendedDocuments] = await Promise.all([
    listCloudDocumentsByUserIds({
      databases,
      databaseId: runsDatabaseId,
      collectionId: runsCollectionId,
      userIds: lookupUserIds,
      schema: trackerRunCloudDocumentSchema,
      pageSize: RUN_DOCUMENTS_PAGE_SIZE,
      buildQueries: (candidateUserId, cursorAfter, pageSize) => [
        Query.equal('userId', candidateUserId),
        Query.limit(pageSize),
        ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
      ],
      getDocumentId: doc => {
        const id = doc.$id;
        return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
      },
    }),
    listExtendedRunDocumentsForUser(userId),
  ]);

  return mergeRunDocumentsWithExtended(baseDocuments, extendedDocuments);
}

function isCollectionNotFoundError(error: unknown): boolean {
  const typed = error as { code?: number; type?: string; message?: string };
  const message = String(typed.message || '').toLowerCase();
  return typed.code === 404
    || typed.type === 'collection_not_found'
    || message.includes('collection not found');
}

function shouldIgnoreExtendedRunCollectionError(error: unknown): boolean {
  return isCollectionNotFoundError(error);
}

function pickExtendedRunDocumentFields(raw: Record<string, unknown>): Record<string, unknown> {
  const direct: Record<string, unknown> = {};
  for (const key of TRACKER_RUN_EXTENDED_FIELDS) {
    const value = raw[key];
    if (value !== null && value !== undefined && String(value).trim().length > 0) {
      direct[key] = String(value);
    }
  }

  return direct;
}

function mergeRunDocumentsWithExtended(baseDocuments: RunRecord[], extendedDocuments: RunRecord[]): RunRecord[] {
  if (!extendedDocuments.length) return baseDocuments;

  const extendedById = new Map<string, Record<string, unknown>>();
  for (const doc of extendedDocuments) {
    const id = typeof doc.$id === 'string' ? doc.$id.trim() : '';
    if (!id) continue;
    extendedById.set(id, pickExtendedRunDocumentFields(doc));
  }

  return baseDocuments.map((doc) => {
    const id = typeof doc.$id === 'string' ? doc.$id.trim() : '';
    const extended = id ? extendedById.get(id) : undefined;
    return extended ? { ...doc, ...extended } : doc;
  });
}

async function listExtendedRunDocumentsForUser(userId: string): Promise<RunRecord[]> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId } = appwriteIds();
  const { lookupUserIds } = await getRunCloudIdentity(userId);
  const extendedTarget = parseTrackerRunCollectionTarget({
    databaseId: runsDatabaseId,
    collectionId: RUNS_EXTENDED_COLLECTION_ID,
  });

  try {
    logger.debug('Listing tracker extended run documents', {
      userId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      lookupUserIds,
    });
    // Fetch all lookupUser extended docs in parallel instead of sequentially
    const perUserResults = await Promise.all(lookupUserIds.map(async (candidateUserId) => {
      const docs: RunRecord[] = [];
      let droppedInvalidDocuments = 0;
      let cursorAfter: string | null = null;

      while (true) {
        const page: { documents?: unknown[] } = await databases.listDocuments(extendedTarget.databaseId, extendedTarget.collectionId, [
          Query.equal('userId', candidateUserId),
          Query.limit(RUN_DOCUMENTS_PAGE_SIZE),
          ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
        ]);

        const pageDocuments = (Array.isArray(page.documents) ? page.documents : [])
          .map(document => parseTrackerRunExtendedDocumentRecord(document))
          .filter((document): document is RunRecord => {
            if (document) return true;
            droppedInvalidDocuments += 1;
            return false;
          });
        if (!pageDocuments.length) break;

        docs.push(...pageDocuments);

        const last: RunRecord | undefined = pageDocuments[pageDocuments.length - 1];
        const lastId: string = typeof last?.$id === 'string' ? last.$id.trim() : '';
        if (!lastId || pageDocuments.length < RUN_DOCUMENTS_PAGE_SIZE) break;
        cursorAfter = lastId;
      }

      if (droppedInvalidDocuments > 0) {
        logger.warn('Dropped malformed tracker extended run documents', {
          userId,
          candidateUserId,
          databaseId: extendedTarget.databaseId,
          collectionId: extendedTarget.collectionId,
          droppedInvalidDocuments,
        });
      }
      return docs;
    }));

    const documents = perUserResults.flat();
    logger.debug('Listed tracker extended run documents', {
      userId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      documentCount: documents.length,
    });
    return documents;
  } catch (error) {
    if (shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('Skipping tracker extended run document read', {
        userId,
        databaseId: extendedTarget.databaseId,
        collectionId: extendedTarget.collectionId,
        reason: error instanceof Error ? error.message : 'unavailable',
      });
      return [];
    }
    logger.warn('Tracker extended run document read failed', {
      userId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      error: formatTrackerCloudError(error),
    });
    throw error;
  }
}

async function syncExtendedRunDocument(params: {
  runsDatabaseId: string;
  runId: string;
  userId: string;
  run: RunRecord;
  permissionUserIds: string[];
}): Promise<void> {
  const extendedTarget = parseTrackerRunExtendedMutationTarget({
    databaseId: params.runsDatabaseId,
    collectionId: RUNS_EXTENDED_COLLECTION_ID,
    runId: params.runId,
    userId: params.userId,
  });
  const permissions = params.permissionUserIds.length
    ? params.permissionUserIds.flatMap((permissionUserId) => ([
        Permission.read(Role.user(permissionUserId)),
        Permission.update(Role.user(permissionUserId)),
        Permission.delete(Role.user(permissionUserId)),
      ]))
    : undefined;

  try {
    logger.debug('Syncing tracker extended run document', {
      runId: extendedTarget.runId,
      userId: extendedTarget.userId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
    });
    await syncTrackerRunExtendedDocument({
      databases: createAppwriteClient().databases,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      runId: extendedTarget.runId,
      userId: extendedTarget.userId,
      run: params.run,
      schemaVersion: RUNS_EXTENDED_SCHEMA_VERSION,
      ...(permissions ? { permissions } : {}),
      shouldIgnoreCollectionError: shouldIgnoreExtendedRunCollectionError,
    });
  } catch (error) {
    if (shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('Skipping tracker extended run document sync', {
        runId: extendedTarget.runId,
        databaseId: extendedTarget.databaseId,
        collectionId: extendedTarget.collectionId,
        reason: error instanceof Error ? error.message : 'unavailable',
      });
      return;
    }
    logger.warn('Tracker extended run document sync failed', {
      runId: extendedTarget.runId,
      userId: extendedTarget.userId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      error: formatTrackerCloudError(error),
    });
    throw error;
  }
}

async function cleanupExtendedRunDocumentAfterMainWriteFailure(params: {
  runsDatabaseId: string;
  runId: string;
}): Promise<void> {
  const extendedTarget = parseTrackerRunExtendedMutationTarget({
    databaseId: params.runsDatabaseId,
    collectionId: RUNS_EXTENDED_COLLECTION_ID,
    runId: params.runId,
    userId: 'tracker-run-main-write-cleanup',
  });

  try {
    await deleteTrackerRunExtendedDocument({
      databases: createAppwriteClient().databases,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      runId: extendedTarget.runId,
      shouldIgnoreCollectionError: shouldIgnoreExtendedRunCollectionError,
    });
  } catch (error) {
    logger.warn('Tracker extended run cleanup after main write failure failed', {
      runId: extendedTarget.runId,
      databaseId: extendedTarget.databaseId,
      collectionId: extendedTarget.collectionId,
      error: formatTrackerCloudError(error),
    });
  }
}

function migrationPercent(processed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor((processed / total) * 100)));
}

async function hydrateRunDocumentsIntoLocalStore(userId: string, options?: MigrationOptions): Promise<boolean> {
  const runDocuments = await listRunDocumentsForHydration(userId);
  const total = runDocuments.length;

  if (options?.onProgress) {
    await options.onProgress({ processed: 0, total, percent: migrationPercent(0, total) });
  }

  if (!runDocuments.length) {
    return false;
  }

  const migratedEntries = runDocuments.map((doc) => (
    hydrateTrackerRunEntryFromDocument(doc, { fallbackId: ID.unique() }) as RunRecord
  ));
  const hydratedRuns = migratedEntries.map((entry) =>
    hydrateTrackerCloudRun(entry, userId, pickString(entry.username) ?? 'unknown') as TrackerRun
  );

  const bulkRuns = hydratedRuns.map((run) => ({
    username: pickString((run as RunRecord).username) ?? 'unknown',
    runData: run as RunRecord,
  }));
  const { added, updated } = await bulkUpsertLocalRuns(userId, bulkRuns);

  if (options?.onProgress) {
    await options.onProgress({ processed: total, total, percent: 100 });
  }

  logger.info('Hydrated run documents into local store', {
    userId,
    migratedRuns: hydratedRuns.length,
    added,
    updated,
  });

  return added > 0 || updated > 0;
}

export async function ensureRunDocumentsHydratedForUser(userId: string, options?: MigrationOptions): Promise<void> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return;
  if (lazyMigrationCheckedUsers.has(normalizedUserId)) return;

  try {
    const [marker, localRunsBefore] = await Promise.all([
      getRunHydrationMarker(normalizedUserId),
      getLocalRuns(normalizedUserId),
    ]);

    if (localRunsBefore.length > 0) {
      if (!marker) {
        await setRunHydrationMarker(normalizedUserId, localRunsBefore.length);
      }
      // Always do a lightweight recent-run sync so new cloud runs appear even
      // when the user already has local data (e.g. dev bot after prod-bot uploads).
      if (canUseCloudForUserId(normalizedUserId, 'recent sync warmup')) {
        await hydrateRecentRunsFromCloud(normalizedUserId, 50);
      }
      return;
    }

    await hydrateRunDocumentsIntoLocalStore(normalizedUserId, options);
    const localRunsAfter = await getLocalRuns(normalizedUserId);
    await setRunHydrationMarker(normalizedUserId, localRunsAfter.length);
  } catch (error) {
    if (isUnauthorizedAppwriteError(error)) {
      logger.warn('Skipping run document hydration: Appwrite authorization unavailable');
    } else {
      logger.warn('Run document hydration skipped due to error', error);
    }
  } finally {
    lazyMigrationCheckedUsers.add(normalizedUserId);
  }
}

async function listRunDocumentsForUser(userId: string): Promise<RunRecord[]> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { lookupUserIds } = await getRunCloudIdentity(userId);
  const mainTarget = parseTrackerRunCollectionTarget({
    databaseId: runsDatabaseId,
    collectionId: runsCollectionId,
  });

  logger.debug('Listing tracker run documents', {
    userId,
    databaseId: mainTarget.databaseId,
    collectionId: mainTarget.collectionId,
    lookupUserIds,
  });

  // Run base docs and extended docs in parallel — they query different collections
  const [baseDocuments, extendedDocuments] = await Promise.all([
    listCloudDocumentsByUserIds({
      databases,
      databaseId: mainTarget.databaseId,
      collectionId: mainTarget.collectionId,
      userIds: lookupUserIds,
      schema: trackerRunCloudDocumentSchema,
      pageSize: 100,
      buildQueries: (candidateUserId, cursorAfter, pageSize) => {
        const queries: string[] = [
          Query.equal('userId', candidateUserId),
          Query.limit(pageSize),
          Query.orderDesc('$createdAt'),
        ];
        if (cursorAfter) queries.push(Query.cursorAfter(cursorAfter));
        return queries;
      },
      getDocumentId: doc => {
        const id = doc.$id;
        return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
      },
    }),
    listExtendedRunDocumentsForUser(userId),
  ]);

  const merged = mergeRunDocumentsWithExtended(baseDocuments, extendedDocuments);
  logger.info('Listed tracker run documents', {
    userId,
    databaseId: mainTarget.databaseId,
    collectionId: mainTarget.collectionId,
    baseDocumentCount: baseDocuments.length,
    extendedDocumentCount: extendedDocuments.length,
    mergedDocumentCount: merged.length,
  });

  return merged;
}

async function findExistingRunDocumentForCandidate(userId: string, candidate: RunRecord): Promise<RunRecord | null> {
  const docs = await listRunDocumentsForUser(userId);
  for (const doc of docs) {
    if (trackerRunsShareDuplicateIdentity(doc, candidate)) {
      return doc;
    }
  }
  return null;
}

async function writeRunDocument(params: {
  userId: string;
  username: string;
  run: RunRecord;
  existingDoc?: RunRecord | null;
}): Promise<{ runId: string; screenshotUrl: string | null }> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { ownerUserId, permissionUserIds } = await getRunCloudIdentity(params.userId);
  const mainTarget = parseTrackerRunCollectionTarget({
    databaseId: runsDatabaseId,
    collectionId: runsCollectionId,
  });

  const resolvedRunId = pickString(params.run.runId)
    ?? pickString(params.run.id)
    ?? pickString(params.existingDoc?.$id)
    ?? pickString(params.existingDoc?.id)
    ?? pickString(params.existingDoc?.runId)
    ?? ID.unique();

  const payload = buildTrackerRunMainDocumentPayload({
    userId: ownerUserId,
    username: params.username,
    run: params.run,
    existing: params.existingDoc ?? null,
  });
  const permissions = permissionUserIds.flatMap(userId => ([
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ]));

  const documentId = pickString(params.existingDoc?.$id) ?? pickString(params.existingDoc?.id) ?? resolvedRunId;
  const writePayload: Record<string, unknown> = { ...payload };
  const strippedUnsupportedFields: string[] = [];

  logger.info('Writing tracker run document', {
    userId: params.userId,
    ownerUserId,
    documentId,
    databaseId: mainTarget.databaseId,
    collectionId: mainTarget.collectionId,
    hasExistingDoc: Boolean(params.existingDoc),
  });

  const mainWritePromise = (async () => {
    for (;;) {
      try {
        await createOrUpdateCloudDocument({
          databases,
          databaseId: mainTarget.databaseId,
          collectionId: mainTarget.collectionId,
          documentId,
          data: writePayload,
          ...(permissions.length ? { permissions } : {}),
        });
        return;
      } catch (error) {
        const unsupportedAttribute = getUnsupportedAttributeFromInvalidStructureError(error);
        if (!unsupportedAttribute || !(unsupportedAttribute in writePayload)) {
          logger.warn('Tracker run document write failed', {
            userId: params.userId,
            ownerUserId,
            documentId,
            databaseId: mainTarget.databaseId,
            collectionId: mainTarget.collectionId,
            error: formatTrackerCloudError(error),
          });
          throw error;
        }

        delete writePayload[unsupportedAttribute];
        strippedUnsupportedFields.push(unsupportedAttribute);
      }
    }
  })();

  const extendedWritePromise = syncExtendedRunDocument({
    runsDatabaseId,
    runId: documentId,
    userId: ownerUserId,
    run: params.run,
    permissionUserIds,
  });

  const [mainWriteResult, extendedWriteResult] = await Promise.allSettled([
    mainWritePromise,
    extendedWritePromise,
  ]);

  if (mainWriteResult.status === 'rejected') {
    if (extendedWriteResult.status === 'fulfilled') {
      await cleanupExtendedRunDocumentAfterMainWriteFailure({
        runsDatabaseId,
        runId: documentId,
      });
    }
    throw mainWriteResult.reason;
  }

  if (extendedWriteResult.status === 'rejected') {
    throw extendedWriteResult.reason;
  }

  if (strippedUnsupportedFields.length > 0) {
    logger.warn('run write stripped unsupported Appwrite attributes', {
      userId: params.userId,
      documentId,
      strippedUnsupportedFields,
    });
  }

  return { runId: documentId, screenshotUrl: pickString(payload.screenshotUrl) ?? null };
}

async function uploadScreenshotForRunWrite(userId: string, screenshot: AttachmentPayload | null | undefined): Promise<string | null> {
  try {
    return await uploadScreenshotIfPossible(userId, screenshot);
  } catch (error) {
    logger.warn('tracker screenshot upload failed; continuing without screenshot URL', error);
    return null;
  }
}

function buildLocalRunUpsertPayload(runData: RunRecord, canonicalRunData?: RunRecord | null): RunRecord {
  const normalizedRunData = canonicalizeTrackerRunData(runData);
  const canonical = canonicalRunData && typeof canonicalRunData === 'object' ? canonicalizeTrackerRunData(canonicalRunData) : null;
  const coverage = extractTrackerRunCoverageData(normalizedRunData);
  const canonicalCoverage = canonical ? extractTrackerRunCoverageData(canonical) : {};

  return {
    ...collectTrackerRunScalarFields(normalizedRunData, canonical),
    ...coverage,
    ...canonicalCoverage,
  };
}

function buildCloudRunEntry(params: {
  userId: string;
  username: string;
  runData: RunRecord;
  canonicalRunData?: RunRecord | null;
  screenshotUrl?: string | null;
  existingEntry?: RunRecord | null;
}): RunRecord {
  const normalizedRunData = canonicalizeTrackerRunData(params.runData);
  const normalizedCanonicalRunData = params.canonicalRunData ? canonicalizeTrackerRunData(params.canonicalRunData) : null;
  const nowIso = new Date().toISOString();
  const uploadDateStr = nowIso.split('T')[0];
  const uploadTimeStr = nowIso.split('T')[1]?.slice(0, 8) ?? '00:00:00';
  const runId = pickString(normalizedRunData.runId)
    ?? pickString(params.existingEntry?.id)
    ?? pickString(params.existingEntry?.runId)
    ?? ID.unique();
  const createdAt = pickString(params.existingEntry?.createdAt) ?? nowIso;
  const scalarRunFields = collectTrackerRunScalarFields(normalizedRunData, normalizedCanonicalRunData);
  const coverage = extractTrackerRunCoverageData(normalizedRunData);
  const canonicalCoverage = normalizedCanonicalRunData ? extractTrackerRunCoverageData(normalizedCanonicalRunData) : {};

  const extractedRunDate = formatDateToISO(String(normalizedRunData.runDate ?? normalizedRunData.date ?? params.existingEntry?.runDate ?? uploadDateStr));
  const extractedRunTime = formatTimeTo24h(String(normalizedRunData.runTime ?? normalizedRunData.time ?? params.existingEntry?.runTime ?? uploadTimeStr));
  const importDate = formatDateToISO(String(params.existingEntry?.date ?? uploadDateStr));
  const importTime = formatTimeTo24h(String(params.existingEntry?.time ?? uploadTimeStr));

  return {
    ...(params.existingEntry ?? {}),
    ...scalarRunFields,
    id: runId,
    runId,
    userId: params.userId,
    username: params.username,
    type: normalizeTrackerRunType(normalizedRunData.type),
    tier: normalizeTrackerRunTextValue(normalizedRunData.tier ?? params.existingEntry?.tier, '1'),
    wave: normalizeTrackerRunTextValue(normalizedRunData.wave ?? params.existingEntry?.wave, '1'),
    coins: normalizeTrackerRunMetricValue(normalizedRunData.totalCoins ?? params.existingEntry?.coins),
    cells: normalizeTrackerRunMetricValue(normalizedRunData.totalCells ?? params.existingEntry?.cells),
    rerollShards: normalizeTrackerRunMetricValue(
      normalizedRunData.totalDice ?? params.existingEntry?.rerollShards,
    ),
    duration: normalizeTrackerRunTextValue(normalizedRunData.roundDuration ?? params.existingEntry?.duration, '0h0m0s'),
    killedBy: normalizeTrackerRunTextValue(normalizedRunData.killedBy ?? params.existingEntry?.killedBy, 'Apathy'),
    runDate: extractedRunDate,
    runTime: extractedRunTime,
    date: importDate,
    time: importTime,
    note: String(normalizedRunData.notes ?? params.existingEntry?.note ?? ''),
    notes: String(normalizedRunData.notes ?? params.existingEntry?.notes ?? ''),
    screenshotUrl: params.screenshotUrl ?? pickString(normalizedRunData.screenshotUrl) ?? pickString(params.existingEntry?.screenshotUrl),
    updatedAt: nowIso,
    createdAt,
    deletedAt: normalizedRunData.deletedAt ?? params.existingEntry?.deletedAt ?? null,
    source: pickString(normalizedRunData.source) ?? pickString(params.existingEntry?.source) ?? 'discord',
    fileId: normalizedRunData.fileId ?? params.existingEntry?.fileId ?? null,
    blocked: Boolean(normalizedRunData.blocked ?? params.existingEntry?.blocked ?? false),
    verified: normalizedRunData.verified ?? params.existingEntry?.verified ?? null,
    ...coverage,
    ...canonicalCoverage,
  };
}

async function uploadScreenshotIfPossible(userId: string, screenshot: AttachmentPayload | null | undefined): Promise<string | null> {
  if (!screenshot) return null;

  const { storage } = createAppwriteClient();
  const { endpoint, projectId, runsBucketId } = getAppConfig().appwrite;
  const safeName = screenshot.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadName = `${userId}-${Date.now()}-${safeName}`;
  const file = new File([new Uint8Array(screenshot.data)], uploadName, {
    type: screenshot.contentType ?? 'application/octet-stream',
  });

  const uploaded = await storage.createFile(runsBucketId, ID.unique(), file);
  const uploadedId = pickString(uploaded.$id);
  if (!uploadedId) return null;

  const normalizedEndpoint = endpoint.replace(/\/$/, '');
  return `${normalizedEndpoint}/storage/buckets/${encodeURIComponent(runsBucketId)}/files/${encodeURIComponent(uploadedId)}/view?project=${encodeURIComponent(projectId)}`;
}

async function storeQueuedScreenshot(userId: string, screenshot: AttachmentPayload | null | undefined) {
  if (!screenshot) return null;

  await fs.mkdir(QUEUED_SCREENSHOT_DIR, { recursive: true });
  const safeName = screenshot.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempPath = join(QUEUED_SCREENSHOT_DIR, `${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`);
  await fs.writeFile(tempPath, screenshot.data);

  return {
    filename: screenshot.filename,
    contentType: screenshot.contentType ?? 'application/octet-stream',
    tempPath,
  };
}

async function loadQueuedScreenshot(screenshot: { filename: string; contentType?: string | null; tempPath: string } | null | undefined): Promise<AttachmentPayload | null> {
  if (!screenshot?.tempPath) return null;
  try {
    const data = await fs.readFile(screenshot.tempPath);
    return {
      data,
      filename: screenshot.filename,
      contentType: screenshot.contentType,
    };
  } catch {
    return null;
  }
}

async function cleanupQueuedScreenshot(screenshot: { tempPath: string } | null | undefined) {
  if (!screenshot?.tempPath) return;
  await fs.unlink(screenshot.tempPath).catch(() => {});
}

async function loadDeferredScreenshotPayload(source: {
  url: string;
  filename?: string | null;
  contentType?: string | null;
} | null | undefined): Promise<AttachmentPayload | null> {
  const screenshotUrl = typeof source?.url === 'string' ? source.url.trim() : '';
  if (!screenshotUrl) return null;

  try {
    const response = await fetch(screenshotUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch deferred screenshot: ${response.status}`);
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      filename: source?.filename ?? 'screenshot.png',
      contentType: source?.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch (error) {
    logger.warn('deferred tracker screenshot fetch failed; continuing without binary attachment', error);
    return null;
  }
}

async function startDeferredRunCloudSync(params: {
  userId: string;
  username: string;
  runData: RunRecord;
  canonicalRunData?: RunRecord | null;
  screenshot?: AttachmentPayload | null;
  deferredScreenshotSource?: { url: string; filename?: string | null; contentType?: string | null } | null;
}): Promise<{ queuedForCloud: boolean; cloudUnavailable: boolean }> {
  const targetLocalId = pickString(params.runData.localId);
  const targetReference = buildTrackerQueuedRunReferenceIdentity({ runData: params.runData });

  try {
    const screenshotPayload = params.screenshot ?? await loadDeferredScreenshotPayload(params.deferredScreenshotSource ?? null);
    const queuedScreenshot = await storeQueuedScreenshot(params.userId, screenshotPayload);

    await queueCloudUpsert({
      userId: params.userId,
      username: params.username,
      runData: params.runData,
      canonicalRunData: params.canonicalRunData ?? undefined,
      screenshot: queuedScreenshot,
      localId: targetLocalId ?? undefined,
    });

    await syncQueuedRuns(params.userId);

    const remainingQueueItems = await getQueueItems(params.userId);
    const stillQueued = remainingQueueItems.some(item => {
      if (item.op !== 'upsert') return false;
      return trackerRunReferencesSameEntry({
        left: {
          localId: targetReference.localId,
          runId: targetReference.runId,
        },
        right: buildTrackerQueuedRunReferenceIdentity(item),
      });
    });

    return {
      queuedForCloud: stillQueued,
      cloudUnavailable: stillQueued,
    };
  } catch (error) {
    logger.warn('deferred tracker run sync failed before queue replay could complete', error);
    return {
      queuedForCloud: true,
      cloudUnavailable: true,
    };
  }
}

async function storeOfflineScreenshotForUser(userId: string, screenshot: AttachmentPayload | null | undefined) {
  if (!screenshot) return { localPath: null as string | null, capacityReached: false };

  const userDir = join(OFFLINE_SCREENSHOT_DIR, userId);
  await fs.mkdir(userDir, { recursive: true });
  const entries = await fs.readdir(userDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter(entry => entry.isFile()).map(entry => join(userDir, entry.name));

  let capacityReached = false;
  if (files.length >= OFFLINE_SCREENSHOT_LIMIT) {
    capacityReached = true;
    const stats = await Promise.all(
      files.map(async filePath => ({ filePath, stat: await fs.stat(filePath).catch(() => null) })),
    );
    const sorted = stats
      .filter(item => item.stat)
      .sort((a, b) => Number(a.stat?.mtimeMs ?? 0) - Number(b.stat?.mtimeMs ?? 0));

    const excessCount = Math.max(0, files.length - (OFFLINE_SCREENSHOT_LIMIT - 1));
    for (let index = 0; index < excessCount; index += 1) {
      const target = sorted[index]?.filePath;
      if (target) await fs.unlink(target).catch(() => {});
    }
  }

  const safeName = screenshot.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(userDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`);
  await fs.writeFile(filePath, screenshot.data);

  return { localPath: filePath, capacityReached };
}

type LifetimeProgress = {
  entries: Array<Record<string, unknown>>;
};

async function cloudGetLifetime(userId: string): Promise<LifetimeProgress | null> {
  const { databases } = createAppwriteClient();
  const { lifetimeDatabaseId, lifetimeCollectionId } = appwriteIds();

  const allEntries = await listCloudDocumentsByUserIds({
    databases,
    databaseId: lifetimeDatabaseId,
    collectionId: lifetimeCollectionId,
    userIds: [userId],
    schema: trackerLifetimeCloudDocumentSchema,
    pageSize: 100,
    buildQueries: (candidateUserId, cursorAfter, pageSize) => [
      Query.equal('userId', candidateUserId),
      Query.limit(pageSize),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ],
    getDocumentId: doc => {
      const id = doc.$id;
      return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
    },
  });

  if (!allEntries.length) return null;
  return { entries: allEntries };
}

function sortLifetimeEntries(entries: Array<Record<string, unknown>>) {
  return sortLifetimeEntriesByTimestamp(entries);
}

function mergeLifetimeEntries(localEntries: Array<Record<string, unknown>>, cloudEntries: Array<Record<string, unknown>>) {
  return mergeLifetimeEntriesDelta(localEntries, cloudEntries, estimateLifetimeEntryTimestamp, sortLifetimeEntries);
}

function isInvalidStructureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const typed = error as { type?: unknown; code?: unknown; message?: unknown };
  const type = String(typed.type ?? '');
  const message = String(typed.message ?? '').toLowerCase();
  return typed.code === 400 && (type.includes('document_invalid_structure') || message.includes('invalid structure'));
}

function getUnsupportedAttributeFromInvalidStructureError(error: unknown): string | null {
  if (!isInvalidStructureError(error)) return null;
  const message = String((error as { message?: unknown }).message ?? '');
  const match = message.match(/unknown attribute:\s*"([^"]+)"/i);
  return match?.[1]?.trim() || null;
}

function buildLifetimeDocumentPayload(
  entry: Record<string, unknown>,
  userId: string,
  username: string,
  existing: Record<string, unknown> | null,
  strictMinimal = false,
): Record<string, unknown> {
  return buildTrackerLifetimeCloudWritePayload(entry, userId, username, {
    existing,
    strictMinimal,
    normalizeNumericValue: value => standardizeNotation(value.replace(',', '.')),
  });
}

async function upsertLifetimeDocument(params: {
  userId: string;
  username: string;
  entryId: string;
  entry: Record<string, unknown>;
  existing?: Record<string, unknown> | null;
}) {
  const { databases } = createAppwriteClient();
  const { lifetimeDatabaseId, lifetimeCollectionId } = appwriteIds();
  const existing = params.existing ?? null;
  const payload = buildLifetimeDocumentPayload(params.entry, params.userId, params.username, existing, false);

  try {
    await createOrUpdateCloudDocument({
      databases,
      databaseId: lifetimeDatabaseId,
      collectionId: lifetimeCollectionId,
      documentId: params.entryId,
      data: payload,
    });
  } catch (error) {
    if (!isInvalidStructureError(error)) throw error;
    const minimalPayload = buildLifetimeDocumentPayload(params.entry, params.userId, params.username, existing, true);
    await createOrUpdateCloudDocument({
      databases,
      databaseId: lifetimeDatabaseId,
      collectionId: lifetimeCollectionId,
      documentId: params.entryId,
      data: minimalPayload,
    });
  }
}

export async function saveLifetimeEntry(params: {
  userId: string;
  username: string;
  entryData: Record<string, unknown>;
  entryId?: string;
  screenshotUrl?: string | null;
}) {
  const baseDate = normalizeTrackerLifetimeDate(params.entryData.date);
  const entryId = pickString(params.entryId)
    ?? pickString(params.entryData.id)
    ?? pickString(params.entryData.$id)
    ?? ID.unique();

  const localLifetime = await getLocalLifetime(params.userId);
  const nextEntry: Record<string, unknown> = {
    ...params.entryData,
    $id: entryId,
    id: entryId,
    userId: params.userId,
    username: params.username,
    date: baseDate,
  };

  const normalizedEntry = normalizeTrackerLifetimeEntryValues(nextEntry, {
    normalizeNumericValue: value => standardizeNotation(value.replace(',', '.')),
  });

  if (params.screenshotUrl) {
    normalizedEntry.screenshotUrl = params.screenshotUrl;
    normalizedEntry.verified = true;
  }

  const previousEntries = Array.isArray(localLifetime.entries) ? localLifetime.entries : [];
  const existingIndex = previousEntries.findIndex(entry => {
    const candidate = pickString(entry.$id) ?? pickString(entry.id);
    return candidate === entryId;
  });

  const merged = existingIndex >= 0
    ? previousEntries.map((entry, index) => (index === existingIndex ? { ...entry, ...normalizedEntry } : entry))
    : [...previousEntries, normalizedEntry];

  const sorted = sortLifetimeEntries(merged);
  await updateLocalLifetime(params.userId, sorted, Date.now());

  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) {
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: true,
      entry: normalizedEntry,
      allEntries: sorted,
    };
  }

  try {
    const cloudLifetime = await cloudGetLifetime(params.userId);
    const remoteEntries = Array.isArray(cloudLifetime?.entries) ? cloudLifetime.entries : [];
    const remoteById = new Map<string, Record<string, unknown>>();
    for (const remoteEntry of remoteEntries) {
      const remoteId = pickString(remoteEntry.$id) ?? pickString(remoteEntry.id);
      if (remoteId) remoteById.set(remoteId, remoteEntry);
    }

    await upsertLifetimeDocument({
      userId: params.userId,
      username: params.username,
      entryId,
      entry: normalizedEntry,
      existing: remoteById.get(entryId) ?? null,
    });

    await upsertCloudLeaderboardForUser(params.userId, params.username).catch(error => {
      logger.warn('cloud leaderboard update skipped after lifetime save', error);
    });
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: false,
      entry: normalizedEntry,
      allEntries: sorted,
    };
  } catch (error) {
    logger.warn('cloud lifetime save unavailable; local lifetime preserved', error);
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: true,
      localOnly: false,
      entry: normalizedEntry,
      allEntries: sorted,
    };
  }
}

export async function removeLifetimeEntry(params: { userId: string; username: string; entryId: string }) {
  const localLifetime = await getLocalLifetime(params.userId);
  const existingEntries = Array.isArray(localLifetime.entries) ? localLifetime.entries : [];
  const nextEntries = existingEntries.filter((entry) => {
    const id = pickString(entry.$id) ?? pickString(entry.id);
    return id !== params.entryId;
  });

  await updateLocalLifetime(params.userId, nextEntries, Date.now());

  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) {
    return {
      ok: true,
      cloudUnavailable: false,
      localOnly: true,
      removed: nextEntries.length !== existingEntries.length,
    };
  }

  try {
    const cloudLifetime = await cloudGetLifetime(params.userId);
    const remoteEntries = Array.isArray(cloudLifetime?.entries) ? cloudLifetime.entries : [];
    const remoteById = new Map<string, Record<string, unknown>>();
    for (const remoteEntry of remoteEntries) {
      const remoteId = pickString(remoteEntry.$id) ?? pickString(remoteEntry.id);
      if (remoteId) remoteById.set(remoteId, remoteEntry);
    }

    const { databases } = createAppwriteClient();
    const { lifetimeDatabaseId, lifetimeCollectionId } = appwriteIds();
    const cloudDoc = remoteById.get(params.entryId);
    const cloudDocId = pickString(cloudDoc?.$id) ?? pickString(cloudDoc?.id) ?? params.entryId;
    await databases.deleteDocument(lifetimeDatabaseId, lifetimeCollectionId, cloudDocId).catch(error => {
      const typed = error as { code?: number };
      if (typed.code !== 404) throw error;
    });

    await upsertCloudLeaderboardForUser(params.userId, params.username).catch(error => {
      logger.warn('cloud leaderboard update skipped after lifetime remove', error);
    });
    return {
      ok: true,
      cloudUnavailable: false,
      localOnly: false,
      removed: nextEntries.length !== existingEntries.length,
    };
  } catch (error) {
    logger.warn('cloud lifetime remove unavailable; local lifetime preserved', error);
    return {
      ok: true,
      cloudUnavailable: true,
      localOnly: false,
      removed: nextEntries.length !== existingEntries.length,
    };
  }
}

function toCloudType(value: unknown): string {
  const str = String(value ?? 'Farming');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

type RunVerificationResult = {
  verified: boolean;
  status: 'verified' | 'review';
  mismatchedFields: string[];
  reason?: string;
};

export async function verifyRunWithScreenshot(runData: RunRecord, screenshot: AttachmentPayload | null | undefined): Promise<RunVerificationResult> {
  if (!screenshot) {
    return { verified: false, status: 'review', mismatchedFields: [], reason: 'missing_screenshot' };
  }

  const expectedSnapshot = createTrackerVerificationSnapshot(runData);
  if (!expectedSnapshot) {
    return { verified: false, status: 'review', mismatchedFields: [], reason: 'invalid_run_data' };
  }

  try {
    const ocrPayload = await runOCR(screenshot);
    const ocrRunData = ocrPayload.runData;
    const ocrSnapshot = createTrackerVerificationSnapshot(ocrRunData);
    if (!ocrSnapshot) {
      return { verified: false, status: 'review', mismatchedFields: [], reason: 'ocr_incomplete' };
    }

    const mismatchedFields = compareTrackerVerificationSnapshots(expectedSnapshot, ocrSnapshot);
    if (mismatchedFields.length > 0) {
      return { verified: false, status: 'review', mismatchedFields, reason: 'field_mismatch' };
    }

    return { verified: true, status: 'verified', mismatchedFields: [] };
  } catch (error) {
    logger.warn('run verification OCR failed', error);
    return { verified: false, status: 'review', mismatchedFields: [], reason: 'ocr_failed' };
  }
}

async function upsertCloudLeaderboardForUser(userId: string, usernameHint = 'unknown') {
  const { databases } = createAppwriteClient();
  const { leaderboardDatabaseId, leaderboardCollectionId } = appwriteIds();
  const runs = (await getLocalRuns(userId)) as TrackerRun[];
  const lifetime = await getLocalLifetime(userId);

  const preferredUsername = (() => {
    const fromRun = runs.find(run => typeof run.username === 'string' && String(run.username).trim().length > 0);
    if (fromRun?.username) return String(fromRun.username);
    return usernameHint;
  })();

  const payloadData = buildTrackerLeaderboardPayload(userId, preferredUsername, runs, lifetime.entries);
  const preferredId = sanitizeTrackerLeaderboardDocumentId(userId);
  const now = new Date().toISOString();

  const getDocument = async (docId: string) => {
    try {
      return await databases.getDocument(leaderboardDatabaseId, leaderboardCollectionId, docId);
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  };

  const existingByPreferred = await getDocument(preferredId);
  const existingByUserId = preferredId !== userId ? await getDocument(userId) : null;
  const existing = existingByPreferred ?? existingByUserId;
  const targetId = existingByPreferred ? preferredId : existingByUserId ? userId : preferredId;

  const payload = buildTrackerLeaderboardCloudDocument(payloadData, {
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  });

  if (existing) {
    await databases.updateDocument(leaderboardDatabaseId, leaderboardCollectionId, targetId, payload);
    return;
  }

  try {
    await databases.createDocument(leaderboardDatabaseId, leaderboardCollectionId, targetId, payload);
  } catch (error) {
    if ((error as { code?: number }).code !== 409) throw error;
    await databases.updateDocument(leaderboardDatabaseId, leaderboardCollectionId, targetId, payload);
  }
}

async function cloudSubmitRunSummary(params: { userId: string; username: string; runData: RunDataPayload; note?: string; screenshot?: AttachmentPayload | null }) {
  const normalized = normalizeDecimalSeparators(params.runData as unknown as Record<string, unknown>);
  const runRecord = {
    ...(normalized as RunRecord),
    note: params.note ?? (normalized as RunRecord).note,
    notes: params.note ?? (normalized as RunRecord).notes,
  };

  const result = await cloudLogRun({
    userId: params.userId,
    username: params.username,
    runData: runRecord,
    screenshot: params.screenshot ?? null,
  });

  return {
    runId: pickString((result as Record<string, unknown>).runId),
    message: 'saved-via-runs-doc',
  };
}

async function cloudLogRun(params: {
  userId: string;
  username: string;
  runData: RunRecord;
  canonicalRunData?: RunRecord | null;
  settings?: Record<string, unknown>;
  screenshot?: AttachmentPayload | null;
  disableDuplicateLookup?: boolean;
}) {
  const normalizedInput = normalizeDecimalSeparators(params.runData as Record<string, unknown>) as RunRecord;
  const targetRunId = pickString(normalizedInput.runId) ?? pickString(normalizedInput.id) ?? null;
  const existingDoc = targetRunId
    ? ({ $id: targetRunId } as RunRecord)
    : (params.disableDuplicateLookup ? null : await findExistingRunDocumentForCandidate(params.userId, normalizedInput));
  const existing = existingDoc
    ? (hydrateTrackerRunEntryFromDocument(existingDoc, { fallbackId: ID.unique() }) as RunRecord)
    : null;

  const nextEntryWithoutScreenshot = buildCloudRunEntry({
    userId: params.userId,
    username: params.username,
    runData: normalizedInput,
    canonicalRunData: params.canonicalRunData,
    screenshotUrl: undefined,
    existingEntry: existing,
  });

  if (!params.screenshot && existing && !hasMaterialTrackerRunEntryChange(existing, nextEntryWithoutScreenshot)) {
    return {
      ok: true,
      runId: pickString(existing.id) ?? pickString(existing.runId),
      screenshotUrl: pickString(existing.screenshotUrl) ?? null,
    };
  }

  const screenshotUploadPromise = params.screenshot
    ? uploadScreenshotForRunWrite(params.userId, params.screenshot)
    : null;
  const baseWriteChanged = !existing || hasMaterialTrackerRunEntryChange(existing, nextEntryWithoutScreenshot);

  let saved = baseWriteChanged
    ? await writeRunDocument({
        userId: params.userId,
        username: params.username,
        run: nextEntryWithoutScreenshot,
        existingDoc,
      })
    : {
        runId: pickString(existing?.id) ?? pickString(existing?.runId) ?? pickString(existingDoc?.$id) ?? ID.unique(),
        screenshotUrl: pickString(existing?.screenshotUrl) ?? null,
      };

  let finalScreenshotUrl = saved.screenshotUrl ?? null;

  if (screenshotUploadPromise) {
    const uploadedScreenshotUrl = await screenshotUploadPromise;
    if (uploadedScreenshotUrl) {
      const screenshotEntry = buildCloudRunEntry({
        userId: params.userId,
        username: params.username,
        runData: normalizedInput,
        canonicalRunData: params.canonicalRunData,
        screenshotUrl: uploadedScreenshotUrl,
        existingEntry: nextEntryWithoutScreenshot,
      });

      if (hasMaterialTrackerRunEntryChange(nextEntryWithoutScreenshot, screenshotEntry)) {
        saved = await writeRunDocument({
          userId: params.userId,
          username: params.username,
          run: screenshotEntry,
          existingDoc: { $id: saved.runId },
        });
      }

      finalScreenshotUrl = saved.screenshotUrl ?? uploadedScreenshotUrl;
      logger.debug(`Uploaded screenshot for run write (${params.userId})`);
    }
  }

  return { ok: true, runId: saved.runId, screenshotUrl: finalScreenshotUrl };
}

async function cloudEditRun(params: { userId: string; username: string; runData: RunRecord; settings?: Record<string, unknown> }) {
  const targetRunId = buildTrackerResolvedRunReference({ runData: params.runData }).runId;
  const existingDoc = targetRunId ? ({ $id: targetRunId } as RunRecord) : null;
  const existing = existingDoc
    ? (hydrateTrackerRunEntryFromDocument(existingDoc, { fallbackId: ID.unique() }) as RunRecord)
    : null;
  const nextEntry = buildCloudRunEntry({
    userId: params.userId,
    username: params.username,
    runData: params.runData,
    existingEntry: existing,
  });

  if (existing && !hasMaterialTrackerRunEntryChange(existing, nextEntry)) {
    return true;
  }

  await writeRunDocument({
    userId: params.userId,
    username: params.username,
    run: nextEntry,
    existingDoc,
  });

  return true;
}

async function cloudGetRuns(userId: string) {
  const docs = await listRunDocumentsForUser(userId);
  return docs.map((doc) => {
    const username = pickString(doc.username) ?? 'unknown';
    return hydrateTrackerCloudRun(doc, userId, username) as TrackerRun;
  });
}

/**
 * Fetches the most recent `limit` run documents from Appwrite using all known
 * lookup user IDs (Appwrite-mapped and raw Discord IDs). Returns hydrated runs.
 *
 * Uses a 2-phase batch strategy: first fetch base docs (1 query per lookupUserId),
 * then fetch ALL matching extended docs in parallel (1 query per lookupUserId).
 * This reduces N+1 sequential HTTP calls (e.g. 26 for 25 runs) to ~3-4 parallel calls.
 */
async function cloudGetRecentRuns(userId: string, limit: number): Promise<TrackerRun[]> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { lookupUserIds } = await getRunCloudIdentity(userId);
  const seen = new Set<string>();
  const baseDocs: RunRecord[] = [];

  // Fetch by both $createdAt (new documents) and $updatedAt (re-uploaded/modified documents)
  // in parallel so the recent list includes any run whose document was updated, not just newly created ones.
  const fetchRecentPage = (candidateId: string, field: '$createdAt' | '$updatedAt') =>
    databases.listDocuments(runsDatabaseId, runsCollectionId, [
      Query.equal('userId', candidateId),
      Query.orderDesc(field),
      Query.limit(limit),
    ]).then(page => (Array.isArray(page.documents) ? (page.documents as RunRecord[]) : [])).catch(() => [] as RunRecord[]);

  const recentDocArrays = await Promise.all(
    lookupUserIds.flatMap(candidateId => [
      fetchRecentPage(candidateId, '$createdAt'),
      fetchRecentPage(candidateId, '$updatedAt'),
    ]),
  );

  for (const docs of recentDocArrays) {
    for (const rawDoc of docs) {
      const doc = rawDoc as RunRecord;
      const docId = String(doc.$id ?? '');
      if (!docId || seen.has(docId) || baseDocs.length >= limit) continue;
      seen.add(docId);
      baseDocs.push(doc);
    }
  }

  if (!baseDocs.length) return [];

  // Batch-fetch extended docs in parallel — one listDocuments per lookupUserId
  // instead of one getDocument per run, cutting ~25 sequential calls to 1-2 parallel calls.
  const extendedByDocId = new Map<string, RunRecord>();
  try {
    await Promise.all(lookupUserIds.map(async (candidateId) => {
      const extPage = await databases.listDocuments(runsDatabaseId, RUNS_EXTENDED_COLLECTION_ID, [
        Query.equal('userId', candidateId),
        Query.orderDesc('$createdAt'),
        Query.limit(limit),
      ]);
      for (const rawExtDoc of (Array.isArray(extPage.documents) ? extPage.documents : [])) {
        const extDoc = rawExtDoc as RunRecord;
        const extDocId = String(extDoc.$id ?? '');
        if (extDocId && !extendedByDocId.has(extDocId)) {
          extendedByDocId.set(extDocId, extDoc);
        }
      }
    }));
  } catch (error) {
    if (!shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('batch extended run fetch failed, continuing without extended data', error);
    }
  }

  return baseDocs.map(doc => {
    const docId = String(doc.$id ?? '');
    const extended = extendedByDocId.get(docId);
    const mergedDoc = extended ? { ...doc, ...pickExtendedRunDocumentFields(extended) } : doc;
    const username = pickString(mergedDoc.username) ?? 'unknown';
    return hydrateTrackerCloudRun(mergedDoc, userId, username) as TrackerRun;
  });
}

/**
 * Fetches the most recent `limit` runs from cloud and merges them into local.
 * Intentionally does NOT update `runsHydratedAtByUser` so the full-sync cooldown
 * is unaffected and background hydration can still proceed normally.
 */
async function hydrateRecentRunsFromCloud(userId: string, limit = 25): Promise<boolean> {
  try {
    const settings = await getLocalSettings(userId);
    if (!settings.cloudSyncEnabled) return false;
    const recent = await cloudGetRecentRuns(userId, limit);
    if (!recent.length) return false;
    const mergeResult = await mergeCloudRuns(userId, recent);
    return mergeResult.added > 0 || mergeResult.updated > 0;
  } catch (error) {
    logger.warn('recent runs cloud hydration skipped due to error', error);
    return false;
  }
}

/**
 * Fetches only runs whose Appwrite $createdAt is strictly after `sinceIso`.
 * All base queries run in parallel (one per lookupUserId).
 * Returns [] immediately if nothing is found — no extended-data calls needed.
 */
async function cloudGetRunsSince(userId: string, sinceIso: string, limit: number): Promise<TrackerRun[]> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { lookupUserIds } = await getRunCloudIdentity(userId);

  // Query both $createdAt (new documents) and $updatedAt (re-uploaded/modified documents)
  // in parallel so a run whose Appwrite document was updated rather than re-created is not missed.
  const fetchPage = (candidateId: string, field: '$createdAt' | '$updatedAt') =>
    databases
      .listDocuments(runsDatabaseId, runsCollectionId, [
        Query.equal('userId', candidateId),
        Query.greaterThan(field, sinceIso),
        Query.orderDesc(field),
        Query.limit(limit),
      ])
      .then(page => {
        const docs = Array.isArray(page.documents) ? (page.documents as RunRecord[]) : [];
        logger.info('[delta-sync] page result', { candidateId, field, sinceIso, count: docs.length });
        return docs;
      })
      .catch((err) => { logger.warn('[delta-sync] page query failed', { candidateId, field, err }); return [] as RunRecord[]; });

  const baseDocArrays = await Promise.all(
    lookupUserIds.flatMap(candidateId => [
      fetchPage(candidateId, '$createdAt'),
      fetchPage(candidateId, '$updatedAt'),
    ]),
  );

  const seen = new Set<string>();
  const baseDocs: RunRecord[] = [];
  for (const docs of baseDocArrays) {
    for (const doc of docs) {
      const docId = String(doc.$id ?? '');
      if (docId && !seen.has(docId) && baseDocs.length < limit) {
        seen.add(docId);
        baseDocs.push(doc);
      }
    }
  }

  if (!baseDocs.length) return [];

  const extendedByDocId = new Map<string, RunRecord>();
  try {
    await Promise.all(
      lookupUserIds.flatMap(candidateId => [
        databases.listDocuments(runsDatabaseId, RUNS_EXTENDED_COLLECTION_ID, [
          Query.equal('userId', candidateId),
          Query.greaterThan('$createdAt', sinceIso),
          Query.orderDesc('$createdAt'),
          Query.limit(limit),
        ]).then(extPage => {
          for (const rawExtDoc of Array.isArray(extPage.documents) ? extPage.documents : []) {
            const extDoc = rawExtDoc as RunRecord;
            const extDocId = String(extDoc.$id ?? '');
            if (extDocId && !extendedByDocId.has(extDocId)) extendedByDocId.set(extDocId, extDoc);
          }
        }).catch(() => {}),
        databases.listDocuments(runsDatabaseId, RUNS_EXTENDED_COLLECTION_ID, [
          Query.equal('userId', candidateId),
          Query.greaterThan('$updatedAt', sinceIso),
          Query.orderDesc('$updatedAt'),
          Query.limit(limit),
        ]).then(extPage => {
          for (const rawExtDoc of Array.isArray(extPage.documents) ? extPage.documents : []) {
            const extDoc = rawExtDoc as RunRecord;
            const extDocId = String(extDoc.$id ?? '');
            if (extDocId && !extendedByDocId.has(extDocId)) extendedByDocId.set(extDocId, extDoc);
          }
        }).catch(() => {}),
      ]),
    );
  } catch (error) {
    if (!shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('delta extended run fetch failed, continuing without extended data', error);
    }
  }

  return baseDocs.map(doc => {
    const docId = String(doc.$id ?? '');
    const extended = extendedByDocId.get(docId);
    const mergedDoc = extended ? { ...doc, ...pickExtendedRunDocumentFields(extended) } : doc;
    const username = pickString(mergedDoc.username) ?? 'unknown';
    return hydrateTrackerCloudRun(mergedDoc, userId, username) as TrackerRun;
  });
}

/** KV key prefix for the per-user timestamp of the last Appwrite delta check. */
const LAST_DELTA_CHECK_KV_PREFIX = 'tracker:last-cloud-delta-check:';

/**
 * Full bidirectional sync — identical flow used by both the bot and the site.
 *
 * 1. Read all local runs (SQLite).
 * 2. Read all Appwrite run IDs via reconcileTrackerRunIds (paginated, ID-only).
 * 3. Upload every local-only run to Appwrite (queue-pending runs are skipped).
 * 4. Re-read full cloud run list (authoritative state after upload).
 * 5. Import every cloud-only run into local store.
 * 6. Verify: finalCloudCount === finalLocalCount (synced = true means counts match).
 *
 * synced=false only when Appwrite is unreachable or individual uploads failed.
 * If cloudSyncEnabled=false the function returns immediately with synced=true.
 */
async function reconcileLocalWithCloud(
  userId: string,
): Promise<{ uploaded: number; deleted: number; imported: number; finalCloudCount: number; finalLocalCount: number; synced: boolean }> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const { ownerUserId, lookupUserIds } = await getRunCloudIdentity(userId);

  // ── Step 1: Read local runs ──────────────────────────────────────────────
  const localRuns = (await getLocalRuns(userId)) as RunRecord[];
  const queueItems = await getQueueItems(userId);
  const pendingUploadIds = new Set<string>(
    queueItems
      .filter(item => item.op === 'upsert' && typeof item.runId === 'string' && item.runId)
      .map(item => item.runId as string),
  );

  // Only runs with a runId participate in cloud sync; unregistered runs have no $id yet.
  const localIds = new Set<string>(
    localRuns.map(r => String(r.runId ?? '').trim()).filter(Boolean),
  );

  // ── Step 2: Read all Appwrite IDs (fast, ID-only fetch) ──────────────────
  const { localOnlyIds, allCloudIds, cloudOnlyIds } = await reconcileTrackerRunIds({
    databases,
    databaseId: runsDatabaseId,
    collectionId: runsCollectionId,
    userIds: lookupUserIds,
    pageSize: RUN_DOCUMENTS_PAGE_SIZE,
    localIds,
    pendingUploadIds,
    buildQueries: (uid, cursorAfter, pageSize) => [
      Query.equal('userId', uid),
      Query.select(['$id']),
      Query.limit(pageSize),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ],
  });

  // ── Step 3: Remove local runs whose cloud copy was deleted ─────────────
  // A run with a runId that no longer exists in Appwrite was deleted from the site.
  // Propagate that deletion to local SQLite. Runs in pendingUploadIds are already
  // excluded by reconcileTrackerRunIds so queued-but-not-yet-uploaded runs are safe.
  let deleted = 0;
  if (localOnlyIds.length > 0) {
    logger.info('[reconcile] removing local runs deleted from cloud', { userId, count: localOnlyIds.length });
    for (const runId of localOnlyIds) {
      try {
        await removeLocalRun(userId, runId);
        localIds.delete(runId); // keep localIds accurate for step 6 count
        deleted += 1;
      } catch (deleteErr) {
        logger.warn('[reconcile] local delete failed for cloud-deleted run', { userId, runId, deleteErr });
      }
    }
    if (deleted > 0) {
      logger.info('[reconcile] removed local runs deleted from cloud', { userId, deleted });
    }
  }

  // ── Step 3b: Upload unregistered runs (no runId — stranded after queue failure) ──
  // These runs exist locally but were never successfully synced to Appwrite.
  // After a successful upload, persist the new cloud $id back to local SQLite so
  // they are treated as registered on every subsequent call (no double-upload).
  const unregisteredRuns = localRuns.filter(r => !String((r as Record<string, unknown>).runId ?? '').trim());
  let uploadedUnregistered = 0;
  if (unregisteredRuns.length > 0) {
    logger.info('[reconcile] uploading unregistered (no runId) runs to Appwrite', { userId, count: unregisteredRuns.length });
    for (const run of unregisteredRuns) {
      const username = pickString((run as Record<string, unknown>).username) ?? 'unknown';
      try {
        const { runId: newRunId } = await writeRunDocument({ userId, username, run: run as RunRecord, existingDoc: null });
        // Write the assigned cloud ID back to the local record so it's registered from now on.
        await upsertLocalRun(userId, username, { ...(run as Record<string, unknown>), runId: newRunId });
        // Track the new ID so step 5's allCloudOnlyIds diff doesn't re-import it as "cloud-only".
        localIds.add(newRunId);
        uploadedUnregistered += 1;
      } catch (uploadErr) {
        logger.warn('[reconcile] upload failed for unregistered run', { userId, uploadErr });
      }
    }
    if (uploadedUnregistered > 0) {
      logger.info('[reconcile] uploaded unregistered runs', { userId, uploadedUnregistered });
    }
  }

  // ── Step 5: Import cloud-only runs into local store ──────────────────────
  // cloudOnlyIds from Step 2 already excludes pendingDeleteIds and localIds at scan time.
  // Re-filter against current localIds to exclude IDs added by Step 3b uploads.
  const allCloudOnlyIds = cloudOnlyIds.filter(id => !localIds.has(id));
  let imported = 0;

  if (allCloudOnlyIds.length > 0) {
    logger.info('[reconcile] importing cloud-only runs to local', { userId, count: allCloudOnlyIds.length });
    const IMPORT_BATCH = 100;
    const importedDocs: RunRecord[] = [];
    for (let i = 0; i < allCloudOnlyIds.length; i += IMPORT_BATCH) {
      const batchIds = allCloudOnlyIds.slice(i, i + IMPORT_BATCH);
      try {
        const batchResult = await databases.listDocuments(runsDatabaseId, runsCollectionId, [
          Query.equal('$id', batchIds),
          Query.limit(IMPORT_BATCH),
        ]);
        const docs = Array.isArray(batchResult.documents) ? batchResult.documents : [];
        for (const raw of docs) {
          const parsed = trackerRunCloudDocumentSchema.safeParse(raw);
          if (parsed.success) importedDocs.push(parsed.data as RunRecord);
        }
      } catch (batchErr) {
        logger.warn('[reconcile] import batch fetch failed', { userId, batchStart: i, batchErr });
      }
    }
    if (importedDocs.length > 0) {
      // Use the username from the first available local run; falls back to 'unknown'.
      const username = pickString((localRuns as Array<Record<string, unknown>>)[0]?.username) ?? 'unknown';
      const hydratedImports = importedDocs.map(doc => {
        const entry = hydrateTrackerRunEntryFromDocument(doc, { fallbackId: ID.unique() }) as RunRecord;
        return hydrateTrackerCloudRun(entry, ownerUserId, username) as RunRecord;
      });
      const bulkRuns = hydratedImports.map(run => ({
        username,
        runData: run,
      }));
      const { added, updated } = await bulkUpsertLocalRuns(userId, bulkRuns);
      imported = added + updated;
      logger.info('[reconcile] imported cloud-only runs', { userId, imported });
    }
  }

  // ── Step 6: Verify counts ────────────────────────────────────────────────
  // allCloudIds is from Step 2. Step 3b uploaded unregistered runs since then,
  // so the actual cloud count is allCloudIds.size + uploadedUnregistered.
  // localIds was mutated in steps 3 and 3b:
  //   - cloud-deleted runs removed via localIds.delete()
  //   - unregistered uploads added via localIds.add()
  const finalCloudCount = allCloudIds.size + uploadedUnregistered;
  const finalLocalCount = localIds.size + imported;
  const synced = finalCloudCount === finalLocalCount;
  logger.info('[reconcile] sync complete', {
    userId,
    deleted,
    uploaded: uploadedUnregistered,
    imported,
    finalCloudCount,
    finalLocalCount,
    synced,
  });
  return { uploaded: uploadedUnregistered, deleted, imported, finalCloudCount, finalLocalCount, synced };
}

/**
 * Queries Appwrite only for runs whose $createdAt is after the last time we checked.
 * Persists the check timestamp so subsequent calls compare against real clock time,
 * not local run timestamps (which reflect game dates or bot-scan times, not upload times).
 * First call per user: falls back to hydrateRecentRunsFromCloud to establish the baseline.
 * After fetching new runs, calls reconcileLocalWithCloud (6-step sync) to upload any
 * local-only runs, import any cloud-only runs, and verify the counts match.
 */
async function hydrateNewRunsSinceLocal(userId: string, limit = 100): Promise<boolean> {
  try {
    const settings = await getLocalSettings(userId);
    if (!settings.cloudSyncEnabled) {
      logger.info('[delta-sync] skipped: cloudSyncEnabled=false', { userId });
      return false;
    }

    const { lookupUserIds } = await getRunCloudIdentity(userId);
    const lastCheckMs = await getTrackerKv<number>(`${LAST_DELTA_CHECK_KV_PREFIX}${userId}`).catch(() => null);
    logger.info('[delta-sync] starting', { userId, lookupUserIds, lastCheckMs, hasKv: !!lastCheckMs });

    if (!lastCheckMs) {
      logger.info('[delta-sync] no KV baseline — running recent-100 fallback', { userId });
      const result = await hydrateRecentRunsFromCloud(userId, limit);
      await setTrackerKv(`${LAST_DELTA_CHECK_KV_PREFIX}${userId}`, Date.now()).catch(() => {});
      logger.info('[delta-sync] recent-100 fallback result', { userId, found: result });
      return result;
    }

    const sinceIso = new Date(lastCheckMs - 2 * 60 * 1000).toISOString();
    const now = Date.now();
    logger.info('[delta-sync] querying since', { userId, sinceIso, lastCheckIso: new Date(lastCheckMs).toISOString() });

    const newRuns = await cloudGetRunsSince(userId, sinceIso, limit);
    logger.info('[delta-sync] cloudGetRunsSince returned', { userId, count: newRuns.length });
    await setTrackerKv(`${LAST_DELTA_CHECK_KV_PREFIX}${userId}`, now).catch(() => {});

    // Full bidirectional sync: upload local-only, import cloud-only, verify counts.
    const { uploaded, deleted, imported, synced } = await reconcileLocalWithCloud(userId).catch((err) => {
      logger.warn('[reconcile] bidirectional reconcile failed in delta-sync', { userId, err });
      return { uploaded: 0, deleted: 0, imported: 0, finalCloudCount: 0, finalLocalCount: 0, synced: false };
    });
    if (!synced) {
      logger.warn('[reconcile] count mismatch after sync — will retry on next tick', { userId });
    }

    if (!newRuns.length) return uploaded > 0 || deleted > 0 || imported > 0;

    const mergeResult = await mergeCloudRuns(userId, newRuns);
    logger.info('[delta-sync] merge result', { userId, added: mergeResult.added, updated: mergeResult.updated });
    return mergeResult.added > 0 || mergeResult.updated > 0 || uploaded > 0 || deleted > 0 || imported > 0;
  } catch (error) {
    logger.warn('delta run hydration failed, falling back to recent fetch', error);
    return hydrateRecentRunsFromCloud(userId, limit);
  }
}

async function cloudGetSettings(userId: string): Promise<CloudTrackerSettings | null> {
  const { settingsDatabaseId, settingsCollectionId } = appwriteIds();
  const databases = createAppwriteClient().databases;

  try {
    const doc = await getDocumentOrNull<Record<string, unknown>>(
      databases,
      settingsDatabaseId,
      settingsCollectionId,
      userId,
    );
    if (!doc) return null;
    return {
      defaultTracker: 'Web',
      defaultRunType: pickString(doc.defaultRunType),
      scanLanguage: pickString(doc.scanLanguage),
      timezone: pickString(doc.timezone),
      decimalPreference: pickString(doc.decimalPreference),
      autoDetectDuplicates: typeof doc.autoDetectDuplicates === 'boolean' ? doc.autoDetectDuplicates : undefined,
      confirmBeforeSubmit: typeof doc.confirmBeforeSubmit === 'boolean' ? doc.confirmBeforeSubmit : undefined,
      shareNotes: typeof doc.shareNotes === 'boolean' ? doc.shareNotes : undefined,
      leaderboard: typeof doc.leaderboard === 'boolean' ? doc.leaderboard : undefined,
      messagingEnabled: typeof doc.messagingEnabled === 'boolean' ? doc.messagingEnabled : undefined,
      blockedUsers: typeof doc.blockedUsers === 'string' ? doc.blockedUsers : undefined,
      reactionNotificationsEnabled: typeof doc.reactionNotificationsEnabled === 'boolean' ? doc.reactionNotificationsEnabled : undefined,
      replyNotificationsEnabled: typeof doc.replyNotificationsEnabled === 'boolean' ? doc.replyNotificationsEnabled : undefined,
      updatedAt: pickString(doc.updatedAt) ?? pickString(doc.$updatedAt),
    };
  } catch (error) {
    const maybeError = error as { code?: number };
    if (maybeError.code === 404) return null;
    throw error;
  }
}

async function cloudEditSettings(userId: string, settings: Record<string, unknown>) {
  const { settingsDatabaseId, settingsCollectionId } = appwriteIds();

  const payload = stripUndefinedFields({
    defaultTracker: 'Web',
    defaultRunType: settings.defaultRunType,
    scanLanguage: settings.scanLanguage,
    timezone: settings.timezone,
    decimalPreference: settings.decimalPreference,
    autoDetectDuplicates: settings.autoDetectDuplicates,
    confirmBeforeSubmit: settings.confirmBeforeSubmit,
    shareNotes: settings.shareNotes,
    leaderboard: settings.leaderboard,
    messagingEnabled: settings.messagingEnabled,
    blockedUsers: settings.blockedUsers,
    reactionNotificationsEnabled: settings.reactionNotificationsEnabled,
    replyNotificationsEnabled: settings.replyNotificationsEnabled,
    updatedAt: Number.isFinite(Number(settings.updatedAt))
      ? new Date(Number(settings.updatedAt)).toISOString()
      : pickString(settings.updatedAt),
  });

  const fallbackPayload = stripUndefinedFields({
    defaultTracker: 'Web',
    scanLanguage: settings.scanLanguage,
    timezone: settings.timezone,
    autoDetectDuplicates: settings.autoDetectDuplicates,
    confirmBeforeSubmit: settings.confirmBeforeSubmit,
    shareNotes: settings.shareNotes,
    leaderboard: settings.leaderboard,
    messagingEnabled: settings.messagingEnabled,
    blockedUsers: settings.blockedUsers,
    reactionNotificationsEnabled: settings.reactionNotificationsEnabled,
    replyNotificationsEnabled: settings.replyNotificationsEnabled,
  });

  await createOrUpdateCloudDocumentWithFallback({
    databases: createAppwriteClient().databases,
    databaseId: settingsDatabaseId,
    collectionId: settingsCollectionId,
    documentId: userId,
    data: payload,
    fallbackData: fallbackPayload,
  });
  return true;
}

async function cloudDeleteRun(userId: string, runId: string) {
  const targetId = pickString(runId);
  if (!targetId) return false;

  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const deleteTarget = parseTrackerRunDeleteTarget({
    databaseId: runsDatabaseId,
    mainCollectionId: runsCollectionId,
    extendedCollectionId: RUNS_EXTENDED_COLLECTION_ID,
    runId: targetId,
  });
  logger.info('Deleting tracker run document', {
    userId,
    runId: deleteTarget.runId,
    databaseId: deleteTarget.databaseId,
    mainCollectionId: deleteTarget.mainCollectionId,
    extendedCollectionId: deleteTarget.extendedCollectionId,
  });
  await deleteTrackerRunCloudDocuments({
    databases: createAppwriteClient().databases,
    databaseId: deleteTarget.databaseId,
    mainCollectionId: deleteTarget.mainCollectionId,
    extendedCollectionId: deleteTarget.extendedCollectionId,
    runId: deleteTarget.runId,
    shouldIgnoreExtendedCollectionError: shouldIgnoreExtendedRunCollectionError,
  });

  logger.info('Deleted tracker run document', {
    userId,
    runId: deleteTarget.runId,
    databaseId: deleteTarget.databaseId,
    mainCollectionId: deleteTarget.mainCollectionId,
    extendedCollectionId: deleteTarget.extendedCollectionId,
  });

  return true;
}

async function pruneResolvedUpsertQueueItems(params: { userId: string; runId?: string | null; localId?: string | null }) {
  const targetRunId = pickString(params.runId);
  const targetLocalId = pickString(params.localId);
  if (!targetRunId && !targetLocalId) return;
  const targetReference = buildTrackerQueuedRunReferenceIdentity({
    localId: targetLocalId,
    runId: targetRunId,
  });

  const queueItems = await getQueueItems(params.userId);
  for (const item of queueItems) {
    if (item.op !== 'upsert') continue;
    if (!trackerRunReferencesSameEntry({
      left: targetReference,
      right: buildTrackerQueuedRunReferenceIdentity(item),
    })) continue;

    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }
}

async function pruneQueuedUpsertsShadowedByDeletes(userId: string): Promise<void> {
  const queueItems = await getQueueItems(userId);
  if (!queueItems.length) return;

  const deletedRunIds = new Set(
    queueItems
      .filter(item => item.op === 'delete')
      .map(item => pickString(item.runId))
      .filter((value): value is string => Boolean(value)),
  );

  if (!deletedRunIds.size) return;

  for (const item of queueItems) {
    if (item.op !== 'upsert') continue;
    const itemRunId = buildTrackerQueuedRunReferenceIdentity(item).runId;
    if (!itemRunId || !deletedRunIds.has(itemRunId)) continue;

    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }
}

async function pruneStaleQueuedUpserts(userId: string): Promise<void> {
  const queueItems = await getQueueItems(userId);
  if (!queueItems.length) return;

  const localRuns = await getLocalRuns(userId);
  if (!localRuns.length) return;

  const runIds = new Set(
    localRuns
      .map((run) => pickString(run.runId))
      .filter((value): value is string => Boolean(value)),
  );

  const localIdsWithRunId = new Set(
    localRuns
      .filter((run) => Boolean(pickString(run.runId)))
      .map((run) => pickString(run.localId))
      .filter((value): value is string => Boolean(value)),
  );

  for (const item of queueItems) {
    if (item.op !== 'upsert') continue;

    const itemReference = buildTrackerQueuedRunReferenceIdentity(item);
    const itemRunId = itemReference.runId;
    const itemLocalId = itemReference.localId;
    const resolvedByRunId = Boolean(itemRunId && runIds.has(itemRunId));
    const resolvedByLocalId = Boolean(itemLocalId && localIdsWithRunId.has(itemLocalId));

    if (!resolvedByRunId && !resolvedByLocalId) continue;

    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }
}

async function hasLocalRunReference(params: { userId: string; runId?: string | null; localId?: string | null }): Promise<boolean> {
  const targetRunId = pickString(params.runId);
  const targetLocalId = pickString(params.localId);
  if (!targetRunId && !targetLocalId) {
    return false;
  }

  const localRuns = await getLocalRuns(params.userId);
  return localRuns.some(run => trackerRunReferencesSameEntry({
    left: {
      runId: targetRunId,
      localId: targetLocalId,
    },
    right: {
      runId: pickString(run.runId),
      localId: pickString(run.localId),
    },
  }));
}

async function pruneQueuedUpsertsForDeletedRun(params: { userId: string; runId?: string | null; localId?: string | null }) {
  const targetRunId = pickString(params.runId)
  const targetLocalId = pickString(params.localId)
  if (!targetRunId && !targetLocalId) return

  const queueItems = await getQueueItems(params.userId)
  for (const item of queueItems) {
    if (item.op !== 'upsert') continue
    if (!trackerRunReferencesSameEntry({
      left: {
        runId: targetRunId,
        localId: targetLocalId,
      },
      right: buildTrackerQueuedRunReferenceIdentity(item),
    })) {
      continue
    }

    await cleanupQueuedScreenshot(item.screenshot ?? null)
    await removeQueueItem(item.id)
  }
}

async function syncQueuedRuns(userId: string) {
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) return;

  await pruneQueuedUpsertsShadowedByDeletes(userId);

  const queue = await getQueueItems(userId);
  const hasCloudIdentity = await resolveCloudOperationUserId(userId, 'queue replay');
  const replayQueue = hasCloudIdentity
    ? queue
    : queue.filter(item => item.op === 'delete' && Boolean(item.runId));
  if (!replayQueue.length) return;

  let shouldRefreshLeaderboard = false;
  let latestUsername = 'unknown';
  const settlement = await settleRetryQueueItems({
    items: replayQueue,
    getKey: item => item.id,
    getAttemptCount: item => item.retryCount,
    getNextRetryAt: item => item.nextRetryAt,
    maxRetryCount: MAX_QUEUE_RETRY_COUNT,
    processReadyItems: async readyItems => {
      const results: Array<{ key: string; status: 'succeeded' | 'failed'; error?: string }> = [];
      for (const item of readyItems) {
        try {
          if (item.op === 'upsert') {
            const queuedReference = buildTrackerQueuedRunReferenceIdentity(item);
            const localRunStillExists = await hasLocalRunReference({
              userId: item.userId,
              runId: queuedReference.runId,
              localId: queuedReference.localId,
            });

            if (!localRunStillExists) {
              await cleanupQueuedScreenshot(item.screenshot ?? null);
              results.push({ key: item.id, status: 'succeeded' });
              continue;
            }

            latestUsername = item.username || latestUsername;
            const queuedScreenshot = await loadQueuedScreenshot(item.screenshot ?? null);
            const res = await cloudLogRun({
              userId: item.userId,
              username: item.username,
              runData: item.runData ?? {},
              canonicalRunData: item.canonicalRunData ?? undefined,
              screenshot: queuedScreenshot,
            });
            const cloudRunId = (res as { runId?: unknown }).runId;
            const screenshotUrl = pickString((res as { screenshotUrl?: unknown }).screenshotUrl);
            if (cloudRunId) {
              const localRunStillExistsAfterCloudWrite = await hasLocalRunReference({
                userId: item.userId,
                runId: pickString(cloudRunId) ?? queuedReference.runId,
                localId: item.localId ?? queuedReference.localId,
              });
              if (!localRunStillExistsAfterCloudWrite) {
                await cloudDeleteRun(item.userId, String(cloudRunId));
                results.push({ key: item.id, status: 'succeeded' });
                continue;
              }

              const localRunPayload = buildLocalRunUpsertPayload(item.runData || {}, item.canonicalRunData ?? null);
              await upsertLocalRun(item.userId, item.username, {
                ...localRunPayload,
                runId: String(cloudRunId),
                screenshotUrl: screenshotUrl ?? localRunPayload.screenshotUrl,
                localId: item.localId,
                updatedAt: Date.now(),
              });
              shouldRefreshLeaderboard = true;
            }
          } else if (item.op === 'settings') {
            const localSettingsRecord = await getLocalSettingsRecord(item.userId);
            const queuedUpdatedAt = Number.isFinite(Number(item.settingsUpdatedAt)) ? Number(item.settingsUpdatedAt) : 0;
            const localUpdatedAt = Number.isFinite(Number(localSettingsRecord.updatedAt)) ? Number(localSettingsRecord.updatedAt) : 0;
            const useLocalState = localUpdatedAt >= queuedUpdatedAt;
            const effectiveUpdatedAt = useLocalState ? localUpdatedAt : queuedUpdatedAt;
            const effectiveSettings = useLocalState
              ? localSettingsRecord.state
              : (item.settingsData ?? localSettingsRecord.state);
            await cloudEditSettings(item.userId, {
              ...effectiveSettings,
              updatedAt: effectiveUpdatedAt,
            });
          } else if (item.op === 'delete' && item.runId) {
            await cloudDeleteRun(item.userId, item.runId);
            shouldRefreshLeaderboard = true;
          }
          results.push({ key: item.id, status: 'succeeded' });
        } catch (error) {
          results.push({
            key: item.id,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Cloud sync failed',
          });
        }
      }
      return results;
    },
    updateFailedItem: item => item,
  });

  for (const item of settlement.exhaustedItems) {
    logger.warn('dropping stale queue item after max retries', {
      userId: item.userId,
      queueItemId: item.id,
      op: item.op,
      retryCount: item.retryCount,
    });
    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }

  for (const item of settlement.succeededItems) {
    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }

  for (const failure of settlement.failedItems) {
    await markQueueItemFailed(failure.item.id, failure.error ?? 'Cloud sync failed');
  }

  if (shouldRefreshLeaderboard) {
    await upsertCloudLeaderboardForUser(userId, latestUsername).catch(error => {
      logger.warn('cloud leaderboard refresh skipped after queue replay', error);
    });
  }
}

async function hydrateLocalRunsFromCloud(userId: string, username = 'unknown') {
  if (!canUseCloudForUserId(userId, 'run hydration')) return;
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) return;
  try {
    const cloudRuns = await cloudGetRuns(userId);
    const hydrated = cloudRuns.map(run => hydrateTrackerCloudRun(run, userId, username) as TrackerRun);
    await mergeCloudRuns(userId, hydrated);

    const cloudRunIds = new Set(
      hydrated
        .map(run => buildTrackerResolvedRunReference({ runData: run as RunRecord }).runId)
        .filter((runId): runId is string => typeof runId === 'string' && runId.trim().length > 0),
    );
    const queuedRunIds = new Set(
      (await getQueueItems(userId))
        .map(item => pickString(item.runId))
        .filter((runId): runId is string => typeof runId === 'string' && runId.trim().length > 0),
    );
    const staleLocalRuns = collectTrackerStaleCloudBackedLocalRunReferences({
      localEntries: await getLocalRuns(userId),
      cloudRunIds,
      queuedRunIds,
    })

    for (const staleLocalRun of staleLocalRuns) {
      await removeLocalRun(userId, { runId: staleLocalRun.runId, localId: staleLocalRun.localId })
    }

    runsHydratedAtByUser.set(userId, Date.now());
  } catch (error) {
    logger.warn('cloud run hydration skipped', error);
  }
}

async function hydrateLocalLifetimeFromCloud(userId: string) {
  if (!canUseCloudForUserId(userId, 'lifetime hydration')) return;
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) return;

  try {
    const cloudLifetime = await cloudGetLifetime(userId);
    if (!cloudLifetime) return;
    const localLifetime = await getLocalLifetime(userId);
    const mergedEntries = mergeLifetimeEntries(localLifetime.entries, cloudLifetime.entries);
    await updateLocalLifetime(userId, mergedEntries, Date.now());
    lifetimeHydratedAtByUser.set(userId, Date.now());
  } catch (error) {
    logger.warn('cloud lifetime hydration skipped', error);
  }
}

function shouldHydrateByCooldown(map: Map<string, number>, userId: string, cooldownMs: number): boolean {
  const last = map.get(userId) ?? 0;
  return Date.now() - last >= cooldownMs;
}

function normalizeDateStrForSort(raw: string): string {
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const parts = raw.split(/[/-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (c.length === 4) {
      const month = parseInt(a, 10) > 12 ? b : a;
      const day = parseInt(a, 10) > 12 ? a : b;
      return `${c}-${String(parseInt(month, 10)).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`;
    }
    if (c.length <= 2) {
      const year = `20${c}`;
      const month = parseInt(a, 10) > 12 ? b : a;
      const day = parseInt(a, 10) > 12 ? a : b;
      return `${year}-${String(parseInt(month, 10)).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`;
    }
  }
  return raw;
}

function summarizeRuns(runs: TrackerRun[]) {
  const byRunDateTimeDesc = (left: TrackerRun, right: TrackerRun): number => {
    const leftRunDate = normalizeDateStrForSort(String(left.runDate ?? left.date ?? ''));
    const rightRunDate = normalizeDateStrForSort(String(right.runDate ?? right.date ?? ''));
    const runDateCompare = rightRunDate.localeCompare(leftRunDate);
    if (runDateCompare !== 0) return runDateCompare;

    const leftRunTime = String(left.runTime ?? left.time ?? '');
    const rightRunTime = String(right.runTime ?? right.time ?? '');
    const runTimeCompare = rightRunTime.localeCompare(leftRunTime);
    if (runTimeCompare !== 0) return runTimeCompare;

    const leftDate = normalizeDateStrForSort(String(left.date ?? left.runDate ?? ''));
    const rightDate = normalizeDateStrForSort(String(right.date ?? right.runDate ?? ''));
    const dateCompare = rightDate.localeCompare(leftDate);
    if (dateCompare !== 0) return dateCompare;

    const leftTime = String(left.time ?? left.runTime ?? '');
    const rightTime = String(right.time ?? right.runTime ?? '');
    const timeCompare = rightTime.localeCompare(leftTime);
    if (timeCompare !== 0) return timeCompare;

    const leftTs = estimateTrackerRunTimestamp(left);
    const rightTs = estimateTrackerRunTimestamp(right);
    return rightTs - leftTs;
  };

  const sorted = [...runs].sort((a, b) => {
    return byRunDateTimeDesc(a, b);
  });

  const runTypeCounts: Record<string, number> = {};
  for (const run of sorted) {
    const type = run.type ? toCloudType(run.type) : 'Farming';
    runTypeCounts[type] = (runTypeCounts[type] ?? 0) + 1;
  }

  return {
    lastRun: sorted[0] ?? null,
    allRuns: sorted,
    runTypeCounts,
  };
}

export async function logRun(params: {
  userId: string;
  username: string;
  runData: RunRecord;
  canonicalRunData?: RunRecord | null;
  settings?: Record<string, unknown>;
  screenshot?: AttachmentPayload | null;
  deferredScreenshotSource?: { url: string; filename?: string | null; contentType?: string | null } | null;
  disableDuplicateLookup?: boolean;
  skipLeaderboardRefresh?: boolean;
  deferCloudSync?: boolean;
}) {
  const settings = await getLocalSettings(params.userId);
  let localOnlyScreenshotPatch: Record<string, unknown> = {};
  let localImageCapacityReached = false;

  if (settings.cloudSyncEnabled === false && params.screenshot) {
    const offlineScreenshot = await storeOfflineScreenshotForUser(params.userId, params.screenshot);
    localImageCapacityReached = offlineScreenshot.capacityReached;
    if (offlineScreenshot.localPath) {
      localOnlyScreenshotPatch = {
        localScreenshotPath: offlineScreenshot.localPath,
        localScreenshotName: params.screenshot.filename,
      };
    }
  }

  const localRunPayload = buildLocalRunUpsertPayload(params.runData, params.canonicalRunData ?? null);
  const local = await upsertLocalRun(params.userId, params.username, {
    ...localRunPayload,
    ...localOnlyScreenshotPatch,
    type: toCloudType(params.runData?.type),
    updatedAt: Date.now(),
  });
  const localReference = buildTrackerResolvedRunReference({
    localId: local.localId,
    runId: local.runId,
  });
  if (!settings.cloudSyncEnabled) {
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: true,
      localImageCapacityReached,
      localId: localReference.localId,
      runId: localReference.runId,
    };
  }

  if (!canUseCloudForUserId(params.userId, 'run log')) {
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: true,
      localImageCapacityReached,
      localId: localReference.localId,
      runId: localReference.runId,
    };
  }

  if (params.deferCloudSync) {
    const deferredReference = buildTrackerResolvedRunReference({
      localId: local.localId,
      runId: local.runId,
      runData: params.runData,
    });
    const deferredRunData = canonicalizeTrackerRunData({
      ...params.runData,
      localId: deferredReference.localId ?? undefined,
    });

    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: false,
      localImageCapacityReached,
      localId: deferredReference.localId,
      runId: deferredReference.runId,
      cloudSyncDeferred: true,
      backgroundSync: startDeferredRunCloudSync({
        userId: params.userId,
        username: params.username,
        runData: deferredRunData,
        canonicalRunData: params.canonicalRunData ?? null,
        screenshot: params.screenshot ?? null,
        deferredScreenshotSource: params.deferredScreenshotSource ?? null,
      }),
    };
  }

  try {
    const response = await cloudLogRun(params);
    const runId = (response as { runId?: unknown }).runId;
    const resolvedRunId = pickString(runId);
    const screenshotUrl = pickString((response as { screenshotUrl?: unknown }).screenshotUrl);
    if (runId) {
      await upsertLocalRun(params.userId, params.username, {
        ...local,
        runId: String(runId),
        screenshotUrl: screenshotUrl ?? local.screenshotUrl,
        updatedAt: Date.now(),
      });
    }
    await pruneResolvedUpsertQueueItems({
      userId: params.userId,
      runId: resolvedRunId,
      localId: buildTrackerResolvedRunReference({
        localId: local.localId,
        runData: params.runData,
      }).localId,
    });
    if (!params.skipLeaderboardRefresh) {
      void upsertCloudLeaderboardForUser(params.userId, params.username).catch(error => {
        logger.warn('cloud leaderboard update skipped after run log', error);
      });
    }
    return {
      ...(response as Record<string, unknown>),
      queuedForCloud: false,
      cloudUnavailable: false,
      localImageCapacityReached,
      ...buildTrackerResolvedRunReference({
        localId: local.localId,
        runId: resolvedRunId,
        fallbackRunId: local.runId,
      }),
    };
  } catch (error) {
    const queuedScreenshot = await storeQueuedScreenshot(params.userId, params.screenshot ?? null);
    await queueCloudUpsert({
      userId: params.userId,
      username: params.username,
      runData: { ...params.runData, localId: local.localId },
      canonicalRunData: params.canonicalRunData ?? undefined,
      screenshot: queuedScreenshot,
      localId: local.localId,
    });
    logger.warn('cloud log run unavailable; queued for retry', error);
    return {
      ok: true,
      queuedForCloud: true,
      cloudUnavailable: true,
      localOnly: false,
      localImageCapacityReached: false,
      localId: localReference.localId,
      runId: localReference.runId,
    };
  }
}

export async function getLastRun(userId: string, options?: GetLastRunOptions) {
  const syncMode = options?.cloudSyncMode ?? 'full';

  if (syncMode === 'none') {
    const runs = await getLocalRuns(userId);
    return summarizeRuns(runs);
  }

  if (canUseCloudForUserId(userId, 'summary sync')) {
    await syncQueuedRuns(userId);

    if (syncMode === 'latest') {
      // Delta check: only fetch runs newer than the most recent local run.
      // Returns in ~1 round-trip when nothing is new; falls back to recent-100 if no baseline.
      await hydrateNewRunsSinceLocal(userId, 100);
    } else {
      const localRunsBefore = await getLocalRuns(userId);
      if (localRunsBefore.length === 0 || shouldHydrateByCooldown(runsHydratedAtByUser, userId, RUNS_HYDRATION_COOLDOWN_MS)) {
        await hydrateLocalRunsFromCloud(userId, 'unknown');
      } else {
        // Within full-sync cooldown: still check the last 50 for any recent changes
        await hydrateRecentRunsFromCloud(userId, 50);
      }

      const localLifetimeBefore = await getLocalLifetime(userId);
      if ((localLifetimeBefore.entries?.length ?? 0) === 0 || shouldHydrateByCooldown(lifetimeHydratedAtByUser, userId, LIFETIME_HYDRATION_COOLDOWN_MS)) {
        await hydrateLocalLifetimeFromCloud(userId);
      }
    }
  }
  const runs = await getLocalRuns(userId);
  return summarizeRuns(runs);
}

export async function getLocalLifetimeData(userId: string) {
  const lifetime = await getLocalLifetime(userId);
  return lifetime.entries;
}

export async function editUserSettings(userId: string, settings: Record<string, unknown>) {
  const normalizedSettings = normalizeShareSettingsPatch(forceWebDefaultTrackerPatch(settings));
  const local = await updateLocalSettings(userId, normalizedSettings as Partial<TrackerSettings & { cloudSyncEnabled?: boolean }>);
  if (!local.cloudSyncEnabled) return true;
  if (!canUseCloudForUserId(userId, 'settings update')) return true;
  try {
    await cloudEditSettings(userId, normalizedSettings);
    if (normalizedSettings.cloudSyncEnabled === true) {
      await syncQueuedRuns(userId);
      await hydrateLocalRunsFromCloud(userId, 'unknown');
    }
    return true;
  } catch (error) {
    logger.warn('cloud settings update failed; local settings preserved', error);
    const localRecord = await getLocalSettingsRecord(userId);
    await queueCloudSettings({
      userId,
      settingsData: localRecord.state,
      settingsUpdatedAt: localRecord.updatedAt ?? Date.now(),
    });
    return true;
  }
}

export async function getCloudLeaderboardRows(options: {
  requestedTier: string;
  sourceFilter: 'all' | 'tower' | 'bemerged';
  verifiedOnly?: boolean;
}): Promise<Array<{ rank: number; metrics: Partial<Record<typeof trackerLeaderboardCanonicalMetrics[number], CloudLeaderboardEntry>> }>> {
  const { databases } = createAppwriteClient();
  const { leaderboardDatabaseId, leaderboardCollectionId } = appwriteIds();
  const bestByUserMetric = new Map<string, CloudLeaderboardEntry>();
  let cursorAfter: string | undefined;

  while (true) {
    const page = await databases.listDocuments(leaderboardDatabaseId, leaderboardCollectionId, [
      Query.limit(200),
      ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
    ]);
    const documents = Array.isArray(page.documents) ? page.documents : [];
    if (!documents.length) {
      break;
    }

    for (const rawDocument of documents) {
      if (!rawDocument || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
        continue;
      }

      const document = rawDocument as Record<string, unknown>;
      const documentId = pickString(document.$id) ?? null;
      const rawBlob = (() => {
        if (typeof document.data === 'string') {
          try {
            return JSON.parse(document.data) as unknown;
          } catch {
            return null;
          }
        }
        return document;
      })();
      if (!rawBlob) {
        continue;
      }

      let blob: ReturnType<typeof parseTrackerLeaderboardCompatibilityBlob>;
      try {
        blob = parseTrackerLeaderboardCompatibilityBlob(rawBlob);
      } catch {
        continue;
      }

      const fallbackUsername = pickString(blob.username) ?? null;
      const fallbackUserId = pickString(blob.userId) ?? documentId;

      for (const extractedCandidate of extractTrackerLeaderboardCompatibilityCandidates(blob, options.requestedTier, options.sourceFilter)) {
        const normalized = normalizeTrackerLeaderboardCompatibilityCandidate(
          extractedCandidate.metric,
          extractedCandidate.tier,
          extractedCandidate.candidate,
          fallbackUsername,
          fallbackUserId,
        );
        if (!normalized) {
          continue;
        }

        const candidateRecord = extractedCandidate.candidate && typeof extractedCandidate.candidate === 'object' && !Array.isArray(extractedCandidate.candidate)
          ? extractedCandidate.candidate as Record<string, unknown>
          : null;
        const verified = parseTrackerLeaderboardBooleanLike(candidateRecord?.isVerified ?? candidateRecord?.verified);
        if (options.verifiedOnly && !verified) {
          continue;
        }

        upsertTrackerLeaderboardBestEntry(bestByUserMetric, {
          ...normalized,
          verified,
        });
      }
    }

    if (documents.length < 200) {
      break;
    }

    const nextCursor = documents[documents.length - 1];
    if (!nextCursor || typeof nextCursor !== 'object' || Array.isArray(nextCursor)) {
      break;
    }

    cursorAfter = pickString((nextCursor as Record<string, unknown>).$id);
    if (!cursorAfter) {
      break;
    }
  }

  const entries = Array.from(bestByUserMetric.values());
  const metrics = trackerLeaderboardCanonicalMetrics.filter(metric => entries.some(entry => entry.metric === metric));
  return buildTrackerLeaderboardRankedMetricRows(entries, metrics);
}

export async function editRun(params: {
  userId: string;
  username: string;
  runData: RunRecord;
  canonicalRunData?: RunRecord | null;
  settings?: Record<string, unknown>;
  skipLeaderboardRefresh?: boolean;
  deferCloudSync?: boolean;
}) {
  const localRunPayload = buildLocalRunUpsertPayload(params.runData, params.canonicalRunData ?? null);
  const local = await upsertLocalRun(params.userId, params.username, { ...localRunPayload, updatedAt: Date.now() });
  const localReference = buildTrackerResolvedRunReference({
    localId: local.localId,
    runId: local.runId,
  });
  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) return { ok: true, queuedForCloud: false, cloudUnavailable: false, localOnly: true, localId: localReference.localId, runId: localReference.runId };
  if (!canUseCloudForUserId(params.userId, 'run edit')) return { ok: true, queuedForCloud: false, cloudUnavailable: false, localOnly: true, localId: localReference.localId, runId: localReference.runId };
  if (params.deferCloudSync) {
    const deferredReference = buildTrackerResolvedRunReference({
      localId: local.localId,
      runData: params.runData,
      fallbackRunId: local.runId,
    });
    const deferredRunData = canonicalizeTrackerRunData({
      ...params.runData,
      localId: deferredReference.localId ?? undefined,
    });

    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: false,
      localId: deferredReference.localId,
      runId: deferredReference.runId,
      cloudSyncDeferred: true,
      backgroundSync: startDeferredRunCloudSync({
        userId: params.userId,
        username: params.username,
        runData: deferredRunData,
        canonicalRunData: params.canonicalRunData ?? null,
      }),
    };
  }
  try {
    const ok = await cloudEditRun(params);
    const runReference = buildTrackerResolvedRunReference({ runData: params.runData });
    await pruneResolvedUpsertQueueItems({
      userId: params.userId,
      runId: runReference.runId,
      localId: runReference.localId,
    });
    if (!params.skipLeaderboardRefresh) {
      void upsertCloudLeaderboardForUser(params.userId, params.username).catch(error => {
        logger.warn('cloud leaderboard update skipped after run edit', error);
      });
    }
    return {
      ok,
      queuedForCloud: false,
      cloudUnavailable: false,
      ...buildTrackerResolvedRunReference({
        localId: local.localId,
        runData: params.runData,
        fallbackRunId: local.runId,
      }),
    };
  } catch (error) {
    await queueCloudUpsert({
      userId: params.userId,
      username: params.username,
      runData: { ...params.runData },
      canonicalRunData: params.canonicalRunData ?? undefined,
      localId: buildTrackerResolvedRunReference({ runData: params.runData }).localId ?? undefined,
    });
    logger.warn('cloud edit run unavailable; queued for retry', error);
    return { ok: true, queuedForCloud: true, cloudUnavailable: true, localOnly: false, localId: localReference.localId, runId: localReference.runId };
  }
}

export async function getTotalRunCount(userId: string) {
  const summary = await getLastRun(userId);
  return summary?.allRuns?.length ?? 0;
}

export async function getLocalRunSummary(userId: string): Promise<{ totalRuns: number; runTypeCounts: Record<string, number> }> {
  const runs = await getLocalRuns(userId);
  const runTypeCounts: Record<string, number> = {};
  for (const run of runs) {
    const type = run.type ? toCloudType(run.type) : 'Farming';
    runTypeCounts[type] = (runTypeCounts[type] ?? 0) + 1;
  }
  return {
    totalRuns: runs.length,
    runTypeCounts,
  };
}

export async function getEffectiveQueueCount(userId: string): Promise<number> {
  await pruneStaleQueuedUpserts(userId);
  return getQueueItems(userId).then((items) => items.length);
}

export async function forceSyncQueuedRuns(userId: string): Promise<number> {
  await releaseQueuedItemsForImmediateRetry(userId);
  await syncQueuedRuns(userId);
  return getEffectiveQueueCount(userId);
}

export function beginBackgroundRunHydration(userId: string): void {
  if (!canUseCloudForUserId(userId, 'background run hydration')) return;
  const existing = backgroundRunHydrationByUser.get(userId);
  if (existing) return;

  const task = getLastRun(userId, { cloudSyncMode: 'full' })
    .then(() => undefined)
    .catch((error) => {
      logger.warn('background run hydration skipped', error);
    })
    .finally(() => {
      backgroundRunHydrationByUser.delete(userId);
    });

  backgroundRunHydrationByUser.set(userId, task);
}

export async function awaitBackgroundRunHydration(userId: string): Promise<void> {
  const task = backgroundRunHydrationByUser.get(userId);
  if (!task) return;
  await task;
}

export async function removeLastRun(params: { userId: string; runId?: string | null; localId?: string | null }) {
  const runId = pickString(params.runId);
  const localId = pickString(params.localId);
  const localIdentifier = runId ?? localId;
  if (!localIdentifier) return true;

  await awaitBackgroundRunHydration(params.userId);
  await removeLocalRun(params.userId, { runId, localId });
  await pruneQueuedUpsertsForDeletedRun(params);
  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) return true;
  if (!runId) {
    await removeLocalRun(params.userId, { runId, localId });
    return true;
  }
  try {
    const ok = await cloudDeleteRun(params.userId, runId);
    if (!ok) throw new Error('cloud delete failed');
    await upsertCloudLeaderboardForUser(params.userId, 'unknown').catch(error => {
      logger.warn('cloud leaderboard update skipped after run delete', error);
    });
    await removeLocalRun(params.userId, { runId, localId });
    return true;
  } catch (error) {
    await queueCloudDelete({ userId: params.userId, username: 'unknown', runId });
    logger.warn('cloud delete unavailable; queued for retry', error);
    await removeLocalRun(params.userId, { runId, localId });
    return true;
  }
}

export async function getUserStats(userId: string) {
  try {
    const summary = await getLastRun(userId);
    const data = summary?.allRuns ?? [];
    if (!Array.isArray(data)) {
      return {
        totalRuns: 0,
        highestWave: 0,
        highestTier: 0,
        longestRun: '0h0m0s',
        avgWave: 0,
        fastestRun: '0h0m0s',
        totalPlaytime: '0h0m0s',
      };
    }
    const runTimes = data.map(run => {
      const dur = typeof run.duration === 'string' ? run.duration : '0h0m0s';
      const parts = dur.split(/h|m|s/).filter(Boolean).map(Number);
      const [h = 0, m = 0, s = 0] = parts;
      return { totalSeconds: h * 3600 + m * 60 + s, duration: dur };
    });
    const longest = runTimes.reduce((a, b) => (a.totalSeconds > b.totalSeconds ? a : b), { totalSeconds: 0, duration: '0h0m0s' }).duration;
    const fastest = runTimes.reduce((a, b) => (a.totalSeconds < b.totalSeconds ? a : b), { totalSeconds: Number.MAX_SAFE_INTEGER, duration: '0h0m0s' }).duration;
    const highestWave = Math.max(...data.map(run => parseInt(String(run.wave ?? 0), 10) || 0));
    const highestTier = Math.max(...data.map(run => parseInt(String(run.tier ?? 0), 10) || 0));
    const avgWave = data.reduce((acc, run) => acc + (parseInt(String(run.wave ?? 0), 10) || 0), 0) / (data.length || 1);

    return {
      totalRuns: data.length,
      highestWave,
      highestTier,
      longestRun: longest,
      avgWave: Number.isFinite(avgWave) ? avgWave.toFixed(2) : 0,
      fastestRun: fastest,
      totalPlaytime: '0h0m0s',
    };
  } catch (error) {
    logger.error('tracker stats failed', error);
    return {
      totalRuns: 0,
      highestWave: 0,
      highestTier: 0,
      longestRun: '0h0m0s',
      avgWave: 0,
      fastestRun: '0h0m0s',
      totalPlaytime: '0h0m0s',
    };
  }
}

export async function submitRunSummary(params: { userId: string; username: string; runData: RunDataPayload; note?: string; screenshot?: AttachmentPayload | null }) {
  if (!canUseCloudForUserId(params.userId, 'summary submit')) {
    throw new Error('Linked Appwrite account required before cloud submission is allowed.');
  }
  return cloudSubmitRunSummary(params);
}

export async function getUserSettings(userId: string): Promise<TrackerSettings | null> {
  const localRecord = await getLocalSettingsRecord(userId);
  const local = normalizeShareSettingsDefaults(forceWebDefaultTrackerSettings(localRecord.state));
  const cloudEnabled = local.cloudSyncEnabled !== false;
  if (!cloudEnabled) return local;
  if (!canUseCloudForUserId(userId, 'settings fetch')) return local;

  try {
    const cloud = await cloudGetSettings(userId);
    if (!cloud) return local;
    const remoteUpdatedAt = Date.parse(String(cloud.updatedAt ?? ''));
    const localUpdatedAt = Number.isFinite(Number(localRecord.updatedAt)) ? Number(localRecord.updatedAt) : 0;
    const shouldHydrateLocal = !localRecord.updatedAt || (Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > localUpdatedAt);
    if (!shouldHydrateLocal) {
      return local;
    }

    const merged = normalizeShareSettingsDefaults(forceWebDefaultTrackerSettings({ ...local, ...cloud, cloudSyncEnabled: local.cloudSyncEnabled }));
    await updateLocalSettings(userId, {
      ...merged,
      updatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : Date.now(),
    });
    return merged;
  } catch (error) {
    logger.warn('tracker settings fetch failed', error);
    return local;
  }
}
