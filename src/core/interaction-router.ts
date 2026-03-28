import { Interaction, MessageFlagsBitField } from 'discord.js';
import { logger } from './logger';
import { TrackerBotClient } from './tracker-bot-client';
import { ANALYTICS_EVENT_COMMAND_INVOKED } from '@tmrxjd/platform/tools';

export function registerInteractionRouter(client: TrackerBotClient) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) {
          logger.warn(`No command registered for ${interaction.commandName}`);
          if (interaction.isRepliable()) {
            await interaction.reply({ content: 'Command not found.', flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
          }
          return;
        }
        await command.execute(interaction);
        client.persistence?.analytics.log({
          ts: new Date().toISOString(),
          event: ANALYTICS_EVENT_COMMAND_INVOKED,
          userId: interaction.user.id,
          guildId: interaction.guildId ?? undefined,
          commandName: interaction.commandName,
        }).catch(error => {
          logger.warn('Failed to record analytics event', error);
        });
        return;
      }

      if (
        interaction.isButton()
        || interaction.isStringSelectMenu()
        || interaction.isUserSelectMenu()
        || interaction.isRoleSelectMenu()
        || interaction.isMentionableSelectMenu()
        || interaction.isChannelSelectMenu()
        || interaction.isModalSubmit()
      ) {
        const handled = await client.components.dispatch(interaction);
        if (!handled) {
          return;
        }
      }
    } catch (error) {
      logger.error('Interaction handling error', error);
      if (interaction.isRepliable()) {
        const alreadyAcked = interaction.replied || interaction.deferred;
        const payload = { content: 'There was an error handling this interaction.', flags: MessageFlagsBitField.Flags.Ephemeral } as const;
        if (alreadyAcked) {
          await interaction.editReply({ content: payload.content }).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
    }
  });
}
