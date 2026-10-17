import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { getKnownHistoryFailure } from '../history-failure-diagnostic';

const candidateRoot = resolve(__dirname, '../../../..');
const root = existsSync(resolve(candidateRoot, 'src/features/track/handlers/error-handlers.ts')) ? candidateRoot : resolve(__dirname);
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'DiscordAPIError', 'HTTPError', 'AppwriteException', 'ZodError']);
const codes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR', 'SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_IOERR', 'unrecognized_report', 'missing_fields', 'invalid_date', 'history_unavailable', 'internal_error', 'presentation_error']);
const operations = new Set(['track_menu_sharelast', 'track_menu_log_channel_autoshare', 'share_embed_expand', 'share_embed_battle_report', 'share_embed_track_run', 'direct_text_paste', 'paste_flow_modal', 'paste_add_run_modal', 'dataSubmission', 'import_playerinfo_decode', 'import_direct_save', 'import_modal_flow', 'import_accept']);
export type DiagnosticStage = 'acknowledge' | 'settings' | 'history' | 'render' | 'snapshot' | 'payload' | 'send' | 'finalize' | 'lookup' | 'parse' | 'review' | 'submit' | 'unknown';
const stages = new Set<DiagnosticStage>(['acknowledge', 'settings', 'history', 'render', 'snapshot', 'payload', 'send', 'finalize', 'lookup', 'parse', 'review', 'submit', 'unknown']);
function value(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    // Node lazily materializes native Error stacks through an own accessor.
    return descriptor && 'value' in descriptor ? descriptor.value : key === 'stack' && error instanceof Error ? Reflect.get(error, key) : undefined;
  } catch { return undefined; }
}
/** Never emit messages, function names, URLs, arbitrary names/codes or absolute paths. */
export function safeErrorDiagnostic(error: unknown, context: string, stage: DiagnosticStage = 'unknown') {
  let name = value(error, 'name');
  if (name === undefined && error instanceof Error) {
    let prototype = Object.getPrototypeOf(error);
    for (let i = 0; i < 3 && prototype && name === undefined; i++, prototype = Object.getPrototypeOf(prototype)) name = Object.getOwnPropertyDescriptor(prototype, 'name')?.value;
  }
  const exceptionType = typeof name === 'string' && types.has(name) ? name : error instanceof Error ? 'Error' : 'Unknown';
  const rawCode = value(error, 'code');
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) && rawCode >= 0 && rawCode <= 999999 ? rawCode : typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : undefined;
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
  const historyFailure = getKnownHistoryFailure(error);
  return { exceptionType, code, operation: operations.has(context) ? context : 'other', stage: stages.has(stage) ? stage : 'unknown', frames,
    ...(historyFailure ? { historyFailure } : {}) };
}
