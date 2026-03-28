import { z } from 'zod';

const isoTimestampSchema = z.string().trim().min(1).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const optionalSettingStringSchema = z.string().trim().min(1).optional();

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

export const userSettingsDocumentSchema = z.object({
  userId: z.string().trim().min(1),
  username: optionalSettingStringSchema,
  defaultTracker: optionalSettingStringSchema,
  defaultRunType: optionalSettingStringSchema,
  scanLanguage: optionalSettingStringSchema,
  decimalPreference: optionalSettingStringSchema,
  shareSettings: optionalSettingStringSchema,
  lastSeen: isoTimestampSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
}).strict();

export interface AnalyticsEventDocument {
  ts: string;
  event: string;
  userId?: string;
  guildId?: string;
  commandName?: string;
  runId?: string;
  meta?: string;
}
