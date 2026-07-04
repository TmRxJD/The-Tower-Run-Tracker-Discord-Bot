import { Colors, type EmbedBuilder } from 'discord.js';
import { buildShareEmbed } from './share-embed';
import type { ShareEmbedInput } from './share-embed';

export function buildBulkImportShareEmbed(input: ShareEmbedInput & { importedCount: number }): EmbedBuilder {
  const count = Math.max(1, input.importedCount);
  const embed = buildShareEmbed(input);
  const data = embed.data;
  const authorName = `${input.user.displayName ?? input.user.username} imported ${count} run${count === 1 ? '' : 's'}`;
  embed.setAuthor({
    name: authorName,
    iconURL: input.user.displayAvatarURL?.() || undefined,
  });
  const runType = String(input.run.type ?? 'Farming');
  const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
  embed.setTitle(`${formattedType} Import Summary (${count} runs)`);
  embed.setColor(Colors.Gold);
  if (data.description) {
    embed.setDescription(`**Average across ${count} imported run${count === 1 ? '' : 's'}**\n\n${data.description}`);
  }
  return embed;
}
