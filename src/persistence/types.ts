export interface UIConfigDocument {
  env: string;
  version: string;
  payload: string; // JSON string of ui config
  updatedAt: string;
}

export interface BotConfigDocument {
  env: string;
  version: string;
  payload: string; // JSON string of bot config
  updatedAt: string;
}

export interface GuildDocument {
  guildId: string;
  firstSeen?: string;
  guildPrefs?: string;
}

export interface UserSettingsDocument {
  userId: string;
  username?: string;
  defaultTracker?: string;
  defaultRunType?: string;
  scanLanguage?: string;
  decimalPreference?: string;
  shareSettings?: string;
  lastSeen?: string;
  updatedAt?: string;
}

export interface AnalyticsEventDocument {
  ts: string;
  event: string;
  userId?: string;
  guildId?: string;
  commandName?: string;
  runId?: string;
  meta?: string;
}
