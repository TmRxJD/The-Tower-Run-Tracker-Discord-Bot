import { ID, Permission, Query, Role } from 'node-appwrite';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  buildTrackerLeaderboardRankedMetricRows,
  buildTrackerLeaderboardPayload,
  buildTrackerLeaderboardCloudDocument,
  buildTrackerLifetimeCloudWritePayload,
  buildTrackerRunCloudWritePayload,
  buildTrackerRunMainDocumentPayload,
  TRACKER_RUN_EXTENDED_FIELDS,
  buildTrackerRunIdentityKey,
  buildTrackerRunLookupUserIds,
  TRACKER_RUN_MAIN_COLLECTION_META_FIELDS,
  TRACKER_RUN_MAIN_COLLECTION_OPTIONAL_FIELDS,
  buildTrackerRunOwnerUserId,
  buildTrackerRunPermissionUserIds,
  createOrUpdateCloudDocumentWithFallback,
  collectTrackerRunScalarFields,
  createOrUpdateCloudDocument,
  deleteCloudDocumentIfExists,
  estimateTrackerRunTimestamp,
  extractOcrTextLines,
  extractTrackerLeaderboardCompatibilityCandidates,
  extractTrackerRunCoverageData,
  hasMaterialTrackerRunEntryChange,
  hydrateTrackerCloudRun,
  hydrateTrackerRunEntryFromDocument,
  listCloudDocumentsByUserIds,
  listFirstCloudDocument,
  normalizeTrackerLeaderboardCompatibilityCandidate,
  normalizeTrackerLifetimeDate,
  normalizeTrackerLifetimeEntryValues,
  parseTrackerLeaderboardBooleanLike,
  parseTrackerLeaderboardCompatibilityBlob,
  normalizeTrackerRunMetricValue,
  normalizeTrackerRunTextValue,
  normalizeTrackerRunType,
  parseTrackerLifetimeCloudWrite,
  parseDiscordToAppwriteMapFromEnv,
  pickTrackerRunField,
  compareTrackerVerificationSnapshots,
  createTrackerVerificationSnapshot,
  isTrackerAppwriteUserId,
  isTrackerCloudAddressableUserId,
  isTrackerDiscordSnowflake,
  resolveCanonicalAppwriteUserId,
  sanitizeTrackerRunCloudPayload,
  sanitizeTrackerLeaderboardDocumentId,
  stripUndefinedFields,
  syncTrackerRunExtendedDocument,
  TRACKER_RUN_OPTIONAL_STRING_FIELDS,
  trackerLeaderboardCanonicalMetrics,
  trackerRunsShareDuplicateIdentity,
  trackerLifetimeCloudDocumentSchema,
  trackerRunCloudDocumentSchema,
  upsertTrackerLeaderboardBestEntry,
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
import { canonicalizeTrackerRunData, serializeTrackerRunForCloudAttributes } from './shared/run-data-normalization';
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
  upsertLocalRun,
  updateLocalLifetime,
  updateLocalSettings,
} from './local-run-store';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
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
const DISCORD_TO_APPWRITE_MAP = parseDiscordToAppwriteMapFromEnv(process.env);

type GetLastRunOptions = {
  cloudSyncMode?: 'full' | 'latest' | 'none';
};

function decodeBase64UrlSegment(segment: string): string | null {
  const normalized = segment.trim();
  if (!normalized) return null;

  const padded = normalized.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const base64 = remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`;

  try {
    return Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function resolveDevJwtAppwriteUserId(): string | null {
  if (getAppConfig().deploymentMode !== 'dev') {
    return null;
  }

  const jwt = process.env.APPWRITE_JWT?.trim();
  if (!jwt) {
    return null;
  }

  const payloadSegment = jwt.split('.')[1]?.trim();
  if (!payloadSegment) {
    return null;
  }

  const decoded = decodeBase64UrlSegment(payloadSegment);
  if (!decoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(decoded) as { userId?: unknown };
    const candidate = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
    return isTrackerAppwriteUserId(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function getRunCloudIdentity(userId: string): {
  ownerUserId: string;
  lookupUserIds: string[];
  permissionUserIds: string[];
} {
  const normalized = userId.trim();
  const canonicalCandidate = resolveCanonicalAppwriteUserId(normalized, DISCORD_TO_APPWRITE_MAP);
  const mappedAppwriteUserId = canonicalCandidate && isTrackerAppwriteUserId(canonicalCandidate)
    ? canonicalCandidate
    : resolveDevJwtAppwriteUserId();
  const ownerUserId = buildTrackerRunOwnerUserId({
    discordUserId: isTrackerDiscordSnowflake(normalized) ? normalized : null,
    appwriteUserId: isTrackerAppwriteUserId(normalized) ? normalized : mappedAppwriteUserId,
  }) ?? normalized;

  return {
    ownerUserId,
    lookupUserIds: buildTrackerRunLookupUserIds({
      ownerUserId,
      appwriteUserId: mappedAppwriteUserId,
      extraUserIds: [normalized],
    }),
    permissionUserIds: buildTrackerRunPermissionUserIds({
      appwriteUserId: mappedAppwriteUserId,
    }),
  };
}

function canUseCloudForUserId(userId: string, operation: string): boolean {
  if (isTrackerCloudAddressableUserId(userId)) return true;
  logger.warn(`Skipping cloud ${operation}: missing cloud-addressable user ID`, { userId });
  return false;
}

export async function shouldShowMigrationNoticeForUser(userId: string): Promise<boolean> {
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
  return {
    runsDatabaseId: cfg.appwrite.runsDatabaseId,
    runsCollectionId: cfg.appwrite.runsCollectionId,
    settingsDatabaseId: cfg.appwrite.settingsDatabaseId,
    settingsCollectionId: cfg.appwrite.settingsCollectionId,
    lifetimeDatabaseId: cfg.appwrite.lifetimeDatabaseId,
    lifetimeCollectionId: cfg.appwrite.lifetimeCollectionId,
    leaderboardDatabaseId: cfg.appwrite.leaderboardDatabaseId,
    leaderboardCollectionId: cfg.appwrite.leaderboardCollectionId,
  };
}

const RUN_DOCUMENTS_PAGE_SIZE = 100;
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
  const { lookupUserIds } = getRunCloudIdentity(userId);

  const baseDocuments = await listCloudDocumentsByUserIds({
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
  });

  const extendedDocuments = await listExtendedRunDocumentsForUser(userId);
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
  return isCollectionNotFoundError(error) || isUnauthorizedAppwriteError(error);
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
  const { lookupUserIds } = getRunCloudIdentity(userId);
  const documents: RunRecord[] = [];

  try {
    for (const candidateUserId of lookupUserIds) {
      let cursorAfter: string | null = null;

      while (true) {
        const page: { documents?: unknown[] } = await databases.listDocuments(runsDatabaseId, RUNS_EXTENDED_COLLECTION_ID, [
          Query.equal('userId', candidateUserId),
          Query.limit(RUN_DOCUMENTS_PAGE_SIZE),
          ...(cursorAfter ? [Query.cursorAfter(cursorAfter)] : []),
        ]);

        const pageDocuments: RunRecord[] = Array.isArray(page.documents) ? page.documents as RunRecord[] : [];
        if (!pageDocuments.length) break;

        documents.push(...pageDocuments);

        const last: RunRecord | undefined = pageDocuments[pageDocuments.length - 1];
        const lastId: string = typeof last?.$id === 'string' ? last.$id.trim() : '';
        if (!lastId || pageDocuments.length < RUN_DOCUMENTS_PAGE_SIZE) break;
        cursorAfter = lastId;
      }
    }
  } catch (error) {
    if (shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('Skipping tracker extended run document read', {
        userId,
        reason: error instanceof Error ? error.message : 'unavailable',
      });
      return [];
    }
    throw error;
  }

  return documents;
}

async function syncExtendedRunDocument(params: {
  runsDatabaseId: string;
  runId: string;
  userId: string;
  run: RunRecord;
  permissionUserIds: string[];
}): Promise<void> {
  const permissions = params.permissionUserIds.length
    ? params.permissionUserIds.flatMap((permissionUserId) => ([
        Permission.read(Role.user(permissionUserId)),
        Permission.update(Role.user(permissionUserId)),
        Permission.delete(Role.user(permissionUserId)),
      ]))
    : undefined;

  try {
    await syncTrackerRunExtendedDocument({
      databases: createAppwriteClient().databases,
      databaseId: params.runsDatabaseId,
      collectionId: RUNS_EXTENDED_COLLECTION_ID,
      runId: params.runId,
      userId: params.userId,
      run: params.run,
      schemaVersion: RUNS_EXTENDED_SCHEMA_VERSION,
      ...(permissions ? { permissions } : {}),
      shouldIgnoreCollectionError: shouldIgnoreExtendedRunCollectionError,
    });
  } catch (error) {
    if (shouldIgnoreExtendedRunCollectionError(error)) {
      logger.warn('Skipping tracker extended run document sync', {
        runId: params.runId,
        reason: error instanceof Error ? error.message : 'unavailable',
      });
      return;
    }
    throw error;
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

  const existingRuns = await getLocalRuns(userId);
  const knownKeys = new Set(existingRuns.map(run => buildTrackerRunIdentityKey(run as RunRecord)));
  let processed = 0;
  let added = 0;
  let updated = 0;

  for (const run of hydratedRuns) {
    const runRecord = run as RunRecord;
    const username = pickString(runRecord.username) ?? 'unknown';
    const saved = await upsertLocalRun(userId, username, runRecord);
    const key = buildTrackerRunIdentityKey(saved as RunRecord);
    if (knownKeys.has(key)) {
      updated += 1;
    } else {
      knownKeys.add(key);
      added += 1;
    }

    processed += 1;
    if (options?.onProgress) {
      await options.onProgress({ processed, total, percent: migrationPercent(processed, total) });
    }
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
  const { lookupUserIds } = getRunCloudIdentity(userId);
  const baseDocuments = await listCloudDocumentsByUserIds({
    databases,
    databaseId: runsDatabaseId,
    collectionId: runsCollectionId,
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
  });

  const extendedDocuments = await listExtendedRunDocumentsForUser(userId);
  return mergeRunDocumentsWithExtended(baseDocuments, extendedDocuments);
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
  const { ownerUserId, permissionUserIds } = getRunCloudIdentity(params.userId);

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

  for (;;) {
    try {
      await createOrUpdateCloudDocument({
        databases,
        databaseId: runsDatabaseId,
        collectionId: runsCollectionId,
        documentId,
        data: writePayload,
        ...(permissions.length ? { permissions } : {}),
      });
      break;
    } catch (error) {
      const unsupportedAttribute = getUnsupportedAttributeFromInvalidStructureError(error);
      if (!unsupportedAttribute || !(unsupportedAttribute in writePayload)) {
        throw error;
      }

      delete writePayload[unsupportedAttribute];
      strippedUnsupportedFields.push(unsupportedAttribute);
    }
  }

  if (strippedUnsupportedFields.length > 0) {
    logger.warn('run write stripped unsupported Appwrite attributes', {
      userId: params.userId,
      documentId,
      strippedUnsupportedFields,
    });
  }

  await syncExtendedRunDocument({
    runsDatabaseId,
    runId: documentId,
    userId: ownerUserId,
    run: params.run,
    permissionUserIds,
  });

  return { runId: documentId, screenshotUrl: pickString(payload.screenshotUrl) ?? null };
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
  const { runsBucketId } = getAppConfig().appwrite;
  const safeName = screenshot.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadName = `${userId}-${Date.now()}-${safeName}`;
  const file = new File([new Uint8Array(screenshot.data)], uploadName, {
    type: screenshot.contentType ?? 'application/octet-stream',
  });

  const uploaded = await storage.createFile(runsBucketId, ID.unique(), file);
  const uploadedId = pickString(uploaded.$id);
  if (!uploadedId) return null;

  const view = storage.getFileView(runsBucketId, uploadedId);
  return typeof view === 'string' ? view : String(view);
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
  const targetRunId = pickString(params.runData.runId) ?? pickString(params.runData.id);

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
      if (targetLocalId && item.localId === targetLocalId) return true;
      if (targetRunId && item.runId === targetRunId) return true;
      return false;
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

  const screenshotUrl = await uploadScreenshotIfPossible(params.userId, params.screenshot);
  const nextEntry = buildCloudRunEntry({
    userId: params.userId,
    username: params.username,
    runData: normalizedInput,
    canonicalRunData: params.canonicalRunData,
    screenshotUrl,
    existingEntry: existing,
  });

  if (existing && !hasMaterialTrackerRunEntryChange(existing, nextEntry)) {
    return {
      ok: true,
      runId: pickString(existing.id) ?? pickString(existing.runId),
      screenshotUrl: pickString(existing.screenshotUrl) ?? screenshotUrl ?? null,
    };
  }

  const saved = await writeRunDocument({
    userId: params.userId,
    username: params.username,
    run: nextEntry,
    existingDoc,
  });

  if (screenshotUrl) {
    logger.debug(`Uploaded screenshot for run write (${params.userId})`);
  }

  return { ok: true, runId: saved.runId, screenshotUrl: saved.screenshotUrl ?? screenshotUrl ?? null };
}

async function cloudEditRun(params: { userId: string; username: string; runData: RunRecord; settings?: Record<string, unknown> }) {
  const targetRunId = pickString(params.runData.runId) ?? pickString(params.runData.id) ?? null;
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

async function cloudGetLatestRun(userId: string): Promise<TrackerRun | null> {
  const { databases } = createAppwriteClient();
  const { runsDatabaseId, runsCollectionId } = appwriteIds();
  const page = await databases.listDocuments(runsDatabaseId, runsCollectionId, [
    Query.equal('userId', userId),
    Query.orderDesc('$createdAt'),
    Query.limit(1),
  ]);

  const doc = Array.isArray(page.documents) ? page.documents[0] as RunRecord | undefined : undefined;
  if (!doc) return null;

  const extended = await getDocumentOrNull(databases, runsDatabaseId, RUNS_EXTENDED_COLLECTION_ID, String(doc.$id ?? '')) as RunRecord | null;
  const mergedDoc = extended ? { ...doc, ...pickExtendedRunDocumentFields(extended) } : doc;

  const username = pickString(mergedDoc.username) ?? 'unknown';
  return hydrateTrackerCloudRun(mergedDoc, userId, username) as TrackerRun;
}

async function hydrateLatestRunFromCloud(userId: string): Promise<boolean> {
  try {
    const latest = await cloudGetLatestRun(userId);
    if (!latest) return false;
    const mergeResult = await mergeCloudRuns(userId, [latest]);
    runsHydratedAtByUser.set(userId, Date.now());
    return mergeResult.added > 0 || mergeResult.updated > 0;
  } catch (error) {
    logger.warn('latest run cloud hydration skipped due to error', error);
    return false;
  }
}

async function cloudGetSettings(userId: string): Promise<CloudTrackerSettings | null> {
  const { settingsDatabaseId, settingsCollectionId } = appwriteIds();
  const databases = createAppwriteClient().databases;

  try {
    const directDocument = await getDocumentOrNull<Record<string, unknown>>(
      databases,
      settingsDatabaseId,
      settingsCollectionId,
      userId,
    );
    const doc = directDocument ?? await listFirstCloudDocument<Record<string, unknown>>({
      databases,
      databaseId: settingsDatabaseId,
      collectionId: settingsCollectionId,
      queries: [
        Query.equal('userId', userId),
        Query.limit(1),
      ],
    });
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
  await deleteCloudDocumentIfExists({
    databases: createAppwriteClient().databases,
    databaseId: runsDatabaseId,
    collectionId: runsCollectionId,
    documentId: targetId,
  });

  try {
    await deleteCloudDocumentIfExists({
      databases: createAppwriteClient().databases,
      databaseId: runsDatabaseId,
      collectionId: RUNS_EXTENDED_COLLECTION_ID,
      documentId: targetId,
    });
  } catch (error) {
    if (!shouldIgnoreExtendedRunCollectionError(error)) {
      throw error;
    }
  }

  return true;
}

async function pruneResolvedUpsertQueueItems(params: { userId: string; runId?: string | null; localId?: string | null }) {
  const targetRunId = pickString(params.runId);
  const targetLocalId = pickString(params.localId);
  if (!targetRunId && !targetLocalId) return;

  const queueItems = await getQueueItems(params.userId);
  for (const item of queueItems) {
    if (item.op !== 'upsert') continue;
    const itemLocalId = pickString(item.localId) ?? pickString(item.runData?.localId);
    const itemRunId = pickString(item.runId) ?? pickString(item.runData?.runId);
    const localIdMatch = Boolean(targetLocalId && itemLocalId && targetLocalId === itemLocalId);
    const runIdMatch = Boolean(targetRunId && itemRunId && targetRunId === itemRunId);
    if (!localIdMatch && !runIdMatch) continue;

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

    const itemRunId = pickString(item.runId) ?? pickString(item.runData?.runId);
    const itemLocalId = pickString(item.localId) ?? pickString(item.runData?.localId);
    const resolvedByRunId = Boolean(itemRunId && runIds.has(itemRunId));
    const resolvedByLocalId = Boolean(itemLocalId && localIdsWithRunId.has(itemLocalId));

    if (!resolvedByRunId && !resolvedByLocalId) continue;

    await cleanupQueuedScreenshot(item.screenshot ?? null);
    await removeQueueItem(item.id);
  }
}

async function syncQueuedRuns(userId: string) {
  if (!canUseCloudForUserId(userId, 'queue replay')) return;
  const settings = await getLocalSettings(userId);
  if (!settings.cloudSyncEnabled) return;

  const queue = await getQueueItems(userId);
  let shouldRefreshLeaderboard = false;
  let latestUsername = 'unknown';
  for (const item of queue) {
    if ((item.retryCount ?? 0) >= MAX_QUEUE_RETRY_COUNT) {
      logger.warn('dropping stale queue item after max retries', {
        userId: item.userId,
        queueItemId: item.id,
        op: item.op,
        retryCount: item.retryCount,
      });
      await cleanupQueuedScreenshot(item.screenshot ?? null);
      await removeQueueItem(item.id);
      continue;
    }

    if (Number.isFinite(Number(item.nextRetryAt)) && Number(item.nextRetryAt) > Date.now()) {
      continue;
    }

    try {
      if (item.op === 'upsert') {
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
      await cleanupQueuedScreenshot(item.screenshot ?? null);
      await removeQueueItem(item.id);
    } catch (error) {
      await markQueueItemFailed(item.id, error instanceof Error ? error.message : 'Cloud sync failed');
    }
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

function summarizeRuns(runs: TrackerRun[]) {
  const byRunDateTimeDesc = (left: TrackerRun, right: TrackerRun): number => {
    const leftRunDate = String(left.runDate ?? left.date ?? '');
    const rightRunDate = String(right.runDate ?? right.date ?? '');
    const runDateCompare = rightRunDate.localeCompare(leftRunDate);
    if (runDateCompare !== 0) return runDateCompare;

    const leftRunTime = String(left.runTime ?? left.time ?? '');
    const rightRunTime = String(right.runTime ?? right.time ?? '');
    const runTimeCompare = rightRunTime.localeCompare(leftRunTime);
    if (runTimeCompare !== 0) return runTimeCompare;

    const leftDate = String(left.date ?? left.runDate ?? '');
    const rightDate = String(right.date ?? right.runDate ?? '');
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
  if (!settings.cloudSyncEnabled) {
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: true,
      localImageCapacityReached,
      localId: pickString(local.localId),
      runId: pickString(local.runId),
    };
  }

  if (!canUseCloudForUserId(params.userId, 'run log')) {
    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: true,
      localImageCapacityReached,
      localId: pickString(local.localId),
      runId: pickString(local.runId),
    };
  }

  if (params.deferCloudSync) {
    const deferredRunData = canonicalizeTrackerRunData({
      ...params.runData,
      localId: pickString(local.localId) ?? pickString(params.runData?.localId) ?? undefined,
    });

    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: false,
      localImageCapacityReached,
      localId: pickString(local.localId),
      runId: pickString(local.runId),
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
      localId: pickString(local.localId) ?? pickString(params.runData?.localId),
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
      localId: pickString(local.localId),
      runId: resolvedRunId ?? pickString(local.runId),
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
      localId: pickString(local.localId),
      runId: pickString(local.runId),
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
      await hydrateLatestRunFromCloud(userId);
    } else {
      const localRunsBefore = await getLocalRuns(userId);
      if (localRunsBefore.length === 0 || shouldHydrateByCooldown(runsHydratedAtByUser, userId, RUNS_HYDRATION_COOLDOWN_MS)) {
        await hydrateLocalRunsFromCloud(userId, 'unknown');
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
  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) return { ok: true, queuedForCloud: false, cloudUnavailable: false, localOnly: true, localId: pickString(local.localId), runId: pickString(local.runId) };
  if (!canUseCloudForUserId(params.userId, 'run edit')) return { ok: true, queuedForCloud: false, cloudUnavailable: false, localOnly: true, localId: pickString(local.localId), runId: pickString(local.runId) };
  if (params.deferCloudSync) {
    const deferredRunData = canonicalizeTrackerRunData({
      ...params.runData,
      localId: pickString(local.localId) ?? pickString(params.runData.localId) ?? undefined,
    });

    return {
      ok: true,
      queuedForCloud: false,
      cloudUnavailable: false,
      localOnly: false,
      localId: pickString(local.localId),
      runId: pickString(params.runData?.runId) ?? pickString(local.runId),
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
    await pruneResolvedUpsertQueueItems({
      userId: params.userId,
      runId: pickString(params.runData?.runId) ?? pickString(params.runData?.id),
      localId: pickString(params.runData?.localId),
    });
    if (!params.skipLeaderboardRefresh) {
      void upsertCloudLeaderboardForUser(params.userId, params.username).catch(error => {
        logger.warn('cloud leaderboard update skipped after run edit', error);
      });
    }
    return { ok, queuedForCloud: false, cloudUnavailable: false, localId: pickString(local.localId), runId: pickString(params.runData?.runId) ?? pickString(local.runId) };
  } catch (error) {
    await queueCloudUpsert({
      userId: params.userId,
      username: params.username,
      runData: { ...params.runData },
      canonicalRunData: params.canonicalRunData ?? undefined,
      localId: typeof params.runData.localId === 'string' ? params.runData.localId : undefined,
    });
    logger.warn('cloud edit run unavailable; queued for retry', error);
    return { ok: true, queuedForCloud: true, cloudUnavailable: true, localOnly: false, localId: pickString(local.localId), runId: pickString(local.runId) };
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

  await removeLocalRun(params.userId, localIdentifier);
  const settings = await getLocalSettings(params.userId);
  if (!settings.cloudSyncEnabled) return true;
  if (!runId) return true;
  if (!canUseCloudForUserId(params.userId, 'run delete')) return true;
  try {
    const ok = await cloudDeleteRun(params.userId, runId);
    if (!ok) throw new Error('cloud delete failed');
    await upsertCloudLeaderboardForUser(params.userId, 'unknown').catch(error => {
      logger.warn('cloud leaderboard update skipped after run delete', error);
    });
    return true;
  } catch (error) {
    await queueCloudDelete({ userId: params.userId, username: 'unknown', runId });
    logger.warn('cloud delete unavailable; queued for retry', error);
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
