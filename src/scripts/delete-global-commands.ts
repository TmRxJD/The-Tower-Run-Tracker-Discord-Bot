import { REST, Routes } from 'discord.js';
import { getAppConfig, loadConfig } from '../config';
import { validateBotBootstrapConfig } from '../core/bootstrap-contract';
import { logger } from '../core/logger';

async function deleteAllGlobalCommands() {
  loadConfig();
  const appConfig = getAppConfig();
  const runtime = validateBotBootstrapConfig(appConfig);
  const rest = new REST({ version: '10' }).setToken(runtime.loginToken);

  logger.info('Fetching all global commands...');
  const commands = await rest.get(Routes.applicationCommands(runtime.clientId));

  if (Array.isArray(commands)) {
    for (const command of commands) {
      logger.info(`Deleting global command: ${command.name} (${command.id})`);
      await rest.delete(Routes.applicationCommand(runtime.clientId, command.id));
    }
    logger.info('All global commands deleted.');
  } else {
    logger.info('No global commands found.');
  }
}

void deleteAllGlobalCommands().catch(error => {
  logger.error('Failed to delete global commands', error);
  process.exitCode = 1;
});