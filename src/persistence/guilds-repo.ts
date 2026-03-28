import type { Databases } from 'node-appwrite';
import { ID, Query } from 'node-appwrite';
import { listFirstCloudDocument } from '@tmrxjd/platform/tools';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import type { GuildDocument } from './types';
import { deleteTrackerGuild, getTrackerGuild, upsertTrackerGuild } from '../services/idb';

export class GuildsRepo {
  constructor(private readonly databases: Databases | null) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.guildsCollectionId };
  }

  async addGuild(guildId: string) {
    const existing = await getTrackerGuild(guildId);
    if (!existing) {
      await upsertTrackerGuild({
        guildId,
        firstSeen: new Date().toISOString(),
      });
    }

    if (!this.databases) {
      return;
    }

    const { databaseId, collectionId } = this.ids;
    const backupDocument: GuildDocument = {
      guildId,
      firstSeen: existing?.firstSeen ?? new Date().toISOString(),
    };
    void this.databases.createDocument(databaseId, collectionId, ID.unique(), {
      ...backupDocument,
    }).catch((err: unknown) => {
      const maybeErr = err as { code?: number };
      if (maybeErr.code === 409) {
        logger.debug(`Guild ${guildId} already exists remotely`);
        return;
      }
      logger.warn(`Guild backup sync failed for ${guildId}`, err);
    });
  }

  async removeGuild(guildId: string) {
    await deleteTrackerGuild(guildId);

    if (!this.databases) {
      return;
    }

    const { databaseId, collectionId } = this.ids;
    void (async () => {
      const doc = await listFirstCloudDocument<{ $id: string }>({
        databases: this.databases!,
        databaseId,
        collectionId,
        queries: [Query.equal('guildId', guildId)],
      });
      if (!doc) return;
      return this.databases?.deleteDocument(databaseId, collectionId, doc.$id);
    })().catch((error: unknown) => {
      logger.warn(`Guild backup delete failed for ${guildId}`, error);
    });
  }
}
