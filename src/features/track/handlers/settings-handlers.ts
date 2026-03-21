import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionUpdateOptions,
  MessageComponentInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { resolve } from 'node:path';
import { editUserSettings, forceSyncQueuedRuns, getEffectiveQueueCount, getUserSettings, getUserStats } from '../tracker-api-client';
import { TRACKER_IDS } from '../track-custom-ids';
import type { TrackerSettings } from '../types';
import { logError } from './error-handlers';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { buildShareEmbed } from '../share/share-embed';

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
  if (canUpdate(interaction)) {
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
  try {
    const ui = getTrackUiConfig();
    const settings = await getUserSettings(interaction.user.id);
    if (!settings) {
      await updateInPlace(interaction, { content: ui.settings.noSettings, components: [], embeds: [] });
      return;
    }

    const payload = await buildSettingsPayload(interaction.user.id, settings);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_settings');
    await updateInPlace(interaction, { content: ui.settings.loadFailed, components: [], embeds: [] });
  }
}

export async function buildSettingsPayload(userId: string, current: TrackerSettings | null | undefined) {
  const ui = getTrackUiConfig();
  const settingsUi = ui.settings;
  const queued = await getEffectiveQueueCount(userId);
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
      { name: settingsUi.labels.scanLanguage, value: String(language), inline: true },
      { name: settingsUi.labels.timezone ?? 'Timezone', value: String(timezone), inline: true },
      { name: settingsUi.labels.autoDetectDuplicates, value: duplicatesEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.confirmBeforeSubmit, value: confirmEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.cloudSync, value: cloudEnabled ? 'On' : 'Off', inline: true },
      { name: settingsUi.labels.logChannel ?? 'Log channel', value: logChannelDisplay, inline: true },
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

  const languageRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.language)
      .setPlaceholder(settingsUi.placeholders.language)
      .addOptions(...settingsUi.languageOptions.map((item) => ({ label: item, value: item, default: language === item }))),
  );

  const timezoneRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TRACKER_IDS.settings.timezone)
      .setPlaceholder(settingsUi.placeholders.timezone)
      .addOptions(...settingsUi.timezoneOptions.map((item) => ({ label: item, value: item, default: timezone === item }))),
  );

  const actionsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
  );

  const navigationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.logChannel).setLabel(settingsUi.buttons.setLogChannel ?? 'Set Log Channel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.share).setLabel(settingsUi.buttons.shareSettings).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel(settingsUi.buttons.inviteBot ?? 'Invite Bot').setStyle(ButtonStyle.Link).setURL(BOT_INVITE_URL),
    new ButtonBuilder().setCustomId(TRACKER_IDS.flow.mainMenu).setLabel('Main Menu').setStyle(ButtonStyle.Secondary),
  );

  const queueActionRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (queued > 0) {
    const forceSaveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TRACKER_IDS.settings.forceSave)
        .setLabel(settingsUi.buttons.forceSave ?? 'Force Save')
        .setStyle(ButtonStyle.Primary),
    );
    queueActionRows.push(forceSaveRow);
  }

  return {
    content: 'Select your default run type, scan language, and timezone below.',
    embeds: [settingsEmbed],
    components: [runTypeRow, languageRow, timezoneRow, actionsRow, ...queueActionRows, navigationRow],
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
  'shareCoinsPerHour',
  'shareCellsPerHour',
  'shareDicePerHour',
  'shareNotes',
  'shareCoverage',
  'shareScreenshot',
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
  shareCoinsPerHour: 'Coins/Hr',
  shareCellsPerHour: 'Cells/Hr',
  shareDicePerHour: 'Dice/Hr',
  shareNotes: 'Notes',
  shareCoverage: 'Coverage',
  shareScreenshot: 'Screenshot',
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
    destroyedByOrbs: '67',
    destroyedInSpotlight: '99',
    taggedByDeathWave: '87',
    destroyedInGoldenBot: '59',
    summonedEnemies: '11',
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
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    notes: 'Sample preview note',
    screenshotUrl: null,
  };
  const sampleRun = withPreviewCoverage(sampleRunBase);
  const sampleCounts = { Farming: 1 };
  const previewAttachmentName = 'battle_report_example.png';
  const previewAttachmentPath = resolve(process.cwd(), 'src', 'assets', previewAttachmentName);

  const preview = buildShareEmbed({
    user: interaction.user,
    run: {
      ...sampleRun,
      screenshotUrl: `attachment://${previewAttachmentName}`,
    },
    runTypeCounts: sampleCounts,
    options: {
      includeTier: settings?.shareTier !== false,
      includeWave: settings?.shareWave !== false,
      includeDuration: settings?.shareDuration !== false,
      includeKilledBy: settings?.shareKilledBy !== false,
      includeTotalCoins: settings?.shareTotalCoins !== false,
      includeTotalCells: settings?.shareTotalCells !== false,
      includeTotalDice: settings?.shareTotalDice !== false,
      includeCoinsPerHour: settings?.shareCoinsPerHour !== false,
      includeCellsPerHour: settings?.shareCellsPerHour !== false,
      includeDicePerHour: settings?.shareDicePerHour !== false,
      includeNotes: settings?.shareNotes !== false,
      includeCoverage: settings?.shareCoverage !== false,
      includeScreenshot: settings?.shareScreenshot !== false,
    },
  });

  const currentFooter = preview.data.footer?.text ?? 'Tracked with The Tower Run Tracker\nUse /track to log a run';
  preview.setFooter({
    text: `${currentFooter}\n\nUse the dropdown below to select which elements you want to include in your share messages.\nThe display will update in real time to show how your selections will affect the appearance of your share messages.`,
  });

  return {
    content: '',
    components: [selectRow, backRow],
    embeds: [preview],
    files: [new AttachmentBuilder(previewAttachmentPath, { name: previewAttachmentName })],
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
    await forceSyncQueuedRuns(interaction.user.id);
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
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

export async function handleTrackMenuSelectLanguage(interaction: TrackMenuInteraction) {
  try {
    const nextValue = getSelectedValues(interaction)[0] ?? 'English';
    await editUserSettings(interaction.user.id, { scanLanguage: nextValue });
    const refreshed = await getUserSettings(interaction.user.id);
    const payload = await buildSettingsPayload(interaction.user.id, refreshed);
    await updateInPlace(interaction, payload);
  } catch (error) {
    const ui = getTrackUiConfig();
    await logError(interaction.client, interaction.user, error, 'track_menu_select_language');
    await updateInPlace(interaction, { content: ui.settings.toggleFailed.language, components: [], embeds: [] });
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

    const submitted = await interaction.awaitModalSubmit({
      filter: (event) => event.customId === TRACKER_IDS.settings.logChannelModal && event.user.id === interaction.user.id,
      time: 300_000,
    });

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

export async function handleTrackMenuImport(interaction: TrackMenuInteraction) {
  const ui = getTrackUiConfig();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.importYes).setLabel(ui.settings.buttons.yes).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(TRACKER_IDS.settings.importNo).setLabel(ui.settings.buttons.no).setStyle(ButtonStyle.Secondary),
  );
  await updateInPlace(interaction, { content: ui.settings.importPrompt, components: [row], embeds: [] });
}

export async function handleTrackMenuImportYes(interaction: TrackMenuInteraction) {
  if (canUpdate(interaction)) {
    const ui = getTrackUiConfig();
    await interaction.update({
      content: ui.settings.importAccepted,
      components: [],
      embeds: [],
    }).catch(() => {});
  }
}

export async function handleTrackMenuImportNo(interaction: TrackMenuInteraction) {
  if (canUpdate(interaction)) {
    const ui = getTrackUiConfig();
    await interaction.update({ content: ui.settings.importCancelled, components: [], embeds: [] }).catch(() => {});
  }
}
