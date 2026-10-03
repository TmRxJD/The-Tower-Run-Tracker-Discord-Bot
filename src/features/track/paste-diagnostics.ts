import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../core/logger';
import { historyFailureSchema } from './history-failure-diagnostic';

const referencePattern = /^P-([a-z0-9]{8,12})-([a-f0-9]{12})$/;
const filePattern = /^P-([a-z0-9]{8,12})-[a-f0-9]{12}\.json(?:\.tmp-[a-f0-9]{12})?$/;
const outcomes = ['received', 'parsed', 'review_ready', 'saved', 'rejected', 'failed', 'cancelled'] as const;
const stages = ['parse', 'history', 'review', 'submit'] as const;
const codes = ['unrecognized_report', 'missing_fields', 'invalid_date', 'history_unavailable', 'internal_error', 'presentation_error'] as const;
const patchSchema = z.object({
  result: z.enum(outcomes).optional(), stage: z.enum(stages).optional(), errorCode: z.enum(codes).optional(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  localId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  historyFailure: historyFailureSchema.optional(),
}).strict();
const recordSchema = patchSchema.extend({
  reference: z.string().regex(referencePattern), createdAt: z.number().int(), updatedAt: z.number().int(),
  userId: z.string().max(32), source: z.enum(['direct', 'modal']), result: z.enum(outcomes), stage: z.enum(stages),
  rawBytes: z.number().int().nonnegative(), capturedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(), redactions: z.number().int().nonnegative(), text: z.string().max(32_768),
}).strict();
type PastePatch = z.infer<typeof patchSchema>;
type Record = z.infer<typeof recordSchema>;

/** Redact recognizable credentials before disk I/O. Arbitrary unlabeled secrets cannot be identified. */
export function redactPasteText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const hide = () => { redactions++; return '[REDACTED]'; };
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, hide)
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|mfa\.[A-Za-z0-9_-]{20,})\b/g, hide)
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, hide)
    .replace(/\b(?:Bearer|Bot)\s+[A-Za-z0-9._-]{10,}/gi, hide)
    .replace(/((?:["']?\b(?:api[_ -]?key|authorization|token|password|secret|client[_ -]?secret|session|cookie)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
      (_value, label: string) => { redactions++; return label + '[REDACTED]'; });
  return { text, redactions };
}

function boundedUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text.slice(0, maxBytes), 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

export class PasteDiagnosticStore {
  private tail: Promise<unknown> = Promise.resolve();
  private lastWarning = 0;
  constructor(private options: { directory: string; retentionDays?: number; maxBytes?: number; maxFiles?: number; inputBytes?: number; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private retentionMs() { return (this.options.retentionDays ?? 7) * 86_400_000; }
  private maxBytes() { return this.options.maxBytes ?? 8 * 1024 * 1024; }
  private maxFiles() { return this.options.maxFiles ?? 512; }
  private async enqueue<T>(action: () => Promise<T>): Promise<T | null> {
    const task = this.tail.then(async () => {
      try { return await action(); }
      catch {
        // Never log error messages/payloads: a filesystem or parser exception could contain paste text.
        if (this.now() - this.lastWarning >= 60_000) {
          this.lastWarning = this.now();
          logger.warn('[paste-diagnostics] local storage unavailable; upload handling continues');
        }
        return null;
      }
    });
    this.tail = task;
    return task;
  }
  private async verifyDirectory() {
    // Windows installer prepares a protected directory. Never recreate it with inherited broad access.
    if (process.platform !== 'win32') await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe diagnostic directory');
  }
  private async rotate(reserveBytes = 0, reserveFiles = 0, protectedReference?: string) {
    await this.verifyDirectory();
    const files = [];
    for (const entry of await fs.readdir(this.options.directory, { withFileTypes: true })) {
      const match = entry.name.match(filePattern);
      if (!match || !entry.isFile()) continue;
      const path = join(this.options.directory, entry.name);
      const createdAt = parseInt(match[1], 36);
      const size = (await fs.stat(path)).size;
      files.push({ name: entry.name, path, createdAt, size });
    }
    files.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    let total = files.reduce((sum, file) => sum + file.size, 0), count = files.length;
    for (const file of files) {
      const expired = this.now() - file.createdAt >= this.retentionMs();
      const overLimit = total + reserveBytes > this.maxBytes() || count + reserveFiles > this.maxFiles();
      if ((expired || overLimit) && file.name !== protectedReference + '.json') {
        await fs.unlink(file.path); total -= file.size; count--;
      }
    }
    if (total + reserveBytes > this.maxBytes() || count + reserveFiles > this.maxFiles()) throw new Error('Diagnostic storage limit');
  }
  private async write(record: Record) {
    const data = JSON.stringify(recordSchema.parse(record));
    const bytes = Buffer.byteLength(data);
    await this.rotate(bytes, 1, record.reference);
    const path = join(this.options.directory, record.reference + '.json');
    const temp = path + '.tmp-' + randomBytes(6).toString('hex');
    try { await fs.writeFile(temp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await fs.rename(temp, path); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async begin(userId: string, source: 'direct' | 'modal', text: string): Promise<string> {
    const now = this.now();
    const reference = `P-${now.toString(36)}-${randomBytes(6).toString('hex')}`;
    await this.enqueue(async () => {
      const limit = this.options.inputBytes ?? 16_384;
      const rawBytes = Buffer.byteLength(text);
      const captured = boundedUtf8(text, Math.min(limit + 4096, 65_536));
      const redacted = redactPasteText(captured);
      const body = boundedUtf8(redacted.text, limit);
      await this.write({ reference, createdAt: now, updatedAt: now, userId, source, result: 'received', stage: 'parse',
        rawBytes, capturedBytes: Buffer.byteLength(body), truncated: rawBytes > limit, redactions: redacted.redactions, text: body });
    });
    return reference;
  }
  async update(reference: string | undefined, patch: PastePatch): Promise<boolean> {
    if (!reference || !referencePattern.test(reference)) return false;
    return Boolean(await this.enqueue(async () => {
      await this.rotate();
      const data = recordSchema.parse(JSON.parse(await fs.readFile(join(this.options.directory, reference + '.json'), 'utf8')));
      if (this.now() - data.createdAt >= this.retentionMs()) return false;
      await this.write({ ...data, ...patchSchema.parse(patch), updatedAt: this.now() }); return true;
    }));
  }
  async prune(): Promise<void> { await this.enqueue(() => this.rotate()); }
}

function setting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
const store = new PasteDiagnosticStore({ directory: join(process.cwd(), '.data', 'paste-diagnostics'),
  retentionDays: setting('TRACKER_PASTE_DIAGNOSTICS_RETENTION_DAYS', 7, 1, 30),
  maxBytes: setting('TRACKER_PASTE_DIAGNOSTICS_MAX_BYTES', 8 * 1024 * 1024, 65_536, 64 * 1024 * 1024),
  maxFiles: setting('TRACKER_PASTE_DIAGNOSTICS_MAX_FILES', 512, 2, 4096),
  inputBytes: setting('TRACKER_PASTE_DIAGNOSTICS_INPUT_BYTES', 16_384, 1024, 32_768),
});
export const beginPasteDiagnostic = (userId: string, source: 'direct' | 'modal', text: string) => store.begin(userId, source, text);
export const updatePasteDiagnostic = (reference: string | undefined, patch: PastePatch) => store.update(reference, patch);
let maintenance: ReturnType<typeof setInterval> | null = null;
export function startPasteDiagnosticMaintenance() {
  if (maintenance) return;
  void store.prune(); maintenance = setInterval(() => { void store.prune(); }, 3_600_000); maintenance.unref();
}
export function stopPasteDiagnosticMaintenance() { if (maintenance) clearInterval(maintenance); maintenance = null; }
