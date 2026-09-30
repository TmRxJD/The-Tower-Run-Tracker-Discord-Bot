import { Events } from 'discord.js';
import { registerGatewayHealthLogging } from '../core/gateway-health';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { startTrackerRunBackgroundSyncScheduler } from '../features/track/run-background-sync-scheduler';

export function registerEvents(client: TrackerBotClient) {
  registerGatewayHealthLogging(client);

  client.once(Events.ClientReady, readyClient => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
    startTrackerRunBackgroundSyncScheduler(client);
  });
}
