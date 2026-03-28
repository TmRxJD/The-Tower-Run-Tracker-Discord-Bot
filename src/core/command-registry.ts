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

  getSlash(name: string) {
    return this.get(name);
  }

  getContextMenu(_name: string) {
    return undefined;
  }

  has(name: string) {
    return this.commands.has(name);
  }

  listSlash() {
    return this.list();
  }

  listContextMenu() {
    return [] as CommandModule[];
  }

  listAll() {
    return this.list();
  }

  list() {
    return [...this.commands.values()];
  }
}
