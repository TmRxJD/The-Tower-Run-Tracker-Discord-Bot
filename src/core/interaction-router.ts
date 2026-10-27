import type { Interaction} from 'discord.js';
import { MessageFlagsBitField } from 'discord.js';
import { logger } from './logger';
import { recordDiagnostic } from './diagnostics';
import { hasOwnedModalWait } from './interaction-session';
import type { TrackerBotClient } from './tracker-bot-client';
import { ANALYTICS_EVENT_COMMAND_INVOKED } from '@tmrxjd/platform/tools';
import { clearMainMenuSession } from '../features/track/handlers/upload-handlers';
import { observeOperation } from './operation-lifecycle';
import { markPerformanceFailure, performanceDiagnosticContext, rememberPerformanceErrorStage } from './performance-trace';
import { safeErrorDiagnostic } from '../features/track/handlers/safe-error-diagnostic';

/**
 * Shown for a button or select whose handler no longer exists (usually a menu that outlived
 * the process that registered it). Without a reply Discord renders "This interaction failed"
 * and the user retries a click that can never work.
 */
export const STALE_COMPONENT_MESSAGE = 'That menu is no longer active. Run the command again to open a fresh one.';

export function registerInteractionRouter(client: TrackerBotClient) {
  const handleInteraction = async (interaction: Interaction) => observeOperation('interaction', async () => {
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
          logger.warn('Failed to record analytics event', { ...performanceDiagnosticContext(), ...safeErrorDiagnostic(error, 'interaction_router', 'finalize') });
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
        // Capture before the async dispatch: the local collector may resolve and
        // remove its wait while dispatch is pending. It still owned this event.
        const locallyOwnedModal = interaction.isModalSubmit()
          && hasOwnedModalWait(interaction.user.id, interaction.customId);
        const handled = await client.components.dispatch(interaction);
        if (!handled) {
          if (locallyOwnedModal) return;
          // Nothing acknowledged this interaction, so Discord renders "This interaction
          // failed" and the user clicks again. Usually a customId from a message that
          // outlived the process that registered its handler.
          recordDiagnostic('interaction.dropped', {
            ...performanceDiagnosticContext(),
            customIdPresent: Boolean('customId' in interaction && interaction.customId),
            type: interaction.type,
            ageOnArrivalMs: Date.now() - interaction.createdTimestamp,
          });
          // Unowned modal submits remain diagnostic events. Do not introduce an
          // automatic ACK here; registered/local handlers retain response ownership.
          if (!interaction.isModalSubmit() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: STALE_COMPONENT_MESSAGE, flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
          }
          return;
        }
      }
    } catch (error) {
      rememberPerformanceErrorStage(error);
      markPerformanceFailure();
      logger.error('Interaction handling error', { ...performanceDiagnosticContext(), ...safeErrorDiagnostic(error, 'interaction_router', 'dispatch') });
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

  client.on('interactionCreate', interaction => {
    void handleInteraction(interaction);
  });
}
