import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { getKnownHistoryFailure } from '../history-failure-diagnostic';
import { readSubmissionValidation } from '../submission-failure-diagnostic';
import { isDiagnosticStage, performanceDiagnosticContext, readPerformanceErrorStage, type DiagnosticStage } from '../../../core/performance-trace';
import { diagnosticOperations } from './diagnostic-operations';
export type { DiagnosticStage } from '../../../core/performance-trace';

const candidateRoot = resolve(__dirname, '../../../..');
const root = existsSync(resolve(candidateRoot, 'src/features/track/handlers/error-handlers.ts')) ? candidateRoot : resolve(__dirname);
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'AssertionError', 'DiscordAPIError', 'HTTPError', 'AppwriteException', 'ZodError']);
const codes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR', 'SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_IOERR', 'unrecognized_report', 'missing_fields', 'invalid_date', 'history_unavailable', 'internal_error', 'presentation_error']);
function nativeError(error: unknown): error is Error { try { return error instanceof Error; } catch { return false; } }
function value(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    // Node lazily materializes native Error stacks through an own accessor.
    return descriptor && 'value' in descriptor ? descriptor.value : key === 'stack' && nativeError(error) ? Reflect.get(error, key) : undefined;
  } catch { return undefined; }
}
/** Never emit messages, function names, URLs, arbitrary names/codes or absolute paths. */
function facts(error: unknown) {
  let name = value(error, 'name');
  if (name === undefined && nativeError(error)) {
    try {
      let prototype = Object.getPrototypeOf(error);
      for (let i = 0; i < 3 && prototype && name === undefined; i++, prototype = Object.getPrototypeOf(prototype)) name = Object.getOwnPropertyDescriptor(prototype, 'name')?.value;
    } catch { /* Hostile prototypes are not diagnostic data. */ }
  }
  const exceptionType = typeof name === 'string' && types.has(name) ? name : nativeError(error) ? 'Error' : 'Unknown';
  const rawCode = value(error, 'code');
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && rawCode >= 0 && rawCode <= 999999 ? rawCode : typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : undefined;
  const rawStatus = value(error, 'status') ?? value(error, 'statusCode') ?? code;
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const frames: string[] = [];
  const stack = value(error, 'stack');
  if (typeof stack === 'string') {
    for (const line of stack.slice(0, 16384).split('\n').slice(1, 33)) {
      const match = line.match(/(?:\(|\s)((?:[A-Za-z]:[\\/]|\/)[^\n()]+):([0-9]{1,7}):([0-9]{1,7})\)?$/);
      if (!match) continue;
      const file = resolve(match[1]);
      const local = relative(root, file).replace(/\\/g, '/');
      if (!/^(?:src|dist)\/(?:features|core|services|persistence)\/[a-zA-Z0-9_./-]+\.(?:ts|js)$/.test(local) || local.split('/').includes('..') || !existsSync(file)) continue;
      frames.push(`${local}:${match[2]}:${match[3]}`);
      if (frames.length === 6) break;
    }
  }
  return { exceptionType, code, status, frames, stackPresent: typeof stack === 'string', errorShape: nativeError(error) ? 'error' : error === null ? 'null' : typeof error === 'object' ? 'object' : typeof error };
}
/** Bounded causes and mapped source locations only; never messages, URLs or report values. */
export function safeErrorDiagnostic(error: unknown, context: string, stage: DiagnosticStage = 'unknown') {
  const chain: unknown[] = [];
  for (let current: unknown = error; chain.length < 3 && !chain.includes(current); current = value(current, 'cause')) {
    chain.push(current); if (value(current, 'cause') === undefined) break;
  }
  const all = chain.map(facts), deepest = all[all.length - 1], first = all[0];
  const frameIndex = all.map((item, i) => item.frames.length ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  const validation = [...chain].reverse().map(readSubmissionValidation).find(Boolean);
  const failureStage = [...chain].reverse().map(readPerformanceErrorStage).find(Boolean);
  const activeStage = performanceDiagnosticContext().diagnosticStage;
  const resolvedStage = validation ? 'validate' : failureStage ?? (isDiagnosticStage(stage) && stage !== 'unknown' ? stage : isDiagnosticStage(activeStage) ? activeStage : 'unknown');
  const historyFailure = chain.map(getKnownHistoryFailure).find(Boolean);
  return { exceptionType: deepest.exceptionType, code: first.code ?? deepest.code,
    status: all.map(item => item.status).find(status => status !== undefined),
    operation: diagnosticOperations.has(context) ? context : 'other', stage: resolvedStage,
    frames: frameIndex >= 0 ? all[frameIndex].frames : [], framesOrigin: frameIndex > 0 ? 'cause' : frameIndex === 0 ? 'error' : 'none',
    stackPresent: all.some(item => item.stackPresent), errorShape: deepest.errorShape, causeDepth: chain.length - 1,
    ...(historyFailure ? { historyFailure } : {}), ...(validation ? { validation } : {}) };
}
