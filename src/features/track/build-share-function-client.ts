import {
  TRACKER_BUILD_SHARE_FUNCTION_ID,
  type TrackerBuildShareFunctionResult,
} from '@tmrxjd/platform/tools';
import { getAppConfig } from '../../config';
import { logger } from '../../core/logger';
import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';

function parseExecutionResponseBody(responseBody: unknown): TrackerBuildShareFunctionResult | null {
  if (typeof responseBody !== 'string' || responseBody.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(responseBody) as TrackerBuildShareFunctionResult;
  } catch {
    return null;
  }
}

export function resolveTrackerBuildShareFunctionId(): string {
  const fromEnv = process.env.APPWRITE_FN_TRACKER_BUILD_SHARE_ID?.trim();
  return fromEnv || TRACKER_BUILD_SHARE_FUNCTION_ID;
}

export async function fetchTrackerBuildShareForDiscordUser(userId: string): Promise<TrackerBuildShareFunctionResult | null> {
  const config = getAppConfig();
  const apiKey = config.appwrite.apiKey?.trim();
  if (!apiKey) {
    logger.warn('[build-share] APPWRITE_API_KEY missing; skipping build share lookup');
    return null;
  }

  const cloudUserId = await resolveAppwriteIdForDiscordUser(userId);
  const candidateIds = Array.from(new Set([cloudUserId, userId.trim()].filter(Boolean)));
  const functionId = resolveTrackerBuildShareFunctionId();
  const endpoint = config.appwrite.endpoint.replace(/\/$/, '');

  for (const candidateId of candidateIds) {
    try {
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
          body: JSON.stringify({
            cloudUserId: candidateId,
            userId: candidateId,
          }),
        }),
      });

      const execution = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        continue;
      }

      const parsed = parseExecutionResponseBody(execution?.responseBody);
      if (parsed?.success) {
        return parsed;
      }
    } catch (error) {
      logger.warn('[build-share] function execution failed', error);
    }
  }

  return null;
}
