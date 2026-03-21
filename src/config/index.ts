import path from 'node:path';
import fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

export type DeploymentMode = 'dev' | 'prod';

function normalizeDeploymentMode(value: string | undefined): DeploymentMode {
  if (!value) return 'dev';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'prod';
  return 'dev';
}

export interface AppConfig {
  deploymentMode: DeploymentMode;
  discord: {
    token: string;
    clientId: string;
    guildId?: string;
  };
  ai: {
    cloudApiKey?: string;
    cloudEndpoint?: string;
    cloudVisionModel: string;
    timeoutMs: number;
  };
  daemon: {
    bridgeBaseUrl?: string;
    bridgeToken?: string;
  };
  appwrite: {
    endpoint: string;
    projectId: string;
    databaseId: string;
    runsDatabaseId: string;
    runsCollectionId: string;
    settingsDatabaseId: string;
    settingsCollectionId: string;
    runsBucketId: string;
    lifetimeDatabaseId: string;
    lifetimeCollectionId: string;
    leaderboardDatabaseId: string;
    leaderboardCollectionId: string;
    analyticsCollectionId: string;
    userSettingsCollectionId: string;
    guildsCollectionId: string;
    uiConfigCollectionId: string;
    botConfigCollectionId: string;
    configDocumentId: string;
    apiKey?: string;
  };
  trackerApi: {
    url: string;
    apiKey: string;
  } | null;
}

const envSchema = z.object({
  DEPLOYMENT_MODE: z.enum(['dev', 'prod']).default('dev'),
  DISCORD_TOKEN: z.string().min(1),
  CLIENT_ID: z.string().min(1),
  GUILD_ID: z.string().optional(),
  APPWRITE_ENDPOINT: z.string().url(),
  APPWRITE_PROJECT_ID: z.string().min(1),
  APPWRITE_DATABASE_ID: z.string().min(1),
  APPWRITE_RUNS_DATABASE_ID: z.string().min(1).optional(),
  APPWRITE_RUNS_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_SETTINGS_DATABASE_ID: z.string().min(1).optional(),
  APPWRITE_SETTINGS_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_RUNS_BUCKET_ID: z.string().min(1).optional(),
  APPWRITE_LIFETIME_DATABASE_ID: z.string().min(1).optional(),
  APPWRITE_LIFETIME_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_LEADERBOARD_DATABASE_ID: z.string().min(1).optional(),
  APPWRITE_LEADERBOARD_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_ANALYTICS_COLLECTION_ID: z.string().min(1),
  APPWRITE_USER_SETTINGS_COLLECTION_ID: z.string().min(1),
  APPWRITE_GUILDS_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_UI_CONFIG_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_BOT_CONFIG_COLLECTION_ID: z.string().min(1).optional(),
  APPWRITE_CONFIG_DOCUMENT_ID: z.string().min(1),
  APPWRITE_API_KEY: z.string().min(1).optional(),
  APPWRITE_FUNCTION_API_KEY: z.string().min(1).optional(),
  APPWRITE_KEY: z.string().min(1).optional(),
  TRACKERAI_BRIDGE_URL: z.string().url().optional(),
  TRACKERAI_BRIDGE_TOKEN: z.string().min(1).optional(),
  TRACKERAI_CLOUD_AI_ENDPOINT: z.string().url().optional(),
  TRACKERAI_CLOUD_AI_API_KEY: z.string().min(1).optional(),
  TRACKERAI_CLOUD_VISION_MODEL: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  TRACKER_API_URL: z.string().url().optional(),
  TRACKER_API_KEY: z.string().min(1).optional(),
});

let cachedConfig: AppConfig | null = null;

function resolveEnvRootCandidates(): string[] {
  const cwdRoot = process.cwd();
  const runtimeRoot = path.resolve(__dirname, '..', '..');
  const workspaceTrackerRoot = path.resolve(cwdRoot, 'discord', 'TrackerBot');
  const explicitRoot = process.env.TRACKERBOT_ENV_DIR?.trim();

  const candidates = [
    explicitRoot,
    runtimeRoot,
    workspaceTrackerRoot,
    cwdRoot,
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function hasAnyEnvFile(root: string, mode: DeploymentMode): boolean {
  return [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ].some(filename => fs.existsSync(path.resolve(root, filename)));
}

function loadEnvFilesFromRoot(root: string, mode: DeploymentMode): boolean {
  const orderedFilenames = [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ];

  let loadedAny = false;
  for (const filename of orderedFilenames) {
    const envPath = path.resolve(root, filename);
    if (!fs.existsSync(envPath)) {
      continue;
    }

    dotenvConfig({ path: envPath, override: true });
    loadedAny = true;
  }

  return loadedAny;
}

function applyDotenvFiles() {
  const mode = normalizeDeploymentMode(process.env.DEPLOYMENT_MODE ?? process.env.NODE_ENV);

  const envRoot = resolveEnvRootCandidates().find(root => hasAnyEnvFile(root, mode));
  if (envRoot) {
    loadEnvFilesFromRoot(envRoot, mode);
    return;
  }

  dotenvConfig();
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  applyDotenvFiles();
  process.env.DEPLOYMENT_MODE = normalizeDeploymentMode(process.env.DEPLOYMENT_MODE ?? process.env.NODE_ENV);
  const parsed = envSchema.parse(process.env);

  cachedConfig = {
    deploymentMode: parsed.DEPLOYMENT_MODE,
    discord: {
      token: parsed.DISCORD_TOKEN,
      clientId: parsed.CLIENT_ID,
      guildId: parsed.GUILD_ID,
    },
    ai: {
      cloudApiKey: parsed.TRACKERAI_CLOUD_AI_API_KEY,
      cloudEndpoint: parsed.TRACKERAI_CLOUD_AI_ENDPOINT,
      cloudVisionModel: firstNonEmpty(parsed.TRACKERAI_CLOUD_VISION_MODEL) ?? 'meta-llama/llama-4-scout-17-16e-instruct',
      timeoutMs: parsed.AI_TIMEOUT_MS ?? 20_000,
    },
    daemon: {
      bridgeBaseUrl: parsed.TRACKERAI_BRIDGE_URL,
      bridgeToken: parsed.TRACKERAI_BRIDGE_TOKEN,
    },
    appwrite: {
      endpoint: parsed.APPWRITE_ENDPOINT,
      projectId: parsed.APPWRITE_PROJECT_ID,
      databaseId: parsed.APPWRITE_DATABASE_ID,
      runsDatabaseId: parsed.APPWRITE_RUNS_DATABASE_ID ?? 'run-tracker-data',
      runsCollectionId: parsed.APPWRITE_RUNS_COLLECTION_ID ?? 'runs',
      settingsDatabaseId: parsed.APPWRITE_SETTINGS_DATABASE_ID ?? 'run-tracker-data',
      settingsCollectionId: parsed.APPWRITE_SETTINGS_COLLECTION_ID ?? 'settings',
      runsBucketId: parsed.APPWRITE_RUNS_BUCKET_ID ?? 'runs',
      lifetimeDatabaseId: parsed.APPWRITE_LIFETIME_DATABASE_ID ?? 'lifetime-stats-data',
      lifetimeCollectionId: parsed.APPWRITE_LIFETIME_COLLECTION_ID ?? 'lifetime-stats',
      leaderboardDatabaseId: parsed.APPWRITE_LEADERBOARD_DATABASE_ID ?? 'cloud-saves',
      leaderboardCollectionId: parsed.APPWRITE_LEADERBOARD_COLLECTION_ID ?? 'tracker_leaderboard',
      analyticsCollectionId: parsed.APPWRITE_ANALYTICS_COLLECTION_ID,
      userSettingsCollectionId: parsed.APPWRITE_USER_SETTINGS_COLLECTION_ID,
      guildsCollectionId: parsed.APPWRITE_GUILDS_COLLECTION_ID ?? 'guilds',
      uiConfigCollectionId: parsed.APPWRITE_UI_CONFIG_COLLECTION_ID ?? 'ui_config',
      botConfigCollectionId: parsed.APPWRITE_BOT_CONFIG_COLLECTION_ID ?? 'bot_config',
      configDocumentId: parsed.APPWRITE_CONFIG_DOCUMENT_ID,
      apiKey: parsed.APPWRITE_API_KEY ?? parsed.APPWRITE_FUNCTION_API_KEY ?? parsed.APPWRITE_KEY,
    },
    trackerApi: parsed.TRACKER_API_URL && parsed.TRACKER_API_KEY
      ? {
          url: parsed.TRACKER_API_URL,
          apiKey: parsed.TRACKER_API_KEY,
        }
      : null,
  };

  return cachedConfig;
}

export function getAppConfig(): AppConfig {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}
