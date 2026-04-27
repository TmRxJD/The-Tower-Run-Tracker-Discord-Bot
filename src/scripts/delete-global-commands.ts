import { REST, Routes } from 'discord.js';
import { getAppConfig, loadConfig } from '../config';
import { validateBotBootstrapConfig } from '../core/bootstrap-contract';
import { logger } from '../core/logger';

async function deleteAllGlobalCommands() {
  loadConfig();
  const appConfig = getAppConfig();
  const runtime = validateBotBootstrapConfig(appConfig);
  const rest = new REST({ version: '10' }).setToken(runtime.loginToken);

  logger.info('Clearing all global commands...');
  await rest.put(Routes.applicationCommands(runtime.clientId), { body: [] });
  logger.info('All global commands deleted.');
}

void deleteAllGlobalCommands().catch(error => {
  logger.error('Failed to delete global commands', error);
  process.exitCode = 1;
});