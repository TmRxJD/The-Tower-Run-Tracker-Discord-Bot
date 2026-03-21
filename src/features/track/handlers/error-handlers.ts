import { AttachmentBuilder, Colors, EmbedBuilder } from 'discord.js';
import { logger } from '../../../core/logger';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';

const ERROR_LOG_CHANNEL_ID = process.env.ERROR_LOG_CHANNEL_ID ?? '1344016216087592960';

interface ErrorContext {
  client: { channels: { fetch: (id: string) => Promise<unknown> } };
  user?: { tag?: string; id?: string };
  error: unknown;
  context: string;
  ocrOutput?: unknown[] | null;
  attachmentUrl?: string | null;
}

type SendableChannel = {
  send: (payload: unknown) => Promise<unknown>;
};

function isSendableChannel(value: unknown): value is SendableChannel {
  return typeof value === 'object' && value !== null && 'send' in value && typeof (value as { send?: unknown }).send === 'function';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStack(error: unknown): string {
  if (error instanceof Error && error.stack) return error.stack;
  return '';
}

function replaceTokens(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((output, [key, value]) => {
    return output.split(`{${key}}`).join(value);
  }, template);
}

async function sendErrorEmbed({ client, user, error, context, ocrOutput, attachmentUrl }: ErrorContext) {
  const errorUiConfig = getTrackUiConfig().errorLog;
  const errorChannel = await client.channels.fetch(ERROR_LOG_CHANNEL_ID).catch(() => null);
  if (!isSendableChannel(errorChannel)) {
    logger.error(`Error log channel ${ERROR_LOG_CHANNEL_ID} not found or bot lacks permission.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(errorUiConfig.title)
    .setDescription(
      replaceTokens(errorUiConfig.descriptionTemplate, {
        userTag: user?.tag || errorUiConfig.unknownUserTag,
        userId: user?.id || errorUiConfig.unknownUserId,
        context,
        errorMessage: getErrorMessage(error).slice(0, 1000),
      }),
    )
    .setColor(Colors.DarkRed)
    .setTimestamp();

  if (ocrOutput && Array.isArray(ocrOutput) && ocrOutput.length > 0) {
    const ocrText = ocrOutput
      .map((line) => {
        if (typeof line === 'object' && line !== null && 'text' in line) {
          const text = (line as { text?: unknown }).text;
          return typeof text === 'string' ? text : String(text ?? '');
        }
        return String(line);
      })
      .join('\n')
      .slice(0, 1020);
    embed.addFields({ name: errorUiConfig.ocrFieldLabel, value: ocrText, inline: false });
  }

  if (attachmentUrl) {
    try {
      const attachment = new AttachmentBuilder(attachmentUrl);
      embed.setImage(`attachment://${attachment.name || 'error_image.png'}`);
      await errorChannel.send({ embeds: [embed], files: [attachment] });
      return;
    } catch (attachError) {
      logger.error('Failed to create attachment for error log:', attachError);
      embed.addFields({ name: errorUiConfig.attachmentErrorLabel, value: replaceTokens(errorUiConfig.attachmentErrorTemplate, { attachmentUrl }) });
    }
  }

  await errorChannel.send({ embeds: [embed] });
}

export async function handleError(params: ErrorContext) {
  try {
    await sendErrorEmbed(params);
  } catch (logError) {
    logger.error('Failed to log error to channel', logError);
  }
}

export async function logError(
  client: { channels: { fetch: (id: string) => Promise<unknown> } },
  user: { tag?: string; id?: string } | undefined,
  error: unknown,
  context: string,
  ocrOutput: unknown[] | null = null,
  attachmentUrl: string | null = null,
) {
  const errorUiConfig = getTrackUiConfig().errorLog;
  logger.error(`[DETAILED ERROR LOG] User: ${user?.id || 'Unknown'}, Context: ${context}`, error);
  if (!ERROR_LOG_CHANNEL_ID) {
    logger.error('ERROR_LOG_CHANNEL_ID is not set; cannot log error to channel.');
    return;
  }

  try {
    const errorChannel = await client.channels.fetch(ERROR_LOG_CHANNEL_ID).catch(() => null);
    if (!isSendableChannel(errorChannel)) {
      logger.error(`Error log channel ${ERROR_LOG_CHANNEL_ID} not found or bot lacks permission.`);
      return;
    }

    const errorEmbed = new EmbedBuilder()
      .setTitle(errorUiConfig.title)
      .setDescription(
        replaceTokens(errorUiConfig.descriptionWithStackTemplate, {
          userTag: user?.tag || errorUiConfig.unknownUserTag,
          userId: user?.id || errorUiConfig.unknownUserId,
          context,
          errorMessage: getErrorMessage(error).slice(0, 1000),
          stackTrace: getErrorStack(error).slice(0, 1000),
        }),
      )
      .setColor(Colors.DarkRed)
      .setTimestamp();

    if (ocrOutput && Array.isArray(ocrOutput) && ocrOutput.length > 0) {
      const ocrText = ocrOutput
        .map((line) => {
          if (typeof line === 'object' && line !== null && 'text' in line) {
            const text = (line as { text?: unknown }).text;
            return typeof text === 'string' ? text : String(text ?? '');
          }
          return String(line);
        })
        .join('\n')
        .slice(0, 1020);
      errorEmbed.addFields({ name: errorUiConfig.ocrFieldLabel, value: ocrText, inline: false });
    }

    const message: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] } = { embeds: [errorEmbed] };

    if (attachmentUrl) {
      try {
        const attachment = new AttachmentBuilder(attachmentUrl);
        message.files = [attachment];
        errorEmbed.setImage(`attachment://${attachment.name || 'error_image.png'}`);
      } catch (attachError) {
        logger.error('Failed to create attachment for error log:', attachError);
        errorEmbed.addFields({
          name: errorUiConfig.attachmentErrorLabel,
          value: replaceTokens(errorUiConfig.attachmentErrorTemplate, { attachmentUrl }),
        });
      }
    }

    await errorChannel.send(message);
  } catch (logErrorError) {
    logger.error('Failed to log error to the designated channel:', logErrorError);
  }
}
