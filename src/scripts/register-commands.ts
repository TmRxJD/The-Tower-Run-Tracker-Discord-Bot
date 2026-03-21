import { REST, Routes } from 'discord.js';
import { commandModules } from '../commands';
import { logger } from '../core/logger';
import { getAppConfig, loadConfig } from '../config';

async function registerCommands() {
  loadConfig();
  const appConfig = getAppConfig();

  const rest = new REST({ version: '10' }).setToken(appConfig.discord.token);
  const body = commandModules.map((command: { data: unknown }) => command.data);
  const targetGuildId = appConfig.discord.guildId;

  if (targetGuildId) {
    logger.info(`Registering ${body.length} guild commands to ${targetGuildId}`);
    await rest.put(Routes.applicationGuildCommands(appConfig.discord.clientId, targetGuildId), { body });
  } else {
    logger.info(`Registering ${body.length} global commands`);
    await rest.put(Routes.applicationCommands(appConfig.discord.clientId), { body });
  }

  logger.info('Slash commands refreshed');
}

registerCommands().catch(error => {
  logger.error('Failed to register commands', error);
  process.exitCode = 1;
});
