import type { EmbedBuilder } from 'discord.js';
export function appendCapturedHistoryFooter(embed: EmbedBuilder, capturedAt?: number): void {
  if (!Number.isFinite(capturedAt) || !capturedAt || capturedAt <= 0 || capturedAt > 8.64e15) return;
  const captured = new Date(capturedAt).toISOString().slice(0, 16).replace('T', ' ');
  embed.setFooter({ text: [embed.data.footer?.text, `History captured ${captured} UTC.`].filter(Boolean).join(' ') });
}
