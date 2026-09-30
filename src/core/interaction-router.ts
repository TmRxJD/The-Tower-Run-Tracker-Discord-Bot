import type { Interaction} from 'discord.js';
import { MessageFlagsBitField } from 'discord.js';
import { logger } from './logger';
import { recordDiagnostic } from './diagnostics';
import type { TrackerBotClient } from './tracker-bot-client';
import { ANALYTICS_EVENT_COMMAND_INVOKED } from '@tmrxjd/platform/tools';
import { clearMainMenuSession } from '../features/track/handlers/upload-handlers';

/**
 * Shown for a button or select whose handler no longer exists (usually a menu that outlived
 * the process that registered it). Without a reply Discord renders "This interaction failed"
 * and the user retries a click that can never work.
 */
export const STALE_COMPONENT_MESSAGE = 'That menu is no longer active. Run the command again to open a fresh one.';

export function registerInteractionRouter(client: TrackerBotClient) {
  const handleInteraction = async (interaction: Interaction) => {
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
        // Any component interaction means the user has navigated — clear the main menu
        // background update so it doesn't stomp whatever screen they've moved to.
        clearMainMenuSession(interaction.user.id);
        const handled = await client.components.dispatch(interaction);
        if (!handled) {
          // Nothing acknowledged this interaction, so Discord renders "This interaction
          // failed" and the user clicks again. Usually a customId from a message that
          // outlived the process that registered its handler.
          recordDiagnostic('interaction.dropped', {
            interactionId: interaction.id,
            userId: interaction.user.id,
            customId: 'customId' in interaction ? interaction.customId : null,
            type: interaction.type,
            ageOnArrivalMs: Date.now() - interaction.createdTimestamp,
          });
          // Modal submits are claimed by command-local awaitModalSubmit waits and are
          // expected to reach no registered handler; stay out of their way.
          if (!interaction.isModalSubmit() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: STALE_COMPONENT_MESSAGE, flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
          }
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
  };

  client.on('interactionCreate', interaction => {
    void handleInteraction(interaction);
  });
}
