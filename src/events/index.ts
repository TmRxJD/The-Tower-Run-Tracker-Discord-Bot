import { Events } from 'discord.js';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';

export function registerEvents(client: TrackerBotClient) {
  client.once(Events.ClientReady, readyClient => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
  });
}
