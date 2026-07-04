import { SlashCommandBuilder } from 'discord.js';
import { getBotConfig } from '../config/bot-config';

type TrackerCommandKey = 'track' | 'lifetime';

function hasPasteOption(options: object): options is { paste: { name: string; description: string } } {
  return 'paste' in options;
}

function buildTrackerCommandData(commandKey: TrackerCommandKey) {
  const botConfig = getBotConfig();
  const commandConfig = botConfig.commands[commandKey];
  const options = commandConfig.options;

  const data = new SlashCommandBuilder()
    .setName(commandConfig.name)
    .setDescription(commandConfig.description);

  if (hasPasteOption(options)) {
    data.addStringOption(option =>
      option.setName(options.paste.name)
        .setDescription(options.paste.description)
        .setRequired(false));
  }

  if ('note' in options && options.note) {
    data.addStringOption(option =>
      option.setName(options.note.name)
        .setDescription(options.note.description)
        .setRequired(false));
  }

  if ('type' in options && options.type) {
    data.addStringOption(option =>
      option.setName(options.type.name)
        .setDescription(options.type.description)
        .setRequired(false)
        .addChoices(...options.type.choices));
  }

  if ('screenshot' in options && options.screenshot) {
    data.addAttachmentOption(option =>
      option.setName(options.screenshot.name)
        .setDescription(options.screenshot.description)
        .setRequired(false));
  }

  if ('savefile' in options && options.savefile) {
    data.addAttachmentOption(option =>
      option.setName(options.savefile.name)
        .setDescription(options.savefile.description)
        .setRequired(false));
  }

  if ('settings' in options && options.settings) {
    data.addBooleanOption(option =>
      option.setName(options.settings.name)
        .setDescription(options.settings.description)
        .setRequired(false));
  }

  return data.toJSON();
}

/** Slash command payloads for Discord registration — no runtime handlers. */
export function getSlashCommandRegistrationPayload(): unknown[] {
  const botConfig = getBotConfig();

  const ping = new SlashCommandBuilder()
    .setName(botConfig.commands.ping.name)
    .setDescription(botConfig.commands.ping.description)
    .toJSON();

  const analytics = new SlashCommandBuilder()
    .setName(botConfig.commands.analytics.name)
    .setDescription(botConfig.commands.analytics.description)
    .addIntegerOption(option =>
      option.setName(botConfig.commands.analytics.options.daysBack.name)
        .setDescription(botConfig.commands.analytics.options.daysBack.description)
        .setRequired(false)
        .setMinValue(botConfig.commands.analytics.options.daysBack.min)
        .setMaxValue(botConfig.commands.analytics.options.daysBack.max))
    .toJSON();

  const cph = new SlashCommandBuilder()
    .setName(botConfig.commands.cph.name)
    .setDescription(botConfig.commands.cph.description)
    .addStringOption(option =>
      option.setName(botConfig.commands.cph.options.time.name)
        .setDescription(botConfig.commands.cph.options.time.description)
        .setRequired(true))
    .addStringOption(option =>
      option.setName(botConfig.commands.cph.options.coins.name)
        .setDescription(botConfig.commands.cph.options.coins.description)
        .setRequired(false))
    .addStringOption(option =>
      option.setName(botConfig.commands.cph.options.cells.name)
        .setDescription(botConfig.commands.cph.options.cells.description)
        .setRequired(false))
    .addStringOption(option =>
      option.setName(botConfig.commands.cph.options.dice.name)
        .setDescription(botConfig.commands.cph.options.dice.description)
        .setRequired(false))
    .toJSON();

  return [
    ping,
    buildTrackerCommandData('track'),
    buildTrackerCommandData('lifetime'),
    analytics,
    cph,
  ];
}
