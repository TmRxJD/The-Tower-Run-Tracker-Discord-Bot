import { Databases, ID, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import type { GuildDocument } from './types';

export class GuildsRepo {
  constructor(private readonly databases: Databases) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.guildsCollectionId };
  }

  async addGuild(guildId: string) {
    const { databaseId, collectionId } = this.ids;
    try {
      await this.databases.createDocument(databaseId, collectionId, ID.unique(), {
        guildId,
        firstSeen: new Date().toISOString(),
      } as GuildDocument);
    } catch (err) {
      const maybeErr = err as { code?: number };
      if (maybeErr.code === 409) {
        logger.debug(`Guild ${guildId} already exists`);
        return;
      }
      throw err;
    }
  }

  async removeGuild(guildId: string) {
    const { databaseId, collectionId } = this.ids;
    const list = await this.databases.listDocuments(databaseId, collectionId, [
      Query.equal('guildId', guildId),
    ]);
    const doc = list.documents[0];
    if (!doc) return;
    await this.databases.deleteDocument(databaseId, collectionId, doc.$id);
  }
}
