import { REST, Routes } from 'discord.js';
import { ZodError } from 'zod';
import { commandModules } from '../commands';
import { validateBotBootstrapConfig } from '../core/bootstrap-contract';
import { logger } from '../core/logger';
import { getAppConfig, loadConfig } from '../config';

type RegisterCommandOptions = {
  deploymentMode?: 'dev' | 'prod';
  forceGlobal: boolean;
  guildId?: string;
};

function parseRegisterCommandOptions(argv: string[]): RegisterCommandOptions {
  const options: RegisterCommandOptions = {
    forceGlobal: false,
  };

  for (const arg of argv) {
    if (arg === '--prod') {
      options.deploymentMode = 'prod';
      continue;
    }

    if (arg === '--dev') {
      options.deploymentMode = 'dev';
      continue;
    }

    if (arg === '--global') {
      options.forceGlobal = true;
      continue;
    }

    if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      if (mode === 'dev' || mode === 'prod') {
        options.deploymentMode = mode;
      }
      continue;
    }

    if (arg.startsWith('--guild-id=')) {
      const guildId = arg.slice('--guild-id='.length).trim();
      if (guildId) {
        options.guildId = guildId;
      }
    }
  }

  return options;
}

async function registerCommands() {
  const options = parseRegisterCommandOptions(process.argv.slice(2));
  if (options.deploymentMode) {
    process.env.DEPLOYMENT_MODE = options.deploymentMode;
  }

  loadConfig();
  const appConfig = getAppConfig();
  const runtime = validateBotBootstrapConfig(appConfig);

  const rest = new REST({ version: '10' }).setToken(runtime.loginToken);
  const body = commandModules.map((command: { data: unknown }) => command.data);
  const targetGuildId = resolveTargetGuildId(runtime.deploymentMode, options, runtime.registrationGuildId);

  logger.info(`Preparing command registration for ${runtime.deploymentMode} mode`);

  if (targetGuildId) {
    logger.info(`Registering ${body.length} guild commands to ${targetGuildId}`);
    await rest.put(Routes.applicationGuildCommands(runtime.clientId, targetGuildId), { body });
  } else {
    logger.info(`Registering ${body.length} global commands`);
    await rest.put(Routes.applicationCommands(runtime.clientId), { body });
  }

  logger.info('Slash commands refreshed');
}

function resolveTargetGuildId(
  deploymentMode: 'dev' | 'prod',
  options: RegisterCommandOptions,
  configuredGuildId?: string,
): string | undefined {
  if (options.forceGlobal) {
    return undefined;
  }

  if (options.guildId) {
    return options.guildId;
  }

  if (deploymentMode === 'dev') {
    return configuredGuildId;
  }

  return undefined;
}

registerCommands().catch(error => {
  if (error instanceof ZodError) {
    logger.error('Failed to register commands: invalid environment configuration', error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })));
    process.exitCode = 1;
    return;
  }

  logger.error('Failed to register commands', error);
  process.exitCode = 1;
});
