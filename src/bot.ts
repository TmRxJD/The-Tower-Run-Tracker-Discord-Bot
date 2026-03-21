import { GatewayIntentBits, Partials } from 'discord.js';
import { getAppConfig, loadConfig } from './config';
import { TrackerBotClient } from './core/tracker-bot-client';
import { logger } from './core/logger';
import { registerInteractionRouter } from './core/interaction-router';
import { registerEvents } from './events';
import { commandModules } from './commands';
import { registerComponentHandlers } from './interactions';
import { createPersistence } from './persistence';
import { hydrateBotConfig } from './config/bot-config';
import { assertTrackerKvPersistentStorage, getTrackerKvStorageStatus } from './services/idb';

async function bootstrap() {
  loadConfig();
  const appConfig = getAppConfig();

  await assertTrackerKvPersistentStorage();
  const kvStatus = await getTrackerKvStorageStatus();
  logger.info('Tracker KV storage initialized', kvStatus);

  const client = new TrackerBotClient(
    {
      intents: [GatewayIntentBits.Guilds],
      partials: [Partials.Channel],
    },
    appConfig
  );

  client.persistence = createPersistence();

  // Load bot config (Appwrite overrides) before registering handlers.
  await hydrateBotConfig(client.persistence.configs);

  client.commands.registerMany(commandModules);
  registerEvents(client);
  registerComponentHandlers(client);
  registerInteractionRouter(client);

  await client.login(appConfig.discord.token);
}

void bootstrap().catch(error => {
  logger.error('Failed to bootstrap tracker bot', error);
  process.exitCode = 1;
});
