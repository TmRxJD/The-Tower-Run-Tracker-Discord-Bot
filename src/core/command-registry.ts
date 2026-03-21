import { Collection } from 'discord.js';
import type { CommandModule } from './command-types';

export class CommandRegistry {
  private readonly commands = new Collection<string, CommandModule>();

  register(command: CommandModule) {
    this.commands.set(command.data.name, command);
  }

  registerMany(commands: CommandModule[]) {
    for (const command of commands) {
      this.register(command);
    }
  }

  get(name: string) {
    return this.commands.get(name);
  }

  list() {
    return [...this.commands.values()];
  }
}
