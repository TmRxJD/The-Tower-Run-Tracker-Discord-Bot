import {
  normalizeSharedUserToolSettings,
  parseIsoTimestampToMillis,
  type RunDeltaMode,
  type SharedUserToolSettings,
} from '@tmrxjd/platform/tools';
import {
  isAppwriteUnknownAttributeError,
  resolveDocumentByCandidates,
} from '@tmrxjd/platform/node';
import { z } from 'zod';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import { createAppwriteClient } from '../persistence/appwrite-client';
import { resolveAppwriteIdForDiscordUser } from './discord-identity-resolver';

const sharedSettingsCloudDocumentSchema = z.object({
  cloudSyncEnabled: z.boolean().optional(),
  chartPalettePreset: z.string().nullish(),
  chartDataAlignment: z.string().nullish(),
  languagePreference: z.string().nullish(),
  dateFormatPreference: z.string().nullish(),
  decimalSeparatorPreference: z.string().nullish(),
  runDeltaMode: z.string().nullish(),
  updatedAt: z.string().nullish(),
  $updatedAt: z.string().nullish(),
}).passthrough();

const sharedSettingsCloudWriteSchema = z.object({
  cloudSyncEnabled: z.boolean(),
  chartPalettePreset: z.string(),
  chartDataAlignment: z.string().optional(),
  languagePreference: z.string(),
  dateFormatPreference: z.string(),
  decimalSeparatorPreference: z.string(),
  runDeltaMode: z.string().optional(),
});

const legacySharedSettingsCloudWriteSchema = z.object({
  cloudSyncEnabled: z.boolean(),
  chartPalettePreset: z.string(),
  chartDataAlignment: z.string().optional(),
});

export type SharedSettingsCloudLoadResult = {
  state: SharedUserToolSettings;
  updatedAt: number | null;
};

async function resolveCloudUserIdCandidates(userId: string): Promise<string[]> {
  const appwriteId = await resolveAppwriteIdForDiscordUser(userId);
  return Array.from(new Set([
    appwriteId ?? '',
    userId.trim(),
  ].filter(Boolean)));
}

function normalizeSharedSettingsDoc(doc: Record<string, unknown>): SharedUserToolSettings {
  const parsed = sharedSettingsCloudDocumentSchema.parse(doc);
  return normalizeSharedUserToolSettings({
    cloudSyncEnabled: parsed.cloudSyncEnabled,
    chartPalettePreset: parsed.chartPalettePreset ?? undefined,
    chartDataAlignment: parsed.chartDataAlignment ?? undefined,
    languagePreference: parsed.languagePreference ?? undefined,
    dateFormatPreference: parsed.dateFormatPreference ?? undefined,
    decimalSeparatorPreference: parsed.decimalSeparatorPreference ?? undefined,
    runDeltaMode: (parsed.runDeltaMode ?? undefined) as RunDeltaMode | undefined,
  });
}

async function getResolvedSettingsDocument(userId: string): Promise<{ documentId: string; document: Record<string, unknown> } | null> {
  const cfg = getAppConfig();
  const client = createAppwriteClient();
  if (!client?.databases) {
    return null;
  }

  return await resolveDocumentByCandidates({
    databases: client.databases,
    databaseId: cfg.appwrite.settingsDatabaseId,
    collectionId: cfg.appwrite.settingsCollectionId,
    candidateDocumentIds: await resolveCloudUserIdCandidates(userId),
  });
}

async function writeSettingsDocumentWithFallback(input: {
  mode: 'create' | 'update';
  documentId: string;
  fullPayload: Record<string, unknown>;
  legacyPayload: Record<string, unknown>;
}): Promise<void> {
  const cfg = getAppConfig();
  const client = createAppwriteClient();
  if (!client?.databases) {
    return;
  }

  const write = input.mode === 'update'
    ? (payload: Record<string, unknown>) => client.databases.updateDocument(
        cfg.appwrite.settingsDatabaseId,
        cfg.appwrite.settingsCollectionId,
        input.documentId,
        payload,
      )
    : (payload: Record<string, unknown>) => client.databases.createDocument(
        cfg.appwrite.settingsDatabaseId,
        cfg.appwrite.settingsCollectionId,
        input.documentId,
        payload,
      );

  try {
    await write(input.fullPayload);
  } catch (error) {
    if (!isAppwriteUnknownAttributeError(error)) {
      throw error;
    }

    await write(input.legacyPayload);
  }
}

export async function loadUserSharedSettingsCloud(userId: string): Promise<SharedSettingsCloudLoadResult | null> {
  try {
    const resolved = await getResolvedSettingsDocument(userId);
    const settingsDoc = resolved?.document;
    if (!settingsDoc) {
      return null;
    }

    return {
      state: normalizeSharedSettingsDoc(settingsDoc),
      updatedAt: parseIsoTimestampToMillis(settingsDoc.$updatedAt ?? settingsDoc.updatedAt),
    };
  } catch (error) {
    logger.warn('Failed loading tracker shared settings cloud state', error);
    return null;
  }
}

export async function saveUserSharedSettingsCloud(userId: string, settings: SharedUserToolSettings): Promise<boolean> {
  try {
    const cfg = getAppConfig();
    const client = createAppwriteClient();
    if (!client?.databases) {
      return false;
    }

    const normalized = normalizeSharedUserToolSettings(settings);
    const fullPayload = sharedSettingsCloudWriteSchema.parse({
      cloudSyncEnabled: normalized.cloudSyncEnabled,
      chartPalettePreset: normalized.chartPalettePreset,
      chartDataAlignment: normalized.chartDataAlignment,
      languagePreference: normalized.languagePreference,
      dateFormatPreference: normalized.dateFormatPreference,
      decimalSeparatorPreference: normalized.decimalSeparatorPreference,
      runDeltaMode: normalized.runDeltaMode,
    });
    const legacyPayload = legacySharedSettingsCloudWriteSchema.parse({
      cloudSyncEnabled: normalized.cloudSyncEnabled,
      chartPalettePreset: normalized.chartPalettePreset,
      chartDataAlignment: normalized.chartDataAlignment,
    });

    const candidates = await resolveCloudUserIdCandidates(userId);
    const targetDocumentId = candidates[0] ?? userId;
    const existing = await getResolvedSettingsDocument(userId);

    await writeSettingsDocumentWithFallback({
      mode: existing ? 'update' : 'create',
      documentId: existing?.documentId ?? targetDocumentId,
      fullPayload,
      legacyPayload,
    });
    void cfg;
    return true;
  } catch (error) {
    logger.warn('Failed saving tracker shared settings cloud state', error);
    return false;
  }
}
