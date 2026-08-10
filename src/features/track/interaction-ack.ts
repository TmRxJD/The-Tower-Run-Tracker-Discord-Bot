import { MessageFlagsBitField, type RepliableInteraction } from 'discord.js';
import { logger } from '../../core/logger';
import { INTERACTION_ACK_BUDGET_MS, recordDiagnostic } from '../../core/diagnostics';

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

  // Age on arrival vs. how long the ACK round-trip itself took: a large ageOnArrivalMs
  // means the event loop was busy before we ever saw this interaction, while a large
  // ackDurationMs points at Discord's REST path instead.
  const ageOnArrivalMs = Date.now() - interaction.createdTimestamp;
  const ackStartedAt = Date.now();

  try {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });
    recordDiagnostic('interaction.ack', {
      outcome: 'acknowledged',
      interactionId: interaction.id,
      userId: interaction.user.id,
      type: interaction.type,
      ageOnArrivalMs,
      ackDurationMs: Date.now() - ackStartedAt,
      totalAgeMs: Date.now() - interaction.createdTimestamp,
      budgetMs: INTERACTION_ACK_BUDGET_MS,
      nearBudget: Date.now() - interaction.createdTimestamp > INTERACTION_ACK_BUDGET_MS / 2,
    });
    return true;
  } catch (error) {
    recordDiagnostic('interaction.ack', {
      outcome: 'failed',
      interactionId: interaction.id,
      userId: interaction.user.id,
      type: interaction.type,
      ageOnArrivalMs,
      ackDurationMs: Date.now() - ackStartedAt,
      totalAgeMs: Date.now() - interaction.createdTimestamp,
      budgetMs: INTERACTION_ACK_BUDGET_MS,
    });
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
