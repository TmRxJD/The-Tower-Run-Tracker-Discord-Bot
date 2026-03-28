/*
 * Creates Appwrite collections/attributes/indexes for Tracker Bot.
 * Safe to re-run: skips if resources already exist (409 conflict).
 */
import { Client, Databases, IndexType, OrderBy } from 'node-appwrite';
import { getAppConfig, loadConfig } from '../config';
import { logger } from '../core/logger';

function isConflict(err: unknown) {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 409;
}

async function ensureCollection(databases: Databases, databaseId: string, collectionId: string, name: string) {
  try {
    await databases.createCollection(databaseId, collectionId, name, []);
    logger.info(`Created collection ${collectionId}`);
  } catch (err) {
    if (isConflict(err)) {
      logger.debug(`Collection ${collectionId} already exists`);
      return;
    }
    throw err;
  }
}

async function ensureStringAttribute(databases: Databases, databaseId: string, collectionId: string, key: string, size: number, required = false, defaultValue?: string, array = false) {
  try {
    await databases.createStringAttribute(databaseId, collectionId, key, size, required, defaultValue, array);
    logger.info(`Created string attribute ${collectionId}.${key}`);
  } catch (err) {
    if (isConflict(err)) {
      logger.debug(`Attribute ${collectionId}.${key} already exists`);
      return;
    }
    throw err;
  }
}

async function ensureIntegerAttribute(databases: Databases, databaseId: string, collectionId: string, key: string, required = false, defaultValue?: number, array = false) {
  try {
    // Signature: (databaseId, collectionId, key, required, min?, max?, default?, array?)
    await databases.createIntegerAttribute(databaseId, collectionId, key, required, undefined, undefined, defaultValue, array);
    logger.info(`Created integer attribute ${collectionId}.${key}`);
  } catch (err) {
    if (isConflict(err)) {
      logger.debug(`Attribute ${collectionId}.${key} already exists`);
      return;
    }
    throw err;
  }
}

async function ensureDatetimeAttribute(databases: Databases, databaseId: string, collectionId: string, key: string, required = false, defaultValue?: string, array = false) {
  try {
    // Signature: (databaseId, collectionId, key, required, default?, array?)
    await databases.createDatetimeAttribute(databaseId, collectionId, key, required, defaultValue, array);
    logger.info(`Created datetime attribute ${collectionId}.${key}`);
  } catch (err) {
    if (isConflict(err)) {
      logger.debug(`Attribute ${collectionId}.${key} already exists`);
      return;
    }
    throw err;
  }
}

async function ensureIndex(databases: Databases, databaseId: string, collectionId: string, key: string, type: IndexType, attributes: string[], orders?: OrderBy[]) {
  try {
    await databases.createIndex(databaseId, collectionId, key, type, attributes, orders);
    logger.info(`Created index ${collectionId}.${key}`);
  } catch (err) {
    if (isConflict(err)) {
      logger.debug(`Index ${collectionId}.${key} already exists`);
      return;
    }
    throw err;
  }
}

async function main() {
  loadConfig();
  const cfg = getAppConfig();
  const adminKey = process.env.APPWRITE_ADMIN_API_KEY?.trim() || process.env.APPWRITE_API_KEY?.trim();

  if (!adminKey) {
    throw new Error('APPWRITE_ADMIN_API_KEY or APPWRITE_API_KEY is required to create schema. Add it to your .env.* files.');
  }

  const client = new Client()
    .setEndpoint(cfg.appwrite.endpoint)
    .setProject(cfg.appwrite.projectId)
    .setKey(adminKey);

  const databases = new Databases(client);
  const databaseId = cfg.appwrite.databaseId;

  const guildsCollectionId = process.env.APPWRITE_GUILDS_COLLECTION_ID ?? 'guilds';
  const usersCollectionId = cfg.appwrite.userSettingsCollectionId || 'users';
  const analyticsCollectionId = cfg.appwrite.analyticsCollectionId || 'analytics';

  // Collections
  await ensureCollection(databases, databaseId, guildsCollectionId, 'Guilds');
  await ensureCollection(databases, databaseId, usersCollectionId, 'Users');
  await ensureCollection(databases, databaseId, analyticsCollectionId, 'Analytics');

  // Guilds attributes/indexes
  await ensureStringAttribute(databases, databaseId, guildsCollectionId, 'guildId', 64, true);
  await ensureDatetimeAttribute(databases, databaseId, guildsCollectionId, 'firstSeen', false);
  await ensureStringAttribute(databases, databaseId, guildsCollectionId, 'guildPrefs', 4096, false);
  await ensureIndex(databases, databaseId, guildsCollectionId, 'guildId_unique', IndexType.Unique, ['guildId']);

  // Users attributes/indexes
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'userId', 64, true);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'username', 150, false);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'defaultTracker', 32, false);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'defaultRunType', 32, false);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'scanLanguage', 32, false);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'decimalPreference', 16, false);
  await ensureStringAttribute(databases, databaseId, usersCollectionId, 'shareSettings', 4096, false);
  await ensureDatetimeAttribute(databases, databaseId, usersCollectionId, 'lastSeen', false);
  await ensureDatetimeAttribute(databases, databaseId, usersCollectionId, 'updatedAt', false);
  await ensureIndex(databases, databaseId, usersCollectionId, 'userId_unique', IndexType.Unique, ['userId']);
  await ensureIndex(databases, databaseId, usersCollectionId, 'lastSeen_key', IndexType.Key, ['lastSeen'], [OrderBy.Desc]);

  // Analytics attributes/indexes
  await ensureDatetimeAttribute(databases, databaseId, analyticsCollectionId, 'ts', true);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'event', 64, true);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'userId', 64, false);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'guildId', 64, false);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'commandName', 64, false);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'runId', 64, false);
  await ensureStringAttribute(databases, databaseId, analyticsCollectionId, 'meta', 4096, false);
  await ensureIndex(databases, databaseId, analyticsCollectionId, 'ts_key', IndexType.Key, ['ts'], [OrderBy.Desc]);
  await ensureIndex(databases, databaseId, analyticsCollectionId, 'event_ts', IndexType.Key, ['event', 'ts'], [OrderBy.Asc, OrderBy.Desc]);
  await ensureIndex(databases, databaseId, analyticsCollectionId, 'user_ts', IndexType.Key, ['userId', 'ts'], [OrderBy.Asc, OrderBy.Desc]);
  await ensureIndex(databases, databaseId, analyticsCollectionId, 'command_ts', IndexType.Key, ['commandName', 'ts'], [OrderBy.Asc, OrderBy.Desc]);

  logger.info('Schema creation/check complete');
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Schema creation failed', message);
  process.exitCode = 1;
});
