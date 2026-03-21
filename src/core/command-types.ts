import { ChatInputCommandInteraction, RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

export interface CommandModule {
  data: RESTPostAPIApplicationCommandsJSONBody;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  cooldownSeconds?: number;
}
