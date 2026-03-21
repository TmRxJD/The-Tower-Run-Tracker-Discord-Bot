import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandModule } from '../core/command-types';
import { buildTrackerCommandData, executeTrackerCommand } from './tracker-command-shared';

export const lifetimeCommand: CommandModule = {
  data: buildTrackerCommandData('lifetime'),
  cooldownSeconds: 5,
  async execute(interaction: ChatInputCommandInteraction) {
    await executeTrackerCommand('lifetime', interaction);
  },
};
