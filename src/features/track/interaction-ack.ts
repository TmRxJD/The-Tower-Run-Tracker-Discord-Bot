import { MessageFlagsBitField, type RepliableInteraction } from 'discord.js';
import { logger } from '../../core/logger';

/**
 * Discord invalidates an interaction token if it is not acknowledged within ~3s, and every
 * later reply/editReply on that token then fails with 10062 "Unknown interaction".
 *
 * Swallowing a failed `deferReply()` leaves `interaction.deferred` false, so downstream code
 * keeps trying to respond on a dead token and buries the real cause under a cascade of 10062s.
 * Callers must bail out when this returns false — there is no way to talk to the user anymore.
 */
export async function ensureDeferredEphemeralReply(interaction: RepliableInteraction): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;

  try {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });
    return true;
  } catch (error) {
    logger.error('Failed to acknowledge interaction; its token is no longer usable', {
      userId: interaction.user.id,
      interactionId: interaction.id,
      createdAt: interaction.createdAt.toISOString(),
      ageMs: Date.now() - interaction.createdTimestamp,
      error,
    });
    return false;
  }
}
