import { Client, Databases, Storage } from 'node-appwrite';
import { createAppwriteClientBundle, resolveAppwriteCredential } from '@tmrxjd/platform/node';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';

type AppwriteClientBundle = {
  client: Client;
  databases: Databases;
  storage: Storage;
};

let cachedBundle: AppwriteClientBundle | null = null;
let hasLoggedCredentialSource = false;
let hasLoggedMissingCredential = false;

export function createAppwriteClient() {
  if (cachedBundle) return cachedBundle;

  const cfg = getAppConfig();
  const credential = resolveAppwriteCredential({
    apiKey: cfg.appwrite.apiKey,
    apiKeyEnvValue: process.env.APPWRITE_API_KEY,
    jwt: process.env.APPWRITE_JWT,
    session: process.env.APPWRITE_SESSION,
  });

  if (credential.kind === 'apiKey') {
    if (!hasLoggedCredentialSource) {
      logger.info(`Using Appwrite API credential source: ${credential.apiKeySource}`);
      hasLoggedCredentialSource = true;
    }
  } else if (credential.kind === 'none') {
    if (!hasLoggedMissingCredential) {
      logger.warn('No Appwrite credential found (APPWRITE_API_KEY/APPWRITE_JWT/APPWRITE_SESSION). Discord login does not authorize Appwrite; bot will run local-only until credentials are provided.');
      hasLoggedMissingCredential = true;
    }
  }

  const bundle = createAppwriteClientBundle({
    client: new Client(),
    endpoint: cfg.appwrite.endpoint,
    projectId: cfg.appwrite.projectId,
    credential,
    createDatabases: client => new Databases(client),
    createStorage: client => new Storage(client),
  });

  cachedBundle = {
    client: bundle.client,
    databases: bundle.databases,
    storage: bundle.storage,
  };
  return cachedBundle;
}
