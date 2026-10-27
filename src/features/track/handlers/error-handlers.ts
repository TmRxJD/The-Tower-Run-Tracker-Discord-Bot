import { safeErrorDiagnostic, type DiagnosticStage } from './safe-error-diagnostic';
import { randomUUID } from 'node:crypto';
import { Colors, EmbedBuilder } from 'discord.js';
import { logger } from '../../../core/logger';
import { markPerformanceFailure, performanceDiagnosticContext, performanceTraceIdentity } from '../../../core/performance-trace';
import { diagnosticDelivery } from './diagnostic-delivery';

const ERROR_LOG_CHANNEL_ID = process.env.ERROR_LOG_CHANNEL_ID ?? '1344016216087592960';
interface ErrorContext {
  client: { channels: { fetch: (id: string) => Promise<unknown> } };
  user?: { tag?: string; id?: string };
  error: unknown;
  context: string;
  stage?: DiagnosticStage;
  ocrOutput?: unknown[] | null;
  attachmentUrl?: string | null;
  lifecycle?: { runSaved: boolean; dispatchStarted: boolean; dispatchAdmitted: boolean; admissionAttempted: boolean };
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
  markPerformanceFailure();
  const diagnostic = safeErrorDiagnostic(params.error, params.context, params.stage);
  const rawStatus = diagnostic.status ?? diagnostic.code;
  const status = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const caughtAt = safeErrorDiagnostic(new Error(), params.context, params.stage).frames.filter(frame => !frame.includes('/error-handlers.')).slice(0, 3);
  const lifecycle = params.lifecycle ? Object.fromEntries(['runSaved', 'dispatchStarted', 'dispatchAdmitted', 'admissionAttempted'].flatMap(key => {
    const flag = params.lifecycle![key as keyof NonNullable<ErrorContext['lifecycle']>]; return typeof flag === 'boolean' ? [[key, flag]] : [];
  })) : undefined;
  const details = { incident, category: category(params.context), status, ...performanceDiagnosticContext(), caughtAt,
    ...(lifecycle ? { lifecycle } : {}), ocrLineCount: Array.isArray(params.ocrOutput) ? Math.min(params.ocrOutput.length, 100_000) : 0, attachmentPresent: Boolean(params.attachmentUrl) };
  logger.error('Tracker operation failed; private report content omitted', { ...details, ...diagnostic });
  if (!ERROR_LOG_CHANNEL_ID) return;
  const embed = new EmbedBuilder().setTitle('Tracker operation failed').setColor(Colors.DarkRed)
      .setDescription(`Incident: ${incident}\nOperation: ${details.category}`)
      .setTimestamp();
  diagnosticDelivery.enqueue({ client: params.client, channelId: ERROR_LOG_CHANNEL_ID, embed, incident, correlation: performanceTraceIdentity() });
}
export async function handleError(params: ErrorContext): Promise<void> { await publishSafeDiagnostic(params); }
export async function logError(client: ErrorContext['client'], user: ErrorContext['user'], error: unknown, context: string, ocrOutput: unknown[] | null = null, attachmentUrl: string | null = null, stage: DiagnosticStage = 'unknown'): Promise<void> {
  await publishSafeDiagnostic({ client, user, error, context, ocrOutput, attachmentUrl, stage });
}
