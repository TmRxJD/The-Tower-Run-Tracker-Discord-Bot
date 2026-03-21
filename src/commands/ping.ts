import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandModule } from '../core/command-types';
import { getBotConfig } from '../config/bot-config';

const botConfig = getBotConfig();
const COPY = botConfig.commands.ping;

const data = new SlashCommandBuilder()
  .setName(COPY.name)
  .setDescription(COPY.description);

export const pingCommand: CommandModule = {
  data: data.toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    const started = Date.now();
    const reply = await interaction.reply({ content: COPY.messages.pending, ephemeral: true, fetchReply: true });
    const latency = Date.now() - started;
    const apiLatency = interaction.client.ws.ping;
    const content = `${COPY.messages.resultPrefix}${latency}${COPY.messages.latencyUnit}${COPY.messages.apiLabel}${apiLatency}${COPY.messages.latencyUnit}`;
    if (reply.editable) {
      await interaction.editReply({ content });
    } else {
      await interaction.followUp({ content, ephemeral: true });
    }
  },
};
