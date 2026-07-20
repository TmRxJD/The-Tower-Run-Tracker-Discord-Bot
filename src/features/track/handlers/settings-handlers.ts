import type {
  InteractionUpdateOptions,
  MessageComponentInteraction,
  ModalSubmitInteraction} from 'discord.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  formatGovernedDate,
  formatGovernedNumber,
  governedDateFormatOptions,
  governedDateFormatPreferenceIds,
  governedDecimalSeparatorOptions,
  governedDecimalSeparatorPreferenceIds,
  governedLanguageOptions,
  governedLanguagePreferenceIds,
  resolveGovernedLocaleSettings,
  type RunDeltaMode,
  type SharedUserToolSettings,
} from '@tmrxjd/platform/tools';
import { awaitOwnedModalSubmit } from '../../../core/interaction-session';
import { resolve } from 'node:path';
import { editUserSettings, forceSyncQueuedRuns, getEffectiveQueueCount, getUserSettings, getUserStats } from '../tracker-api-client';
import { TRACKER_IDS } from '../track-custom-ids';
import type { TrackerSettings } from '../types';
import { logError } from './error-handlers';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { buildEmbedUserFromInteraction } from '../discord-display-name';
import { buildShareEmbed } from '../share/share-embed';
import { buildPerHourChartAttachment } from '../ui/per-hour-chart-helpers';
import { getEffectiveUserSharedSettings, saveUserSharedSettings } from '../../../services/user-shared-settings-db';

type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;
type SettingsUpdatePayload = {
  content: string;
  components?: InteractionUpdateOptions['components'];
  embeds?: InteractionUpdateOptions['embeds'];
  files?: InteractionUpdateOptions['files'];
};

const LOG_CHANNEL_RESTRICTED_GUILD_ID = '850137217828388904';
const LOG_CHANNEL_RESTRICTED_MESSAGE = 'Log channels are not permitted in this server. "Please invite the bot to a private server and set a log channel there. See settings for invite button."';
const BOT_INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1345944489340043286';
const LANGUAGE_MENU_FALLBACK_LOCALE = 'en-US';

function getLanguageLocaleTag(languagePreference: SharedUserToolSettings['languagePreference']): string {
  if (languagePreference === 'auto') {
    return LANGUAGE_MENU_FALLBACK_LOCALE;
  }

  return governedLanguageOptions.find(option => option.id === languagePreference)?.locale ?? LANGUAGE_MENU_FALLBACK_LOCALE;
}

function formatSharedLanguageLabel(languagePreference: SharedUserToolSettings['languagePreference']): string {
  if (languagePreference === 'auto') {
    return 'Auto (Region Default)';
  }

  return governedLanguageOptions.find(option => option.id === languagePreference)?.label ?? languagePreference;
}

function formatDateFormatLabel(dateFormatPreference: SharedUserToolSettings['dateFormatPreference']): string {
  if (dateFormatPreference === 'auto') {
    return 'Auto (Region Default)';
  }

  return governedDateFormatOptions.find(option => option.id === dateFormatPreference)?.label ?? dateFormatPreference;
}

function formatDecimalSeparatorLabel(decimalSeparatorPreference: SharedUserToolSettings['decimalSeparatorPreference']): string {
  if (decimalSeparatorPreference === 'auto') {
    return 'Auto (Region Default)';
  }

  return governedDecimalSeparatorOptions.find(option => option.id === decimalSeparatorPreference)?.label ?? decimalSeparatorPreference;
}

function formatDeltaModeLabel(mode: RunDeltaMode): string {
  switch (mode) {
    case 'disabled': return 'Disabled';
    case '1day': return '1-Day Average';
    case '3day': return '3-Day Average';
    case '7day': return '7-Day Average';
    case 'last': return 'Last Run';
    default: return 'Unknown';
  }
}

function buildLocalePreview(sharedSettings: SharedUserToolSettings): string {
  const resolved = resolveGovernedLocaleSettings(sharedSettings, {
    localeTag: getLanguageLocaleTag(sharedSettings.languagePreference),
  });
  const sampleNumber = formatGovernedNumber(12345.67, resolved, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sampleDate = formatGovernedDate('2026-04-06T15:45:00Z', resolved);
  return `${sampleNumber} • ${sampleDate}`;
}

function extractChannelId(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const mentionMatch = /^<#(\d+)>$/.exec(value);
  if (mentionMatch) return mentionMatch[1] ?? null;
  const idMatch = /(\d{17,20})/.exec(value);
  if (!idMatch) return null;
  return idMatch[1] ?? null;
}

function canUpdate(interaction: TrackMenuInteraction): interaction is MessageComponentInteraction {
  return 'update' in interaction;
}

async function updateInPlace(interaction: TrackMenuInteraction, payload: SettingsUpdatePayload) {
  const files = payload.files ?? [];
  if (canUpdate(interaction) && !interaction.deferred && !interaction.replied) {
    await interaction.update({ content: payload.content, components: payload.components, embeds: payload.embeds, files }).catch(() => {});
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ content: payload.content, components: payload.components, embeds: payload.embeds, files }).catch(() => {});
}

function getSelectedValues(interaction: TrackMenuInteraction): string[] {
  if ('values' in interaction && Array.isArray(interaction.values)) {
    return interaction.values;
  }
  return [];
}

export async function handleTrackMenuSettings(interaction: TrackMenuInteraction) {
  const ui = getTrackUiConfig();
  try {
    if (canUpdate(interaction) && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    } else if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const settings = await getUserSettings(interaction.user.id);
    if (!settings) {
      await interaction.editReply({ content: ui.settings.noSettings, components: [], embeds: [], files: [] });
      return;
    }

    const payload = await buildSettingsPayload(interaction.user.id, settings);
    await interaction.editReply({
      content: payload.content,
      components: payload.components,
      embeds: payload.embeds,
      files: payload.files ?? [],
    });
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_settings');

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: ui.settings.loadFailed, components: [], embeds: [], files: [] }).catch(() => {});
      return;
    }

    if (canUpdate(interaction)) {
      await interaction.update({ content: ui.settings.loadFailed, components: [], embeds: [], files: [] }).catch(() => {});
      return;
    }

    await interaction.reply({ content: ui.settings.loadFailed, components: [], embeds: [], files: [] }).catch(() => {});
  }
}

export async function buildSettingsPayload(userId: string, current: TrackerSettings | null | undefined): Promise<SettingsUpdatePayload> {
  const ui = getTrackUiConfig();
  const settingsUi = ui.settings;
  const queued = await getEffectiveQueueCount(userId);
  const sharedSettings = await getEffectiveUserSharedSettings(userId);
  const cloudEnabled = current?.cloudSyncEnabled !== false;
  const duplicatesEnabled = current?.autoDetectDuplicates !== false;
  const confirmEnabled = current?.confirmBeforeSubmit !== false;
  const defaultRunType = current?.defaultRunType ?? 'Farming';
  const language = current?.scanLanguage ?? 'English';
  const timezone = current?.timezone ?? 'UTC';
  const logChannelId = typeof current?.logChannelId === 'string' ? current.logChannelId.trim() : '';
  const logChannelDisplay = logChannelId ? `<#${logChannelId}>` : 'Not configured';

  const settingsEmbed = new EmbedBuilder()
    .setTitle('⚙️ Tracker Settings')
    .setDescription('Use the buttons and dropdowns below to customize your tracking experience. Your changes will be saved automatically.')
    .addFields(
      { name: settingsUi.labels.defaultRunType, value: String(defaultRunType), inline: true },
      { name: settingsUi.labels.appLanguage ?? 'App language', value: formatSharedLanguageLabel(sharedSettings.languagePreference), inline: true },
      { name: settingsUi.labels.scanLanguage, value: String(language), inline: true },
      { name: settingsUi.labels.dateFormat ?? 'Date format', value: formatDateFormatLabel(sharedSettings.dateFormatPreference), inline: true },
      { name: settingsUi.labels.decimalIndicator ?? 'Decimal indicator', value: formatDecimalSeparatorLabel(sharedSettings.decimalSeparatorPreference), inline: true },
      { name: settingsUi.labels.timezone ?? 'Timezone', value: String(timezone), inline: true },
      { name: settingsUi.labels.autoDetectDuplicates, value: duplicatesEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.confirmBeforeSubmit, value: confirmEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.cloudSync, value: cloudEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.logChannel ?? 'Log channel', value: logChannelDisplay, inline: true },
      { name: 'Comparison Mode', value: formatDeltaModeLabel(sharedSettings.runDeltaMode), inline: true },
    )
    .setColor(0x3b82f6);

  if (queued > 0) {
    settingsEmbed.addFields({ name: settingsUi.labels.queuedCloudUploads, value: String(queued), inline: true });
  }

  const runTypeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.defaultType)
      .setPlaceholder(settingsUi.placeholders.runType)
      .addOptions(...settingsUi.runTypeOptions.map((item) => ({ label: item, value: item, default: defaultRunType === item }))),
  );

  const timezoneRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.timezone)
      .setPlaceholder(settingsUi.placeholders.timezone)
      .addOptions(...settingsUi.timezoneOptions.map((item) => ({ label: item, value: item, default: timezone === item }))),
  );

  const actionsButtons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.settings.duplicates)
      .setLabel(duplicatesEnabled ? settingsUi.buttons.disableDuplicates : settingsUi.buttons.enableDuplicates)
      .setStyle(duplicatesEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.settings.confirm)
      .setLabel(confirmEnabled ? settingsUi.buttons.disableConfirm : settingsUi.buttons.enableConfirm)
      .setStyle(confirmEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.settings.cloudToggle)
      .setLabel(cloudEnabled ? settingsUi.buttons.disableCloud : settingsUi.buttons.enableCloud)
      .setStyle(cloudEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
  ];

  if (queued > 0) {
    actionsButtons.push(
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.settings.forceSave)
        .setLabel(settingsUi.buttons.forceSave ?? 'Force Save')
        .setStyle(ButtonStyle.Primary),
    );
  }

  const actionsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...actionsButtons);

  const deltaModeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.deltaMode)
      .setPlaceholder('Comparison mode')
      .addOptions(
        { label: 'Disabled', value: 'disabled', description: 'No stat comparison shown', default: sharedSettings.runDeltaMode === 'disabled' },
        { label: '1-Day Average', value: '1day', description: 'Compare vs rolling 1-day average (same type)', default: sharedSettings.runDeltaMode === '1day' },
        { label: '3-Day Average', value: '3day', description: 'Compare vs rolling 3-day average (same type)', default: sharedSettings.runDeltaMode === '3day' },
        { label: '7-Day Average', value: '7day', description: 'Compare vs rolling 7-day average (same type)', default: sharedSettings.runDeltaMode === '7day' },
        { label: 'Last Run', value: 'last', description: 'Compare vs previous run of same type', default: sharedSettings.runDeltaMode === 'last' },
      ),
  );

  // Merge utility + navigation into one row (max 5 buttons, within Discord limit)
  const utilityNavRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.languageMenu).setLabel(settingsUi.buttons.languageMenu ?? 'Language & Locale').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.logChannel).setLabel(settingsUi.buttons.setLogChannel ?? 'Set Log Channel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.share).setLabel(settingsUi.buttons.shareSettings).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel(settingsUi.buttons.inviteBot ?? 'Invite Bot').setStyle(ButtonStyle.Link).setURL(BOT_INVITE_URL),
    new ButtonBuilder().setCustomId(TRACKER_IDS.flow.mainMenu).setLabel('Main Menu').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: 'Select your default run type, scan language, and timezone below.',
    embeds: [settingsEmbed],
    components: [runTypeRow, timezoneRow, deltaModeRow, actionsRow, utilityNavRow],
  };
}

async function buildLanguageSettingsPayload(userId: string, current: TrackerSettings | null | undefined): Promise<SettingsUpdatePayload> {
  const settingsUi = getTrackUiConfig().settings;
  const sharedSettings = await getEffectiveUserSharedSettings(userId);
  const scanLanguage = current?.scanLanguage ?? 'English';

  const embed = new EmbedBuilder()
    .setTitle('🌐 Language & Locale')
    .setDescription('Adjust shared app locale preferences separately from the OCR scan language.')
    .addFields(
      { name: settingsUi.labels.appLanguage ?? 'App language', value: formatSharedLanguageLabel(sharedSettings.languagePreference), inline: true },
      { name: settingsUi.labels.scanLanguage, value: scanLanguage, inline: true },
      { name: settingsUi.labels.dateFormat ?? 'Date format', value: formatDateFormatLabel(sharedSettings.dateFormatPreference), inline: true },
      { name: settingsUi.labels.decimalIndicator ?? 'Decimal indicator', value: formatDecimalSeparatorLabel(sharedSettings.decimalSeparatorPreference), inline: true },
      { name: settingsUi.labels.localePreview ?? 'Locale preview', value: buildLocalePreview(sharedSettings), inline: false },
    )
    .setColor(0x3b82f6);

  const appLanguageRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.appLanguage)
      .setPlaceholder(settingsUi.placeholders.appLanguage ?? 'App language')
      .addOptions(...governedLanguagePreferenceIds.map(item => ({
        label: item === 'auto' ? 'Auto (Region Default)' : (governedLanguageOptions.find(option => option.id === item)?.label ?? item),
        value: item,
        default: sharedSettings.languagePreference === item,
      }))),
  );

  const scanLanguageRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.language)
      .setPlaceholder(settingsUi.placeholders.language)
      .addOptions(...settingsUi.languageOptions.map((item) => ({ label: item, value: item, default: scanLanguage === item }))),
  );

  const dateFormatRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.dateFormat)
      .setPlaceholder(settingsUi.placeholders.dateFormat ?? 'Date format')
      .addOptions(...governedDateFormatPreferenceIds.map(item => ({
        label: item === 'auto' ? 'Auto (Region Default)' : (governedDateFormatOptions.find(option => option.id === item)?.label ?? item),
        value: item,
        default: sharedSettings.dateFormatPreference === item,
      }))),
  );

  const decimalSeparatorRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.decimalSeparator)
      .setPlaceholder(settingsUi.placeholders.decimalIndicator ?? 'Decimal indicator')
      .addOptions(...governedDecimalSeparatorPreferenceIds.map(item => ({
        label: item === 'auto' ? 'Auto (Region Default)' : (governedDecimalSeparatorOptions.find(option => option.id === item)?.label ?? item),
        value: item,
        default: sharedSettings.decimalSeparatorPreference === item,
      }))),
  );

  const navigationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.languageBack).setLabel(settingsUi.buttons.backToSettings ?? 'Back to Settings').setStyle(ButtonStyle.Secondary),
  );

  return {
    content: 'Update your shared app locale and tracker scan language below.',
    embeds: [embed],
    components: [appLanguageRow, scanLanguageRow, dateFormatRow, decimalSeparatorRow, navigationRow],
  };
}

const SHARE_ELEMENT_KEYS = [
  'shareTier',
  'shareWave',
  'shareDuration',
  'shareKilledBy',
  'shareTotalCoins',
  'shareTotalCells',
  'shareTotalDice',
  'shareTotalShards',
  'shareDeathDefy',
  'shareCoinsPerHour',
  'shareCellsPerHour',
  'shareDicePerHour',
  'shareShardsPerHour',
  'shareWavesPerHour',
  'shareEnemiesPerHour',
  'shareNotes',
  'shareCoverageGoldenTower',
  'shareCoverageBlackHole',
  'shareCoverageSpotlight',
  'shareCoverageDeathWave',
  'shareCoverageOrbs',
  'shareCoverageGoldenBot',
  'shareCoverageAmpBot',
  'shareCoverageSummoned',
  'shareChart',
] as const;

type ShareElementKey = (typeof SHARE_ELEMENT_KEYS)[number];

const SHARE_ELEMENT_LABELS: Record<ShareElementKey, string> = {
  shareTier: 'Tier',
  shareWave: 'Wave',
  shareDuration: 'Duration',
  shareKilledBy: 'Killed By',
  shareTotalCoins: 'Total Coins',
  shareTotalCells: 'Total Cells',
  shareTotalDice: 'Total Dice',
  shareTotalShards: 'Total Shards',
  shareDeathDefy: 'Death Defies',
  shareCoinsPerHour: 'Coins/Hr',
  shareCellsPerHour: 'Cells/Hr',
  shareDicePerHour: 'Dice/Hr',
  shareShardsPerHour: 'Shards/Hr',
  shareWavesPerHour: 'Waves/Hr',
  shareEnemiesPerHour: 'Enemies/Hr',
  shareNotes: 'Notes',
  shareCoverageGoldenTower: 'Coverage: Golden Tower',
  shareCoverageBlackHole: 'Coverage: Black Hole',
  shareCoverageSpotlight: 'Coverage: Spotlight',
  shareCoverageDeathWave: 'Coverage: Death Wave',
  shareCoverageOrbs: 'Coverage: Orbs',
  shareCoverageGoldenBot: 'Coverage: Golden Bot',
  shareCoverageAmpBot: 'Coverage: Amp Bot',
  shareCoverageSummoned: 'Coverage: Summoned',
  shareChart: '📊 Per-Hour Chart',
};

function getShareElementValues(settings: TrackerSettings | null | undefined): ShareElementKey[] {
  return SHARE_ELEMENT_KEYS.filter((key) => settings?.[key] !== false);
}

function toShareSettingsPatch(selected: string[]): Partial<TrackerSettings> {
  const selectedSet = new Set(selected);
  const patch: Partial<TrackerSettings> = {};
  for (const key of SHARE_ELEMENT_KEYS) {
    patch[key] = selectedSet.has(key);
  }
  return patch;
}

function withPreviewCoverage(run: Record<string, unknown>): Record<string, unknown> {
  return {
    ...run,
    totalEnemies: '100',
    killsWithGoldenTower: '73',
    enemiesHitByBlackHole: '64',
    enemiesHitByOrbs: '67',
    destroyedInSpotlight: '59',
    taggedByDeathWave: '52',
    destroyedInGoldenBot: '41',
    killsWithAmplifyBot: '28',
    guardianSummonedEnemies: '11',
  };
}

async function buildShareSettingsPayload(interaction: TrackMenuInteraction, settings: TrackerSettings | null | undefined): Promise<{ content: string; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]; embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const selected = getShareElementValues(settings);
  const selectedSet = new Set<string>(selected);

  const select = new StringSelectMenuBuilder()
    .setCustomId(TRACKER_IDS.settings.shareElements)
    .setPlaceholder('Select shared embed elements')
    .setMinValues(0)
    .setMaxValues(SHARE_ELEMENT_KEYS.length)
    .addOptions(
      ...SHARE_ELEMENT_KEYS.map((key) => ({
        label: SHARE_ELEMENT_LABELS[key],
        value: key,
        default: selectedSet.has(key),
      })),
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const compactDefault = settings?.shareCompact === true;
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TRACKER_IDS.settings.shareStyle)
      .setLabel(`Default Share Style: ${compactDefault ? 'Compact' : 'Expanded'}`)
      .setStyle(compactDefault ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.shareBack).setLabel('Back to Settings').setStyle(ButtonStyle.Secondary),
  );

  const sampleRunBase = {
    type: 'Farming',
    tierDisplay: '20',
    wave: '4195',
    duration: '2h57m49s',
    killedBy: 'Overcharge',
    totalCoins: '6.36Q',
    totalCells: '880.94K',
    totalDice: '398.25K',
    deathDefy: '2',
    notes: 'Sample preview note',
    screenshotUrl: null,
    cannonShardsFetched: '120K',
    armorShardsFetched: '95K',
    generatorShardsFetched: '88K',
    coreShardsFetched: '95.25K',
  };
  const sampleRun = withPreviewCoverage(sampleRunBase);
  const sampleCounts = { Farming: 1 };
  const previewAttachmentName = 'battle_report_example.png';
  const previewAttachmentPath = resolve(process.cwd(), 'src', 'assets', previewAttachmentName);

  // Dummy baseline for delta annotations in the preview
  const demoBaseline = {
    wave: 4155,
    coins: 6_250_000_000_000_000,
    cells: 868_000,
    rerollShards: 392_000,
    moduleShards: 390_000,
    deathDefy: 1,
    coinsPerHour: 2_134_000_000_000_000,
    cellsPerHour: 296_000,
    rerollShardsPerHour: 133_000,
    moduleShardsPerHour: 133_000,
    wavesPerHour: 1419,
    enemiesPerHour: 32,
    killsWithGoldenTowerPercentage: 70,
    destroyedByBlackHolePercentage: 61,
    hitByOrbsPercentage: 64,
    destroyedInSpotlightPercentage: 56,
    taggedByDeathWavePercentage: 49,
    destroyedInGoldenBotPercentage: 38,
    killsWithAmplifyBotPercentage: 25,
    summonedEnemiesPercentage: 10,
  };
  const demoResult = {
    mode: 'last' as const,
    baseline: demoBaseline,
    comparisonLabel: 'Last Run',
  };

  // Dummy runs for chart rendering
  const dummyRuns: Record<string, unknown>[] = [
    { type: 'Farming', date: '2025-01-10', totalCoins: '5.8Q', totalCells: '820K', totalDice: '365K', cannonShardsFetched: '110K', armorShardsFetched: '87K', generatorShardsFetched: '80K', coreShardsFetched: '88K', duration: '2h48m10s', wave: '3980' },
    { type: 'Farming', date: '2025-01-12', totalCoins: '6.0Q', totalCells: '845K', totalDice: '375K', cannonShardsFetched: '113K', armorShardsFetched: '89K', generatorShardsFetched: '82K', coreShardsFetched: '90K', duration: '2h51m30s', wave: '4050' },
    { type: 'Farming', date: '2025-01-14', totalCoins: '6.15Q', totalCells: '858K', totalDice: '386K', cannonShardsFetched: '116K', armorShardsFetched: '91K', generatorShardsFetched: '85K', coreShardsFetched: '92K', duration: '2h53m20s', wave: '4100' },
    { type: 'Farming', date: '2025-01-15', totalCoins: '6.25Q', totalCells: '868K', totalDice: '392K', cannonShardsFetched: '118K', armorShardsFetched: '93K', generatorShardsFetched: '86K', coreShardsFetched: '93K', duration: '2h55m40s', wave: '4155' },
    { type: 'Farming', date: '2025-01-16', totalCoins: '6.36Q', totalCells: '880.94K', totalDice: '398.25K', cannonShardsFetched: '120K', armorShardsFetched: '95K', generatorShardsFetched: '88K', coreShardsFetched: '95.25K', duration: '2h57m49s', wave: '4195' },
  ];

  const preview = buildShareEmbed({
    user: buildEmbedUserFromInteraction(interaction),
    run: {
      ...sampleRun,
      screenshotUrl: `attachment://${previewAttachmentName}`,
    },
    runTypeCounts: sampleCounts,
    deltaResult: demoResult,
    options: {
      includeTier: settings?.shareTier !== false,
      includeWave: settings?.shareWave !== false,
      includeDuration: settings?.shareDuration !== false,
      includeKilledBy: settings?.shareKilledBy !== false,
      includeTotalCoins: settings?.shareTotalCoins !== false,
      includeTotalCells: settings?.shareTotalCells !== false,
      includeTotalDice: settings?.shareTotalDice !== false,
      includeTotalShards: settings?.shareTotalShards !== false,
      includeDeathDefy: settings?.shareDeathDefy !== false,
      includeCoinsPerHour: settings?.shareCoinsPerHour !== false,
      includeCellsPerHour: settings?.shareCellsPerHour !== false,
      includeDicePerHour: settings?.shareDicePerHour !== false,
      includeShardsPerHour: settings?.shareShardsPerHour !== false,
      includeWavesPerHour: settings?.shareWavesPerHour !== false,
      includeEnemiesPerHour: settings?.shareEnemiesPerHour !== false,
      includeNotes: settings?.shareNotes !== false,
      includeCoverage: true,
      includeCoverageGoldenTower: settings?.shareCoverageGoldenTower !== false,
      includeCoverageBlackHole: settings?.shareCoverageBlackHole !== false,
      includeCoverageSpotlight: settings?.shareCoverageSpotlight !== false,
      includeCoverageDeathWave: settings?.shareCoverageDeathWave !== false,
      includeCoverageOrbs: settings?.shareCoverageOrbs !== false,
      includeCoverageGoldenBot: settings?.shareCoverageGoldenBot !== false,
      includeCoverageAmpBot: settings?.shareCoverageAmpBot !== false,
      includeCoverageSummoned: settings?.shareCoverageSummoned !== false,
    },
  });

  const currentFooter = preview.data.footer?.text ?? 'Tracked with The Tower Run Tracker\nUse /track to log a run';
  preview.setFooter({
    text: `${currentFooter}\n\nUse the dropdown below to select which elements you want to include in your share messages.\nThe display will update in real time to show how your selections will affect the appearance of your share messages.`,
  });

  const chartAttachment = settings?.shareChart !== false
    ? await buildPerHourChartAttachment(dummyRuns, 'Farming').catch(() => null)
    : null;
  if (chartAttachment) preview.setImage('attachment://per-hour-chart.png');

  const styleNote = compactDefault
    ? '**Default share style: Compact** — shares post as tier/wave/coins with an Expand button. Some servers always post compact regardless of this setting.'
    : '**Default share style: Expanded** — shares post the full message. Switch to Compact for a shorter post with an Expand button. The preview below always shows the expanded layout.';

  return {
    content: styleNote,
    components: [selectRow, backRow],
    embeds: [preview],
    files: [
      new AttachmentBuilder(previewAttachmentPath, { name: previewAttachmentName }),
      ...(chartAttachment ? [chartAttachment] : []),
    ],
  };
}

export async function handleTrackMenuToggleCloud(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const currentEnabled = current?.cloudSyncEnabled !== false;
    const nextEnabled = !currentEnabled;

    await editUserSettings(interaction.user.id, { cloudSyncEnabled: nextEnabled });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    if (canUpdate(interaction)) {
      await interaction.update({ content: payload.content, components: payload.components, embeds: payload.embeds }).catch(() => {});
    }
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_cloud');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.cloud, components: [], embeds: [] });
  }
}

export async function handleTrackMenuForceSave(interaction: TrackMenuInteraction) {
  try {
    const remaining = await forceSyncQueuedRuns(interaction.user.id);
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    payload.content = remaining === 0
      ? 'Queued uploads synced successfully.'
      : `Force-save attempted. ${remaining} queued upload${remaining === 1 ? '' : 's'} remaining.`;
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_force_save');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.forceSave ?? 'Unable to force-save queued runs right now.', components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleDuplicates(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.autoDetectDuplicates !== false);
    await editUserSettings(interaction.user.id, { autoDetectDuplicates: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_duplicates');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.duplicates, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleConfirm(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.confirmBeforeSubmit !== false);
    await editUserSettings(interaction.user.id, { confirmBeforeSubmit: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_confirm');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.confirm, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleShareNotes(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.shareNotes !== false);
    await editUserSettings(interaction.user.id, { shareNotes: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_share_notes');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.shareNotes, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleShareCoverage(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.shareCoverage !== false);
    await editUserSettings(interaction.user.id, { shareCoverage: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_share_coverage');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.shareCoverage, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleShareScreenshot(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.shareScreenshot !== false);
    await editUserSettings(interaction.user.id, { shareScreenshot: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_share_screenshot');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.shareScreenshot, components: [], embeds: [] });
  }
}

export async function handleTrackMenuShareElements(interaction: TrackMenuInteraction) {
  try {
    if (canUpdate(interaction) && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const selected = getSelectedValues(interaction);
    await editUserSettings(interaction.user.id, toShareSettingsPatch(selected));
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildShareSettingsPayload(interaction, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_share_elements');
    await updateInPlace(interaction, { content: ui.settings.shareFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuShareBack(interaction: TrackMenuInteraction) {
  try {
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_share_back');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuLanguageMenu(interaction: TrackMenuInteraction) {
  try {
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildLanguageSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_language_menu');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuLanguageBack(interaction: TrackMenuInteraction) {
  try {
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_language_back');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectLanguage(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'English';
    await editUserSettings(interaction.user.id, { scanLanguage: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildLanguageSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_language');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.language, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectAppLanguage(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'auto';
    const current = await getEffectiveUserSharedSettings(interaction.user.id);
    await saveUserSharedSettings(interaction.user.id, { ...current, languagePreference: nextValue as SharedUserToolSettings['languagePreference'] });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildLanguageSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_app_language');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.appLanguage ?? ui.settings.toggleFailed.language, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectDateFormat(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'auto';
    const current = await getEffectiveUserSharedSettings(interaction.user.id);
    await saveUserSharedSettings(interaction.user.id, { ...current, dateFormatPreference: nextValue as SharedUserToolSettings['dateFormatPreference'] });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildLanguageSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_date_format');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.dateFormat ?? ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectDecimalSeparator(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'auto';
    const current = await getEffectiveUserSharedSettings(interaction.user.id);
    await saveUserSharedSettings(interaction.user.id, { ...current, decimalSeparatorPreference: nextValue as SharedUserToolSettings['decimalSeparatorPreference'] });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildLanguageSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_decimal_separator');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.decimalIndicator ?? ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectTracker(interaction: TrackMenuInteraction) {
  try {
    await editUserSettings(interaction.user.id, { defaultTracker: 'Web' });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_tracker');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.tracker, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectDefaultRunType(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'Farming';
    await editUserSettings(interaction.user.id, { defaultRunType: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_default_run_type');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.runType, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSelectTimezone(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'UTC';
    await editUserSettings(interaction.user.id, { timezone: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_timezone');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.timezone, components: [], embeds: [] });
  }
}

export async function handleTrackMenuShareSettings(interaction: TrackMenuInteraction) {
  try {
    const settings = await getUserSettings(interaction.user.id);
    const payload = await buildShareSettingsPayload(interaction, settings);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_share_settings');
    await updateInPlace(interaction, { content: ui.settings.shareFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuSetLogChannel(interaction: TrackMenuInteraction) {
  try {
    if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') {
      await updateInPlace(interaction, { content: 'Log channel setup can only be opened from a button interaction.', components: [], embeds: [] });
      return;
    }

    if (!interaction.guildId || !interaction.guild) {
      await updateInPlace(interaction, { content: 'Please open Settings in a server channel to configure a log channel.', components: [], embeds: [] });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(TRACKER_IDS.settings.logChannelModal)
      .setTitle('Set Log Channel');

    const channelInput = new TextInputBuilder()
      .setCustomId(TRACKER_IDS.settings.logChannelValue)
      .setLabel('Log channel ID (#mention or ID)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(`<#${interaction.channelId}>`)
      .setPlaceholder(`#run-logs or ${interaction.channelId}`);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput));

    await interaction.showModal(modal);

    const submitted = await awaitOwnedModalSubmit(interaction as MessageComponentInteraction, TRACKER_IDS.settings.logChannelModal);

    if (submitted.guildId === LOG_CHANNEL_RESTRICTED_GUILD_ID) {
      await submitted.reply({ content: LOG_CHANNEL_RESTRICTED_MESSAGE, ephemeral: true }).catch(() => {});
      return;
    }

    const existingChannelInput = submitted.fields.getTextInputValue(TRACKER_IDS.settings.logChannelValue);
    const existingChannelId = extractChannelId(existingChannelInput);
    if (!existingChannelId) {
      await submitted.reply({ content: 'Please provide a valid channel mention or channel ID.', ephemeral: true }).catch(() => {});
      return;
    }

    const target = await submitted.guild?.channels.fetch(existingChannelId).catch(() => null);
    const isValidText = Boolean(target && target.isTextBased());
    if (!isValidText) {
      await submitted.reply({ content: 'The selected channel is invalid. Choose a text channel in this server.', ephemeral: true }).catch(() => {});
      return;
    }

    const resultMessage = `Log channel set to <#${existingChannelId}>.`;

    await editUserSettings(interaction.user.id, {
      logChannelId: existingChannelId,
      logChannelGuildId: submitted.guildId,
      logChannelCategoryId: target?.parentId ?? null,
    });

    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);

    if (!submitted.deferred && !submitted.replied) {
      await submitted.deferUpdate().catch(() => {});
    }

    await submitted.editReply({
      content: resultMessage,
      embeds: payload.embeds,
      components: payload.components,
    }).catch(async () => {
      await submitted.followUp({ content: resultMessage, ephemeral: true }).catch(() => {});
    });
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_set_log_channel');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuStats(interaction: TrackMenuInteraction) {
  try {
    const stats = await getUserStats(interaction.user.id);
    const lines = [
      `Total runs: ${stats.totalRuns ?? 0}`,
      `Highest wave: ${stats.highestWave ?? 0}`,
      `Highest tier: ${stats.highestTier ?? 0}`,
      `Longest run: ${stats.longestRun ?? '0h0m0s'}`,
      `Fastest run: ${stats.fastestRun ?? '0h0m0s'}`,
      `Average wave: ${stats.avgWave ?? 0}`,
    ];
    await updateInPlace(interaction, { content: lines.join('\n'), components: [], embeds: [] });
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_stats');
    await updateInPlace(interaction, { content: ui.settings.statsFailed, components: [], embeds: [] });
  }
}


export async function handleTrackMenuSelectDeltaMode(interaction: TrackMenuInteraction) {
  try {
    const nextValue = (getSelectedValues(interaction)[0] ?? '7day') as RunDeltaMode;
    const current = await getEffectiveUserSharedSettings(interaction.user.id);
    await saveUserSharedSettings(interaction.user.id, { ...current, runDeltaMode: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_delta_mode');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleShareStyle(interaction: TrackMenuInteraction) {
  try {
    // Acknowledge before the settings reads/writes, which may block on slow cloud calls past
    // Discord's 3s window and otherwise kill the interaction token.
    if (canUpdate(interaction) && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.shareCompact === true);
    // Re-send every existing setting (minus the stale timestamp) so the share-defaults
    // normalizer in editUserSettings can't reset the user's other share element toggles.
    const patch: Record<string, unknown> = { ...(current ?? {}), shareCompact: nextValue };
    delete patch.updatedAt;
    await editUserSettings(interaction.user.id, patch);
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildShareSettingsPayload(interaction, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_share_style');
    await updateInPlace(interaction, { content: ui.settings.shareFailed, components: [], embeds: [] });
  }
}

export async function handleTrackMenuToggleShareChart(interaction: TrackMenuInteraction) {
  try {
    const current = await getUserSettings(interaction.user.id);
    const nextValue = !(current?.shareChart !== false);
    await editUserSettings(interaction.user.id, { shareChart: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildShareSettingsPayload(interaction, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_toggle_share_chart');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.shareNotes, components: [], embeds: [] });
  }
}
