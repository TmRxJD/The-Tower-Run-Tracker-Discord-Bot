import { Events } from 'discord.js';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { startTrackerRunBackgroundSyncScheduler } from '../features/track/run-background-sync-scheduler';

export function registerEvents(client: TrackerBotClient) {
  client.once(Events.ClientReady, readyClient => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
    startTrackerRunBackgroundSyncScheduler(client);
  });
}
