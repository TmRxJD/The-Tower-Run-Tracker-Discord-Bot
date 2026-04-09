import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { calculateHourlyRate } from '../tracker-helpers';
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { trimDisplayTimeSeconds } from '../handlers/upload-helpers';
import { getTrackUiConfig, getTrackerUiConfig, type TrackerUiMode } from '../../../config/tracker-ui-config';

function firstPresentValue(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text && text !== 'N/A') return text;
  }
  return null;
}

function toButtonStyle(style: string): ButtonStyle {
  switch (style) {
    case 'Primary': return ButtonStyle.Primary;
    case 'Secondary': return ButtonStyle.Secondary;
    case 'Success': return ButtonStyle.Success;
    case 'Danger': return ButtonStyle.Danger;
    case 'Link': return ButtonStyle.Link;
    default: return ButtonStyle.Secondary;
  }
}

export function createLoadingEmbed(message: string) {
  return new EmbedBuilder().setDescription(`⏳ ${message}`).setColor(Colors.Grey);
}

export function createRetryRow(customId: string) {
  const ui = getTrackUiConfig();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(ui.common.retryLabel).setStyle(ButtonStyle.Primary)
  );
}

export function createDataReviewEmbed(
  data: Record<string, unknown>,
  typeLabel = 'Extracted',
  isDuplicate = false,
  decimalPreference = 'Period (.)',
  screenshotUrl?: string | null,
  mode: TrackerUiMode = 'track',
) {
  const ui = getTrackerUiConfig(mode);
  const review = ui.review;
  const embed = new EmbedBuilder()
    .setTitle(`${review.titlePrefix} ${typeLabel} ${review.titleSuffix}`)
    .setDescription(
      isDuplicate
        ? review.duplicateDescription
        : review.normalDescription,
    )
    .setColor(isDuplicate ? Colors.Orange : Colors.Gold);

  if (screenshotUrl) embed.setImage(screenshotUrl);
  const MAX_EMBED_FIELDS = 25;

  const clamp = (val: string) => (val.length > 1024 ? `${val.slice(0, 1021)}...` : val);
  const toTitle = (str: string) => str.split(' ').map(w => (w ? `${w[0].toUpperCase()}${w.slice(1).toLowerCase()}` : '')).join(' ');

  const noteText = data?.notes ?? data?.note;
  const displayNotes = noteText && String(noteText).trim() !== '' ? String(noteText).trim() : review.notesFallback;
  const viewData: Record<string, unknown> = { ...data, notes: displayNotes };

  const fieldNameMap: Record<string, string> = review.embedFieldNameMap as Record<string, string>;

  const displayName = (key: string) => fieldNameMap[key] || toTitle(key);

  const displayNumber = (val: unknown) => String(val ?? '').trim();

  const addField = (key: string, value: unknown, inline = true) => {
    if (embed.data.fields && embed.data.fields.length >= MAX_EMBED_FIELDS) return;
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (!str || str === 'N/A') return;
    embed.addFields({ name: displayName(key), value: clamp(str), inline });
  };
  const processed = new Set<string>();
  const skipKeys = new Set<string>(review.skipFieldKeys as string[]);
  const standardOrder = review.standardFieldOrder as string[];
  const numericFieldKeys = new Set<string>(review.numericFieldKeys as string[]);
  const durationVal = viewData.roundDuration ?? viewData.duration;
  const dateVal = viewData.date ?? viewData.runDate ?? '';
  const timeVal = trimDisplayTimeSeconds(viewData.time ?? viewData.runTime ?? '');
  const reviewDescriptionLines = [
    isDuplicate ? review.duplicateDescription : review.normalDescription,
  ];
  embed.setDescription(reviewDescriptionLines.join('\n'));

  for (const key of standardOrder) {
    if (key === 'dateTime') {
      addField(key, `${dateVal} ${timeVal}`.trim());
      processed.add(key);
      continue;
    }
    let value = viewData[key];
    if (key === 'duration') value = durationVal;
    if (numericFieldKeys.has(key) && value !== undefined) {
      addField(key, displayNumber(value));
      processed.add(key);
      continue;
    }
    const inline = key !== 'notes';
    addField(key, value, inline);
    processed.add(key);
  }

  return embed;
}

export function createTypeSelectionRow(token: string, selectedType: string) {
  const ui = getTrackUiConfig();
  const select = new StringSelectMenuBuilder()
    .setCustomId(withToken(TRACKER_IDS.review.typePrefix, token))
    .setPlaceholder(ui.review.typePlaceholder)
    .addOptions(
      ...(ui.review.typeOptions.map(type => ({ label: type, value: type, default: selectedType === type })))
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export function createAddNoteButtonRow(token: string) {
  const ui = getTrackUiConfig();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.addNotePrefix, token)).setLabel(ui.review.buttons.addNote).setStyle(ButtonStyle.Secondary)
  );
}

export function createShowFullParseButtonRow(token: string) {
  const ui = getTrackUiConfig();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.fullParsePrefix, token)).setLabel(ui.review.buttons.showFullParse).setStyle(ButtonStyle.Secondary)
  );
}

export function createAddNoteAndShowFullParseButtonRow(token: string) {
  const ui = getTrackUiConfig();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.addNotePrefix, token)).setLabel(ui.review.buttons.addNote).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.fullParsePrefix, token)).setLabel(ui.review.buttons.showFullParse).setStyle(ButtonStyle.Secondary),
  );
}

export function createConfirmationButtons(token: string) {
  const ui = getTrackUiConfig();
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.acceptPrefix, token)).setLabel(ui.review.buttons.accept).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.editPrefix, token)).setLabel(ui.review.buttons.edit).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.cancelPrefix, token)).setLabel(ui.review.buttons.cancel).setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function createSuccessButtons() {
  const ui = getTrackUiConfig();
  const idByKey: Record<string, string> = {
    shareLast: TRACKER_IDS.flow.shareLast,
    editLast: TRACKER_IDS.flow.editLast,
    uploadAnother: TRACKER_IDS.flow.uploadAnother,
    viewRuns: TRACKER_IDS.flow.viewRuns,
    mainMenu: TRACKER_IDS.flow.mainMenu,
    cancel: TRACKER_IDS.flow.cancel,
  };

  const buildBtn = (button: { key: string; label: string; style: string; emoji?: string }) => {
    const builder = new ButtonBuilder().setLabel(button.label).setStyle(toButtonStyle(button.style));
    if (button.emoji) builder.setEmoji(button.emoji);
    if (button.key === 'webTracker') {
      return builder.setURL(ui.initialMenu.url);
    }
    const customId = idByKey[button.key];
    return customId ? builder.setCustomId(customId) : null;
  };

  return ui.success.rows
    .map(row => {
      const components = row.map(buildBtn).filter((b): b is ButtonBuilder => b !== null);
      return components.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(...components) : null;
    })
    .filter((row): row is ActionRowBuilder<ButtonBuilder> => row !== null);
}

export function createInitialEmbed(params: {
  mode?: TrackerUiMode;
  userLabel: string;
  userId?: string;
  lastRun?: Record<string, unknown> | null;
  runCount?: number;
  runTypeCounts?: Record<string, number>;
}) {
  const ui = getTrackerUiConfig(params.mode ?? 'track');
  const menu = ui.initialMenu;
  const { userLabel, userId, lastRun, runCount = 0, runTypeCounts = {} } = params;
  const mentionUserId = typeof userId === 'string' && userId.trim() ? userId.trim() : userLabel;
  const embed = new EmbedBuilder()
    .setTitle(menu.title)
    .setURL(menu.url)
    .setColor(Colors.Blue)
    .setThumbnail(menu.thumbnail);

  if (lastRun) {
    const totalRuns = Math.max(1, Number(runCount) || 0);
    embed.setDescription(menu.welcomeBackTemplate.replace('{userId}', mentionUserId).replace('{totalRuns}', String(totalRuns)));

    if ((params.mode ?? 'track') === 'lifetime') {
      const lastRunFieldLabels = menu.lastRunFieldLabels as Record<string, string>;
      const lifetimeOrder = menu.lastRunFieldOrder as string[];
      const fields = lifetimeOrder
        .map((key) => {
          const label = lastRunFieldLabels[key];
          const raw = (lastRun as Record<string, unknown>)[key];
          if (!label || raw === undefined || raw === null) return null;
          const value = String(raw).trim();
          if (!value) return null;
          return { name: label, value, inline: true };
        })
        .filter((field): field is { name: string; value: string; inline: boolean } => field !== null);

      if (fields.length) {
        embed.addFields(fields);
      }
      if (menu.footer) {
        embed.setFooter({ text: menu.footer });
      }
      return embed;
    }

    const runType = typeof lastRun.type === 'string' && lastRun.type.trim() ? lastRun.type : 'Farming';
    const rawTypeCount = runTypeCounts && runTypeCounts[runType] ? runTypeCounts[runType] : 0;
    const typeCount = Math.max(1, Number(rawTypeCount) || 0);

    const tierValue = String(lastRun.tierDisplay?.toString().trim() || lastRun.tier || 'N/A');
    const waveValue = String(lastRun.wave ?? 'N/A');
    const durationValue = String(lastRun.duration || lastRun.roundDuration || 'N/A');
    const killedByValue = String(lastRun.killedBy || 'Unknown');
    const coinsValue = String(lastRun.coins || lastRun.totalCoins || 'N/A');
    const cellsValue = String(lastRun.cells || lastRun.totalCells || 'N/A');
    const diceValue = String(lastRun.rerollShards || lastRun.totalDice || 'N/A');
    const deathDefyValue = String(lastRun.deathDefy || 'N/A');
    const dateValue = `${lastRun.date || lastRun.runDate || 'Unknown'} ${trimDisplayTimeSeconds(lastRun.time || lastRun.runTime || '')}`.trim();

    const coinsPerHour = calculateHourlyRate(coinsValue, durationValue) || 'N/A';
    const cellsPerHour = calculateHourlyRate(cellsValue, durationValue) || 'N/A';
    const dicePerHour = calculateHourlyRate(diceValue, durationValue) || 'N/A';

    const lastRunFieldLabels = menu.lastRunFieldLabels;
    const valueByKey: Record<string, string> = {
      tierWave: `${tierValue} | ${waveValue}`,
      duration: durationValue,
      killedBy: killedByValue,
      coins: coinsValue,
      cells: cellsValue,
      dice: diceValue,
      coinsPerHour,
      cellsPerHour,
      dicePerHour,
      deathDefy: deathDefyValue,
      runSummary: `${runType.charAt(0).toUpperCase() + runType.slice(1)} #${typeCount}`,
      dateTime: dateValue,
    };

    const fields = (menu.lastRunFieldOrder as string[])
      .map((key) => {
        const label = (lastRunFieldLabels as Record<string, string>)[key];
        const value = valueByKey[key];
        if (!label || value === undefined) return null;
        return { name: label, value, inline: true };
      })
      .filter((f): f is { name: string; value: string; inline: boolean } => f !== null);

    fields.forEach(f => embed.addFields(f));

    const noteText = lastRun.notes || lastRun.note;
    if (noteText && String(noteText).trim() !== '' && noteText !== 'N/A') {
      embed.addFields({
        name: lastRunFieldLabels.notes,
        value: String(noteText).length > 1024 ? `${String(noteText).substring(0, 1021)}...` : String(noteText),
        inline: false,
      });
    }

    embed.addFields({ name: '\u200B', value: menu.availableOptionsHeader });
  } else {
    embed.setDescription(menu.welcomeNewTemplate.replace('{userId}', mentionUserId));
    embed.setThumbnail(menu.thumbnail);
  }

  embed.addFields(...menu.options.map(option => ({ name: option.name, value: option.value, inline: option.inline })));

  embed.setFooter({ text: menu.footer });
  return embed;
}

export function createMainMenuButtons(mode: TrackerUiMode = 'track') {
  const ui = getTrackerUiConfig(mode);
  const menu = ui.initialMenu;
  const idByKey: Record<string, string> = {
    addRun: TRACKER_IDS.flow.addRun,
    manual: TRACKER_IDS.flow.manual,
    editLast: TRACKER_IDS.flow.editLast,
    removeLast: TRACKER_IDS.flow.removeLast,
    shareLastMenu: TRACKER_IDS.flow.shareLastMenu,
    viewRuns: TRACKER_IDS.flow.viewRuns,
    support: TRACKER_IDS.flow.support,
    settings: TRACKER_IDS.settings.menu,
    cancel: TRACKER_IDS.flow.cancel,
  };

  const buildBtn = (button: { key: string; label: string; style: string; emoji?: string }) => {
    const builder = new ButtonBuilder().setLabel(button.label).setStyle(toButtonStyle(button.style));
    if (button.emoji) builder.setEmoji(button.emoji);
    if (button.key === 'webTracker') {
      return builder.setURL(menu.url);
    }
    const customId = idByKey[button.key];
    return customId ? builder.setCustomId(customId) : null;
  };

  return menu.mainRows
    .map(row => {
      const components = row.map(buildBtn).filter((b): b is ButtonBuilder => b !== null);
      return components.length ? new ActionRowBuilder<ButtonBuilder>().addComponents(...components) : null;
    })
    .filter((row): row is ActionRowBuilder<ButtonBuilder> => row !== null);
}

export function createUploadEmbed() {
  const ui = getTrackUiConfig();
  const upload = ui.uploadCard;
  return new EmbedBuilder()
    .setTitle(upload.title)
    .setDescription(upload.description)
    .addFields({
      name: upload.tipsTitle,
      value: upload.tipsLines.join('\n'),
    })
    .setColor(Colors.Green)
    .setFooter({ text: upload.footer });
}

export function createCancelButton(customId = TRACKER_IDS.util.cancelPlain) {
  const ui = getTrackUiConfig();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(ui.uploadCard.cancelLabel).setStyle(ButtonStyle.Danger).setEmoji('❌'),
  );
}

export function createErrorEmbed(message: string, title = '❌ Error') {
  const ui = getTrackUiConfig();
  return new EmbedBuilder().setTitle(title || ui.errorUi.defaultTitle).setDescription(message).setColor(Colors.Red);
}

export function createErrorRecoveryButtons(manualId: string, mainId: string, cancelId = 'cancel') {
  const ui = getTrackUiConfig();
  const idByKey: Record<string, string> = { mainMenu: mainId, manual: manualId, cancel: cancelId };
  const components = ui.errorUi.recoveryButtons.map(item => {
    const customId = idByKey[item.key];
    if (!customId) return null;
    return new ButtonBuilder().setCustomId(customId).setLabel(item.label).setStyle(toButtonStyle(item.style));
  }).filter((b): b is ButtonBuilder => b !== null);
  return components.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...components)] : [];
}
