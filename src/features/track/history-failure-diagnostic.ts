import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const causes = ['timeout', 'transport', 'http_status', 'schema', 'pagination', 'count_consistency', 'identity', 'ownership', 'busy', 'unknown'] as const;
const stages = ['settings', 'identity', 'main_page', 'main_count', 'extended_page', 'stitch', 'cloud_history', 'local_history', 'hydration', 'visibility', 'lock_wait', 'unknown'] as const;
const transportCodes = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'] as const;
export const historyFailureSchema = z.object({
  cause: z.enum(causes), stage: z.enum(stages), correlation: z.string().uuid(),
  status: z.number().int().min(400).max(599).optional(),
  transportCode: z.enum(transportCodes).optional(),
  pagination: z.object({
    reason: z.enum(['empty_before_total', 'records_exceed_total']),
    pageIndex: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    returnedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    collectedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedTotal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict().optional(),
}).strict();
export type HistoryFailureDiagnostic = z.infer<typeof historyFailureSchema>;
export type HistoryFailureStage = HistoryFailureDiagnostic['stage'];
const metadata = new WeakMap<object, Readonly<HistoryFailureDiagnostic>>();
function copyDiagnostic(diagnostic: Readonly<HistoryFailureDiagnostic>): HistoryFailureDiagnostic {
  return { ...diagnostic, ...(diagnostic.pagination ? { pagination: { ...diagnostic.pagination } } : {}) };
}

export function getKnownHistoryFailure(error: unknown): HistoryFailureDiagnostic | undefined {
  const known = error && typeof error === 'object' ? metadata.get(error) : undefined;
  return known ? copyDiagnostic(known) : undefined;
}

/** Carry registered safe metadata through a privacy wrapper without inspecting the source. */
export function copyKnownHistoryFailure(source: unknown, target: Error): Error {
  const known = getKnownHistoryFailure(source);
  if (known) metadata.set(target, Object.freeze(known));
  return target;
}

// Never inspect messages, stacks, response bodies or invoke arbitrary property getters.
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
export function readHistoryFailure(error: unknown, stage: HistoryFailureStage = 'unknown', correlation = randomUUID()): HistoryFailureDiagnostic {
  if (error && typeof error === 'object') {
    const known = metadata.get(error);
    if (known) return copyDiagnostic(known);
  }
  const code = ownData(error, 'code');
  const status = [code, ownData(error, 'status')].find(value => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599);
  if (typeof status === 'number') return { cause: 'http_status', stage, correlation, status };
  const candidate = typeof code === 'string' ? code : ownData(ownData(error, 'cause'), 'code');
  const transportCode = transportCodes.find(allowed => allowed === candidate);
  if (transportCode) return { cause: transportCode.includes('TIMEOUT') || transportCode === 'ETIMEDOUT' ? 'timeout' : 'transport', stage, correlation, transportCode };
  return { cause: 'unknown', stage, correlation };
}
export function annotateHistoryFailure(error: unknown, stage: HistoryFailureStage, correlation = randomUUID()): unknown {
  const target = error && typeof error === 'object' ? error : new Error('Run history could not be verified. Please retry.');
  metadata.set(target, Object.freeze(historyFailureSchema.parse(readHistoryFailure(target, stage, correlation))));
  return target;
}
export function historyFailureError(message: string, cause: HistoryFailureDiagnostic['cause'], stage: HistoryFailureStage, correlation = randomUUID(), details: Pick<HistoryFailureDiagnostic, 'pagination'> = {}): Error {
  const error = new Error(message);
  metadata.set(error, Object.freeze(historyFailureSchema.parse({ ...details, cause, stage, correlation })));
  return error;
}
