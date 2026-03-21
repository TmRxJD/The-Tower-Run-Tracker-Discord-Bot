import { Databases, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import { isNotFoundAppwriteError, isUnauthorizedAppwriteError } from './appwrite-error-utils';
import type { UIConfigDocument, BotConfigDocument } from './types';

function isNonFatalConfigReadError(error: unknown): boolean {
  return isUnauthorizedAppwriteError(error) || isNotFoundAppwriteError(error);
}

export class ConfigsRepo {
  constructor(private readonly databases: Databases) {}

  private ids() {
    const cfg = getAppConfig();
    return {
      databaseId: cfg.appwrite.databaseId,
      uiCollectionId: cfg.appwrite.uiConfigCollectionId,
      botCollectionId: cfg.appwrite.botConfigCollectionId,
    };
  }

  async getUIConfig(env: string): Promise<UIConfigDocument | null> {
    const { databaseId, uiCollectionId } = this.ids();
    try {
      const res = await this.databases.listDocuments(databaseId, uiCollectionId, [Query.equal('env', env), Query.limit(1)]);
      const doc = res.documents[0];
      return doc ? (doc as unknown as UIConfigDocument) : null;
    } catch (error) {
      if (!isNonFatalConfigReadError(error)) throw error;
      logger.warn('UI config unavailable from Appwrite; using runtime defaults', {
        databaseId,
        collectionId: uiCollectionId,
        env,
        code: (error as { code?: unknown }).code,
        type: (error as { type?: unknown }).type,
      });
      return null;
    }
  }

  async getBotConfig(env: string): Promise<BotConfigDocument | null> {
    const { databaseId, botCollectionId } = this.ids();
    try {
      const res = await this.databases.listDocuments(databaseId, botCollectionId, [Query.equal('env', env), Query.limit(1)]);
      const doc = res.documents[0];
      return doc ? (doc as unknown as BotConfigDocument) : null;
    } catch (error) {
      if (!isNonFatalConfigReadError(error)) throw error;
      logger.warn('Bot config unavailable from Appwrite; using in-repo defaults', {
        databaseId,
        collectionId: botCollectionId,
        env,
        code: (error as { code?: unknown }).code,
        type: (error as { type?: unknown }).type,
      });
      return null;
    }
  }
}
