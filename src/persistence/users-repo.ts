import type { Databases } from 'node-appwrite';
import { ID, Query } from 'node-appwrite';
import { listFirstDocument } from '@tmrxjd/platform/node';
import { getAppConfig } from '../config';
import { type UserSettingsDocument, userSettingsDocumentSchema } from './types';
import { getTrackerUserSettings, upsertTrackerUserSettings } from '../services/idb';
import { logger } from '../core/logger';

type StoredUserDocument = UserSettingsDocument & { $id: string };

function toStoredUserDocument(document: UserSettingsDocument): StoredUserDocument {
  return {
    ...document,
    $id: document.userId,
  };
}

function parseComparableIso(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickValidIso(value: string | null | undefined): string | undefined {
  return parseComparableIso(value) !== null ? value ?? undefined : undefined;
}

function toHydratedUserDocument(userId: string, remote: Record<string, unknown>): UserSettingsDocument {
  const pickString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return userSettingsDocumentSchema.parse({
    userId: pickString(remote.userId) ?? userId,
    username: pickString(remote.username),
    defaultTracker: pickString(remote.defaultTracker),
    defaultRunType: pickString(remote.defaultRunType),
    scanLanguage: pickString(remote.scanLanguage),
    decimalPreference: pickString(remote.decimalPreference),
    shareSettings: pickString(remote.shareSettings),
    lastSeen: pickValidIso(pickString(remote.lastSeen)),
    updatedAt: pickValidIso(pickString(remote.updatedAt)) ?? pickValidIso(pickString(remote.$updatedAt)),
  });
}

export class UsersRepo {
  constructor(private readonly databases: Databases | null) {}

  private get ids() {
    const cfg = getAppConfig();
    return { databaseId: cfg.appwrite.databaseId, collectionId: cfg.appwrite.userSettingsCollectionId };
  }

  async getByUserId(userId: string): Promise<StoredUserDocument | null> {
    const local = await getTrackerUserSettings(userId);
    if (local) {
      if (this.databases) {
        const { databaseId, collectionId } = this.ids;
        void (async () => {
          try {
            const remote = await listFirstDocument<Record<string, unknown>>(
              this.databases!,
              databaseId,
              collectionId,
              [Query.equal('userId', userId), Query.limit(1)],
            );
            if (!remote) {
              return;
            }

            const hydrated = toHydratedUserDocument(userId, remote);
            const remoteUpdatedAt = parseComparableIso(hydrated.updatedAt);
            const localUpdatedAt = parseComparableIso(local.updatedAt);
            if (remoteUpdatedAt !== null && (localUpdatedAt === null || remoteUpdatedAt > localUpdatedAt)) {
              await upsertTrackerUserSettings(hydrated);
            }
          } catch (error) {
            logger.warn(`User refresh failed for ${userId}`, error);
          }
        })();
      }
      return toStoredUserDocument(local);
    }

    if (!this.databases) {
      return null;
    }

    const { databaseId, collectionId } = this.ids;
    try {
      const remote = await listFirstDocument<Record<string, unknown>>(
        this.databases,
        databaseId,
        collectionId,
        [Query.equal('userId', userId), Query.limit(1)],
      );
      if (!remote) {
        return null;
      }

      const hydrated = toHydratedUserDocument(userId, remote);
      await upsertTrackerUserSettings(hydrated);
      return toStoredUserDocument(hydrated);
    } catch (error) {
      logger.warn(`User hydration failed for ${userId}`, error);
      return null;
    }
  }

  async upsertUser(settings: UserSettingsDocument) {
    const payload = userSettingsDocumentSchema.parse({
      ...settings,
      updatedAt: new Date().toISOString(),
    });
    const existing = await this.getByUserId(settings.userId);
    await upsertTrackerUserSettings(payload);

    if (!this.databases) {
      return existing?.$id ?? settings.userId;
    }

    const { databaseId, collectionId } = this.ids;
    void (async () => {
      try {
        const remoteDoc = await listFirstDocument<{ $id: string }>(
          this.databases!,
          databaseId,
          collectionId,
          [Query.equal('userId', settings.userId), Query.limit(1)],
        );
        if (remoteDoc) {
          await this.databases!.updateDocument(databaseId, collectionId, remoteDoc.$id, payload);
          return;
        }
        await this.databases!.createDocument(databaseId, collectionId, ID.unique(), payload);
      } catch (error) {
        logger.warn(`User backup sync failed for ${settings.userId}`, error);
      }
    })();

    return existing?.$id ?? settings.userId;
  }

  async touch(userId: string, username?: string) {
    await this.upsertUser({ userId, username, lastSeen: new Date().toISOString() });
  }
}
