import { z } from 'zod';

export interface AttachmentPayload {
  data: Buffer;
  filename: string;
  contentType?: string | null;
}

export interface RunDataPayload {
  [key: string]: string | number | null | undefined;
}

export interface RunSummaryView {
  tier?: string;
  wave?: string;
  duration?: string;
  coins?: string;
  cells?: string;
  dice?: string;
  killedBy?: string;
  runType?: string;
  battleDate?: string;
  note?: string;
  coinsPerHour?: string;
  cellsPerHour?: string;
  dicePerHour?: string;
}

export interface TrackerSettings {
  defaultTracker?: string;
  defaultRunType?: string;
  scanLanguage?: string;
  timezone?: string;
  decimalPreference?: string;
  autoDetectDuplicates?: boolean;
  confirmBeforeSubmit?: boolean;
  shareNotes?: boolean;
  shareCoverage?: boolean;
  shareScreenshot?: boolean;
  shareTier?: boolean;
  shareWave?: boolean;
  shareDuration?: boolean;
  shareKilledBy?: boolean;
  shareTotalCoins?: boolean;
  shareTotalCells?: boolean;
  shareTotalDice?: boolean;
  shareDeathDefy?: boolean;
  shareCoinsPerHour?: boolean;
  shareCellsPerHour?: boolean;
  shareDicePerHour?: boolean;
  logChannelId?: string;
  logChannelGuildId?: string;
  logChannelCategoryId?: string;
  leaderboard?: boolean;
  messagingEnabled?: boolean;
  blockedUsers?: string | string[];
  reactionNotificationsEnabled?: boolean;
  replyNotificationsEnabled?: boolean;
  cloudSyncEnabled?: boolean;
}

export const trackerSettingsSchema = z.object({
  defaultTracker: z.string().optional(),
  defaultRunType: z.string().optional(),
  scanLanguage: z.string().optional(),
  timezone: z.string().optional(),
  decimalPreference: z.string().optional(),
  autoDetectDuplicates: z.boolean().optional(),
  confirmBeforeSubmit: z.boolean().optional(),
  shareNotes: z.boolean().optional(),
  shareCoverage: z.boolean().optional(),
  shareScreenshot: z.boolean().optional(),
  shareTier: z.boolean().optional(),
  shareWave: z.boolean().optional(),
  shareDuration: z.boolean().optional(),
  shareKilledBy: z.boolean().optional(),
  shareTotalCoins: z.boolean().optional(),
  shareTotalCells: z.boolean().optional(),
  shareTotalDice: z.boolean().optional(),
  shareDeathDefy: z.boolean().optional(),
  shareCoinsPerHour: z.boolean().optional(),
  shareCellsPerHour: z.boolean().optional(),
  shareDicePerHour: z.boolean().optional(),
  logChannelId: z.string().optional(),
  logChannelGuildId: z.string().optional(),
  logChannelCategoryId: z.string().optional(),
  leaderboard: z.boolean().optional(),
  messagingEnabled: z.boolean().optional(),
  blockedUsers: z.union([z.string(), z.array(z.string())]).optional(),
  reactionNotificationsEnabled: z.boolean().optional(),
  replyNotificationsEnabled: z.boolean().optional(),
  cloudSyncEnabled: z.boolean().optional(),
});

export const trackerStoredSettingsSchema = trackerSettingsSchema.extend({
  updatedAt: z.number().finite().nonnegative().optional(),
});
