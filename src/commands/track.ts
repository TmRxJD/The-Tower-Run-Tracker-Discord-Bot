import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandModule } from '../core/command-types';
import { buildTrackerCommandData, executeTrackerCommand } from './tracker-command-shared';

export const trackCommand: CommandModule = {
  data: buildTrackerCommandData('track'),
  cooldownSeconds: 5,
  async execute(interaction: ChatInputCommandInteraction) {
    await executeTrackerCommand('track', interaction);
  },
};
