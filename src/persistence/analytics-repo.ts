import type { Databases } from 'node-appwrite';
import { isUnauthorizedAppwriteError } from '@tmrxjd/platform/node';
import { ID, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import type { AnalyticsEventDocument } from './types';
import { appendTrackerAnalyticsEvent, listTrackerAnalyticsBetween } from '../services/idb';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseAnalyticsEventDocument(document: unknown): AnalyticsEventDocument | null {
  if (!isRecord(document)) {
    return null;
  }

  const record = document;
  if (typeof record.ts !== 'string' || record.ts.trim().length === 0 || typeof record.event !== 'string' || record.event.trim().length === 0) {
    return null;
  }

  return {
    ts: record.ts,
    event: record.event,
    userId: typeof record.userId === 'string' ? record.userId : undefined,
    guildId: typeof record.guildId === 'string' ? record.guildId : undefined,
    commandName: typeof record.commandName === 'string' ? record.commandName : undefined,
    runId: typeof record.runId === 'string' ? record.runId : undefined,
    meta: typeof record.meta === 'string' ? record.meta : undefined,
  };
}

export class AnalyticsRepo {
  constructor(private readonly databases: Databases | null) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.analyticsCollectionId };
  }

  async log(event: AnalyticsEventDocument) {
    const payload: AnalyticsEventDocument = {
      ts: event.ts ?? new Date().toISOString(),
      event: event.event,
      userId: event.userId,
      guildId: event.guildId,
      commandName: event.commandName,
      runId: event.runId,
      meta: event.meta,
    };

    await appendTrackerAnalyticsEvent(payload);

    if (!this.databases) {
      return;
    }

    const { databaseId, collectionId } = this.ids;
    void this.databases.createDocument(databaseId, collectionId, ID.unique(), payload).catch((error: unknown) => {
      if (isUnauthorizedAppwriteError(error)) {
        logger.warn('Skipping analytics backup write: Appwrite authorization unavailable');
        return;
      }
      logger.warn('Analytics backup sync failed', error);
    });
  }

  async listBetween(startIso: string, endIso: string) {
    const local = await listTrackerAnalyticsBetween(startIso, endIso);
    if (local.length > 0 || !this.databases) {
      return local;
    }

    const { databaseId, collectionId } = this.ids;
    try {
      const res = await this.databases.listDocuments(databaseId, collectionId, [
        Query.greaterThanEqual('ts', startIso),
        Query.lessThanEqual('ts', endIso),
        Query.limit(1000),
      ]);
      const events = res.documents
        .map(parseAnalyticsEventDocument)
        .filter((event): event is AnalyticsEventDocument => event !== null);
      for (const event of events) {
        await appendTrackerAnalyticsEvent(event).catch(() => {});
      }
      return events;
    } catch (error) {
      if (!isUnauthorizedAppwriteError(error)) throw error;
      logger.warn('Skipping analytics hydration read: Appwrite authorization unavailable');
      return local;
    }
  }
}
