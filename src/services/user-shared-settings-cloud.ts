import {
  normalizeSharedUserToolSettings,
  parseIsoTimestampToMillis,
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
import { parseDiscordToAppwriteMapFromEnv, resolveCanonicalAppwriteUserId } from '@tmrxjd/platform/tools';

const DISCORD_TO_APPWRITE_MAP = parseDiscordToAppwriteMapFromEnv(process.env);

const sharedSettingsCloudDocumentSchema = z.object({
  cloudSyncEnabled: z.boolean().optional(),
  chartPalettePreset: z.string().optional(),
  chartDataAlignment: z.string().optional(),
  languagePreference: z.string().optional(),
  dateFormatPreference: z.string().optional(),
  decimalSeparatorPreference: z.string().optional(),
  updatedAt: z.string().optional(),
  $updatedAt: z.string().optional(),
}).passthrough();

const sharedSettingsCloudWriteSchema = z.object({
  cloudSyncEnabled: z.boolean(),
  chartPalettePreset: z.string(),
  chartDataAlignment: z.string().optional(),
  languagePreference: z.string(),
  dateFormatPreference: z.string(),
  decimalSeparatorPreference: z.string(),
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

function resolveCloudUserIdCandidates(userId: string): string[] {
  const canonical = resolveCanonicalAppwriteUserId(userId, DISCORD_TO_APPWRITE_MAP);
  return Array.from(new Set([
    typeof canonical === 'string' ? canonical.trim() : '',
    userId.trim(),
  ].filter(Boolean)));
}

function normalizeSharedSettingsDoc(doc: Record<string, unknown>): SharedUserToolSettings {
  const parsed = sharedSettingsCloudDocumentSchema.parse(doc);
  return normalizeSharedUserToolSettings({
    cloudSyncEnabled: parsed.cloudSyncEnabled,
    chartPalettePreset: parsed.chartPalettePreset,
    chartDataAlignment: parsed.chartDataAlignment,
    languagePreference: parsed.languagePreference,
    dateFormatPreference: parsed.dateFormatPreference,
    decimalSeparatorPreference: parsed.decimalSeparatorPreference,
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
    candidateDocumentIds: resolveCloudUserIdCandidates(userId),
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
    });
    const legacyPayload = legacySharedSettingsCloudWriteSchema.parse({
      cloudSyncEnabled: normalized.cloudSyncEnabled,
      chartPalettePreset: normalized.chartPalettePreset,
      chartDataAlignment: normalized.chartDataAlignment,
    });

    const candidates = resolveCloudUserIdCandidates(userId);
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
