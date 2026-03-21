import type { ConfigsRepo } from '../persistence/configs-repo';
import { loadCachedJsonConfig } from './config-loader-shared';

export interface BotConfigPayload {
  [key: string]: unknown;
}

interface CachedConfig {
  version: string;
  payload: BotConfigPayload;
}

const botCache = new Map<string, CachedConfig>();

export async function loadBotConfig(repo: ConfigsRepo): Promise<BotConfigPayload | null> {
  return loadCachedJsonConfig(botCache, env => repo.getBotConfig(env));
}
