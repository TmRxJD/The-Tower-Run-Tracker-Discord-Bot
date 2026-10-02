import { randomUUID } from 'node:crypto';
import { Colors, EmbedBuilder } from 'discord.js';
import { logger } from '../../../core/logger';

const ERROR_LOG_CHANNEL_ID = process.env.ERROR_LOG_CHANNEL_ID ?? '1344016216087592960';
interface ErrorContext {
  client: { channels: { fetch: (id: string) => Promise<unknown> } };
  user?: { tag?: string; id?: string };
  error: unknown;
  context: string;
  ocrOutput?: unknown[] | null;
  attachmentUrl?: string | null;
}
function category(context: string): string {
  if (context.includes('import')) return 'import';
  if (context.includes('upload') || context.includes('ocr') || context.includes('paste')) return 'upload';
  if (context.includes('share')) return 'share';
  if (context.includes('track')) return 'tracker';
  return 'operation';
}
async function publishSafeDiagnostic(params: ErrorContext): Promise<void> {
  const incident = randomUUID();
  const rawStatus = params.error && typeof params.error === 'object' && 'code' in params.error ? Number(params.error.code) : NaN;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const details = { incident, category: category(params.context), status, ocrLineCount: Array.isArray(params.ocrOutput) ? params.ocrOutput.length : 0, attachmentPresent: Boolean(params.attachmentUrl) };
  logger.error('Tracker operation failed; private report content omitted', details);
  if (!ERROR_LOG_CHANNEL_ID) return;
  try {
    const channel = await params.client.channels.fetch(ERROR_LOG_CHANNEL_ID);
    if (!channel || typeof channel !== 'object' || !('send' in channel) || typeof channel.send !== 'function') return;
    const embed = new EmbedBuilder().setTitle('Tracker operation failed').setColor(Colors.DarkRed)
      .setDescription(`Incident: ${incident}\nOperation: ${details.category}${status === undefined ? '' : `\nStatus: ${status}`}\nOCR lines: ${details.ocrLineCount}\nAttachment supplied: ${details.attachmentPresent ? 'yes' : 'no'}`)
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    logger.error('Tracker diagnostic delivery failed', { incident });
  }
}
export async function handleError(params: ErrorContext): Promise<void> { await publishSafeDiagnostic(params); }
export async function logError(client: ErrorContext['client'], user: ErrorContext['user'], error: unknown, context: string, ocrOutput: unknown[] | null = null, attachmentUrl: string | null = null): Promise<void> {
  await publishSafeDiagnostic({ client, user, error, context, ocrOutput, attachmentUrl });
}
