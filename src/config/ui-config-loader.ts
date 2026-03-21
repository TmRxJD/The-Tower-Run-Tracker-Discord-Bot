import type { ConfigsRepo } from '../persistence/configs-repo';
import { loadCachedJsonConfig } from './config-loader-shared';

export interface UIConfigPayload {
  // Structured config lives in Appwrite as JSON string; typed as unknown for now.
  [key: string]: unknown;
}

interface CachedConfig {
  version: string;
  payload: UIConfigPayload;
}

const uiCache = new Map<string, CachedConfig>();

export async function loadUIConfig(repo: ConfigsRepo): Promise<UIConfigPayload | null> {
  return loadCachedJsonConfig(uiCache, env => repo.getUIConfig(env));
}
