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
