import { Databases, ID, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import { isUnauthorizedAppwriteError } from './appwrite-error-utils';
import type { AnalyticsEventDocument } from './types';

export class AnalyticsRepo {
  constructor(private readonly databases: Databases) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.analyticsCollectionId };
  }

  async log(event: AnalyticsEventDocument) {
    const { databaseId, collectionId } = this.ids;
    const payload: AnalyticsEventDocument = {
      ts: event.ts ?? new Date().toISOString(),
      event: event.event,
      userId: event.userId,
      guildId: event.guildId,
      commandName: event.commandName,
      runId: event.runId,
      meta: event.meta,
    };
    try {
      await this.databases.createDocument(databaseId, collectionId, ID.unique(), payload);
    } catch (error) {
      if (!isUnauthorizedAppwriteError(error)) throw error;
      logger.warn('Skipping analytics write: Appwrite authorization unavailable');
    }
  }

  async listBetween(startIso: string, endIso: string) {
    const { databaseId, collectionId } = this.ids;
    try {
      const res = await this.databases.listDocuments(databaseId, collectionId, [
        Query.greaterThanEqual('ts', startIso),
        Query.lessThanEqual('ts', endIso),
        Query.limit(1000),
      ]);
      return res.documents as unknown as AnalyticsEventDocument[];
    } catch (error) {
      if (!isUnauthorizedAppwriteError(error)) throw error;
      logger.warn('Skipping analytics read: Appwrite authorization unavailable');
      return [];
    }
  }
}
