import { Events } from 'discord.js';
import { registerGatewayHealthLogging } from '../core/gateway-health';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { startTrackerRunBackgroundSyncScheduler } from '../features/track/run-background-sync-scheduler';
import { setTrackerKv } from '../services/idb';
import { startWebsiteUpdatesMirror } from '../features/website-updates/runtime';

export function registerEvents(client: TrackerBotClient) {
  registerGatewayHealthLogging(client, () => { process.emit('SIGTERM'); });

  client.once(Events.ClientReady, readyClient => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
    void setTrackerKv('tracker-runtime-ready:v1', {pid: process.pid, readyAt: Date.now()})
      .catch(() => logger.error('Tracker readiness receipt could not be persisted'));
    startTrackerRunBackgroundSyncScheduler(client);
    startWebsiteUpdatesMirror(client, client.appConfig.deploymentMode);
  });
}
