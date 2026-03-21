import { Databases, ID, Models, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import type { UserSettingsDocument } from './types';

export class UsersRepo {
  constructor(private readonly databases: Databases) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.userSettingsCollectionId };
  }

  async getByUserId(userId: string): Promise<Models.Document | null> {
    const { databaseId, collectionId } = this.ids;
    const res = await this.databases.listDocuments(databaseId, collectionId, [Query.equal('userId', userId), Query.limit(1)]);
    return res.documents[0] ?? null;
  }

  async upsertUser(settings: UserSettingsDocument) {
    const existing = await this.getByUserId(settings.userId);
    const { databaseId, collectionId } = this.ids;
    const payload = { ...settings, updatedAt: new Date().toISOString() };
    if (existing) {
      await this.databases.updateDocument(databaseId, collectionId, existing.$id, payload);
      return existing.$id;
    }
    const doc = await this.databases.createDocument(databaseId, collectionId, ID.unique(), payload);
    return doc.$id;
  }

  async touch(userId: string, username?: string) {
    await this.upsertUser({ userId, username, lastSeen: new Date().toISOString() });
  }
}
