import { Client, Databases, Storage } from 'node-appwrite';
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
  const client = new Client().setEndpoint(cfg.appwrite.endpoint).setProject(cfg.appwrite.projectId);

  const apiKey = cfg.appwrite.apiKey?.trim();
  const apiKeySource = ['APPWRITE_API_KEY', 'APPWRITE_FUNCTION_API_KEY', 'APPWRITE_KEY']
    .find(name => Boolean(process.env[name]?.trim())) ?? 'config';
  const sessionJwt = process.env.APPWRITE_JWT?.trim();
  const session = process.env.APPWRITE_SESSION?.trim();

  if (apiKey) {
    if (!hasLoggedCredentialSource) {
      logger.info(`Using Appwrite API credential source: ${apiKeySource}`);
      hasLoggedCredentialSource = true;
    }
    client.setKey(apiKey);
  } else if (sessionJwt) {
    client.setJWT(sessionJwt);
  } else if (session) {
    client.setSession(session);
  } else {
    if (!hasLoggedMissingCredential) {
      logger.warn('No Appwrite credential found (APPWRITE_API_KEY/APPWRITE_JWT/APPWRITE_SESSION). Discord login does not authorize Appwrite; bot will run local-only until credentials are provided.');
      hasLoggedMissingCredential = true;
    }
  }

  const databases = new Databases(client);
  const storage = new Storage(client);
  cachedBundle = { client, databases, storage };
  return cachedBundle;
}
