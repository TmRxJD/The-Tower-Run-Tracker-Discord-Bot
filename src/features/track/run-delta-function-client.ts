import { TRACKER_RUN_DELTA_PATCH_FUNCTION_ID, TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT } from '@tmrxjd/platform/tools';
import { getAppConfig } from '../../config';
import { logger } from '../../core/logger';

export type TrackerRunDeltaPageCursor = {
  pageOffset: number;
};

export type TrackerRunDeltaFunctionResult = {
  success: boolean;
  count: number;
  runs: Record<string, unknown>[];
  syncedAtMs: number;
  nextPage: TrackerRunDeltaPageCursor | null;
  userId: string;
  cloudUserId: string;
};

function parseExecutionResponseBody(responseBody: unknown): TrackerRunDeltaFunctionResult | null {
  if (typeof responseBody !== 'string' || responseBody.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    if (parsed.success !== true) {
      return null;
    }

    const runs = Array.isArray(parsed.runs)
      ? parsed.runs.filter((entry): entry is Record<string, unknown> => (
        entry !== null && typeof entry === 'object'
      ))
      : [];

    const nextPageRaw = parsed.nextPage;
    const nextPage = nextPageRaw && typeof nextPageRaw === 'object' && !Array.isArray(nextPageRaw)
      ? {
        pageOffset: Number.isFinite(Number((nextPageRaw as Record<string, unknown>).pageOffset))
          ? Math.floor(Number((nextPageRaw as Record<string, unknown>).pageOffset))
          : 0,
      }
      : null;

    return {
      success: true,
      count: Number.isFinite(Number(parsed.count)) ? Number(parsed.count) : runs.length,
      runs,
      syncedAtMs: Number.isFinite(Number(parsed.syncedAtMs)) ? Number(parsed.syncedAtMs) : Date.now(),
      nextPage: nextPage && nextPage.pageOffset > 0 ? nextPage : null,
      userId: String(parsed.userId ?? ''),
      cloudUserId: String(parsed.cloudUserId ?? ''),
    };
  } catch {
    return null;
  }
}

export function resolveTrackerRunDeltaPatchFunctionId(): string {
  const fromEnv = process.env.APPWRITE_FN_TRACKER_RUN_DELTA_PATCH_ID?.trim();
  return fromEnv || TRACKER_RUN_DELTA_PATCH_FUNCTION_ID;
}

export async function fetchTrackerRunDeltasFromFunction(input: {
  userId: string;
  cloudUserId: string;
  lookupUserIds?: string[];
  lastSyncedAtMs: number;
  pageOffset?: number;
  limit?: number;
}): Promise<TrackerRunDeltaFunctionResult> {
  const config = getAppConfig();
  const apiKey = config.appwrite.apiKey?.trim();
  if (!apiKey) {
    throw new Error('APPWRITE_API_KEY is required to call tracker-run-delta-patch');
  }

  const functionId = resolveTrackerRunDeltaPatchFunctionId();
  const endpoint = config.appwrite.endpoint.replace(/\/$/, '');
  const payload = {
    action: 'delta',
    userId: input.userId,
    cloudUserId: input.cloudUserId,
    ...(input.lookupUserIds?.length ? { lookupUserIds: input.lookupUserIds } : {}),
    lastSyncedAtMs: input.lastSyncedAtMs,
    ...(input.pageOffset && input.pageOffset > 0 ? { pageOffset: input.pageOffset } : {}),
    limit: input.limit ?? TRACKER_RUN_DELTA_PATCH_PAGE_LIMIT,
  };

  const response = await fetch(`${endpoint}/functions/${encodeURIComponent(functionId)}/executions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': config.appwrite.projectId,
      'X-Appwrite-Key': apiKey,
    },
    body: JSON.stringify({
      async: false,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }),
  });

  const execution = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof execution?.message === 'string' ? execution.message : `Function execution failed: ${response.status}`;
    throw new Error(message);
  }

  const parsed = parseExecutionResponseBody(execution?.responseBody);
  if (!parsed) {
    let responsePreview = '';
    if (typeof execution?.responseBody === 'string') {
      responsePreview = execution.responseBody.slice(0, 500);
    }
    logger.warn('[delta-function] unexpected execution response', {
      functionId,
      status: execution?.status,
      responseStatus: execution?.responseStatusCode,
      responsePreview,
    });
    throw new Error('tracker-run-delta-patch returned an invalid response payload');
  }

  logger.debug('[delta-function] execution complete', {
    functionId,
    userId: input.userId,
    cloudUserId: input.cloudUserId,
    count: parsed.count,
    syncedAtMs: parsed.syncedAtMs,
    lastSyncedAtMs: input.lastSyncedAtMs,
  });

  return parsed;
}
