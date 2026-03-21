import type { CommandModule } from '../core/command-types';
import { pingCommand } from './ping';
import { trackCommand } from './track';
import { lifetimeCommand } from './lifetime';
import { analyticsCommand } from './analytics';
import { cphCommand } from './cph';

export const commandModules: CommandModule[] = [
	pingCommand,
	trackCommand,
	lifetimeCommand,
	analyticsCommand,
	cphCommand,
];
