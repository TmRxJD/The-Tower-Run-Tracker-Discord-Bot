import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
vi.mock('../../core/logger', () => ({ logger: { warn: vi.fn() } }));
import { logger } from '../../core/logger';
import { PasteDiagnosticStore, redactPasteText, startPasteDiagnosticMaintenance, stopPasteDiagnosticMaintenance } from './paste-diagnostics';
import { historyFailureError, readHistoryFailure } from './history-failure-diagnostic';
let directory: string;
let now: number;
beforeEach(async () => { vi.clearAllMocks(); now = 1_790_945_000_000; directory = await fs.mkdtemp(join(tmpdir(), 'tracker-paste-test-')); });
afterEach(async () => {
  stopPasteDiagnosticMaintenance(); vi.useRealTimers(); vi.restoreAllMocks();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path');
  await fs.rm(directory, { recursive: true, force: true });
});
const read = async (id: string) => JSON.parse(await fs.readFile(join(directory, id + '.json'), 'utf8'));
const store = (options: { retentionDays?: number; maxBytes?: number; maxFiles?: number; inputBytes?: number } = {}) => new PasteDiagnosticStore({ directory, now: () => now, ...options });
describe('local paste diagnostics', () => {
  it('persists strictly allowlisted history metadata and rejects injected diagnostic content', async () => {
    const diagnostics = store(); const id = await diagnostics.begin('fixture-user', 'direct', 'synthetic report');
    const historyFailure = readHistoryFailure(historyFailureError('PRIVATE_EXCEPTION', 'schema', 'extended_page'));
    expect(await diagnostics.update(id, { result: 'failed', stage: 'history', historyFailure })).toBe(true);
    expect((await read(id)).historyFailure).toEqual(historyFailure);
    expect(await diagnostics.update(id, { historyFailure: { ...historyFailure, message: 'PRIVATE_INJECTED_BODY' } } as never)).toBe(false);
    expect(JSON.stringify(await read(id))).not.toContain('PRIVATE_EXCEPTION');
    expect(JSON.stringify(await read(id))).not.toContain('PRIVATE_INJECTED_BODY');
  });
  it('redacts recognizable credentials before disk and retains successful/rejected outcome metadata', async () => {
    const fakeToken = 'A'.repeat(24) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(27);
    const text = `Battle Report\napi_key=synthetic-key\nAuthorization: Bearer ${'D'.repeat(24)}\npassword="synthetic phrase"\n${fakeToken}\nsk-proj-${'E'.repeat(24)}\n-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----`;
    const diagnostics = store(); const id = await diagnostics.begin('fixture-user', 'direct', text);
    const saved = await read(id);
    for (const value of ['synthetic-key', 'synthetic phrase', fakeToken, 'D'.repeat(24), 'E'.repeat(24), 'synthetic-private-key']) expect(saved.text).not.toContain(value);
    expect(saved.redactions).toBeGreaterThanOrEqual(6); expect(saved.text).toContain('Battle Report');
    expect(saved.result).toBe('received');
    expect(await diagnostics.update(id, { result: 'parsed', stage: 'parse' })).toBe(true);
    expect(await diagnostics.update(id, { result: 'saved', stage: 'submit', localId: 'fixture-local' })).toBe(true);
    expect(await read(id)).toMatchObject({ result: 'saved', stage: 'submit', localId: 'fixture-local', createdAt: now });
    const rejected = await diagnostics.begin('fixture-user', 'modal', 'synthetic incomplete report');
    await diagnostics.update(rejected, { result: 'rejected', stage: 'parse', errorCode: 'unrecognized_report' });
    expect(await read(rejected)).toMatchObject({ source: 'modal', result: 'rejected', errorCode: 'unrecognized_report' });
  });
  it('handles oversized Unicode safely and redacts a credential crossing the capture boundary', async () => {
    const diagnostics = store(); const text = '🔧'.repeat(20_000);
    const id = await diagnostics.begin('fixture-user', 'direct', text); const value = await read(id);
    expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(16_384);
    expect(value.text).not.toContain('�'); expect(value.truncated).toBe(true); expect(value.rawBytes).toBe(80_000);
    const credential = 'synthetic-boundary-key'.repeat(8);
    const boundary = 'x'.repeat(16_375) + '\napi_key=' + credential;
    const second = await diagnostics.begin('fixture-user', 'direct', boundary);
    const captured = await read(second);
    expect(captured.text).not.toContain('synthetic-boundary-key'); expect(captured.redactions).toBe(1);
    expect(Buffer.byteLength(captured.text)).toBeLessThanOrEqual(16_384);
  });
  it('expires from original creation time and touches only its own recognized files', async () => {
    const diagnostics = store(); const id = await diagnostics.begin('fixture-user', 'direct', 'synthetic report');
    await fs.writeFile(join(directory, 'unrelated.json'), 'keep');
    const ownedLookingDirectory = join(directory, `P-${now.toString(36)}-aaaaaaaaaaaa.json`);
    await fs.mkdir(ownedLookingDirectory); await fs.writeFile(join(ownedLookingDirectory, 'keep'), 'keep');
    now += 6 * 86_400_000; await diagnostics.update(id, { result: 'review_ready', stage: 'review' });
    now += 86_400_000; await diagnostics.prune();
    await expect(fs.access(join(directory, id + '.json'))).rejects.toThrow();
    expect(await diagnostics.update(id, { result: 'saved' })).toBe(false);
    expect(await fs.readFile(join(directory, 'unrelated.json'), 'utf8')).toBe('keep');
    expect(await fs.readFile(join(ownedLookingDirectory, 'keep'), 'utf8')).toBe('keep');
  });
  it('rotation bounds bytes and file count and removes stale own temporary files', async () => {
    const diagnostics = store({ maxBytes: 1600, maxFiles: 3 });
    let last = '';
    for (let i = 0; i < 8; i++) { last = await diagnostics.begin('fixture-user', 'direct', 'synthetic'.repeat(20)); now++; }
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
    expect(names.length).toBeLessThanOrEqual(3);
    const sizes = await Promise.all(names.map(async name => (await fs.stat(join(directory, name))).size));
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1600);
    expect(await read(last)).toMatchObject({ result: 'received' });
    const old = `P-${(now - 8 * 86_400_000).toString(36)}-bbbbbbbbbbbb.json.tmp-cccccccccccc`;
    await fs.writeFile(join(directory, old), 'synthetic abandoned temp'); await diagnostics.prune();
    await expect(fs.access(join(directory, old))).rejects.toThrow();
  });
  it('does not follow directory junctions or allow reference path traversal', async () => {
    const external = await fs.mkdtemp(join(tmpdir(), 'tracker-paste-external-'));
    if (!resolve(external).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path');
    try {
      await fs.writeFile(join(external, 'keep'), 'synthetic external data');
      await fs.symlink(external, join(directory, `P-${(now - 8 * 86_400_000).toString(36)}-dddddddddddd.json`), 'junction');
      const diagnostics = store(); await diagnostics.prune();
      expect(await diagnostics.update('../outside', { result: 'saved' })).toBe(false);
      expect(await fs.readFile(join(external, 'keep'), 'utf8')).toBe('synthetic external data');
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });
  it('I/O failures never throw, never fabricate a saved record, and never log bodies', async () => {
    const invalid = join(directory, 'not-a-directory'); await fs.writeFile(invalid, 'synthetic');
    const diagnostics = new PasteDiagnosticStore({ directory: invalid, now: () => now });
    const secret = 'synthetic-private-input'; const id = await diagnostics.begin('fixture-user', 'direct', secret);
    expect(await diagnostics.update(id, { result: 'saved' })).toBe(false); await diagnostics.prune();
    expect(logger.warn).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret);
    const failing = store(); vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error(secret));
    const failed = await failing.begin('fixture-user', 'direct', secret);
    await expect(fs.access(join(directory, failed + '.json'))).rejects.toThrow();
    expect((await fs.readdir(directory)).some(name => name.includes('.tmp-'))).toBe(false);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret);
  });
  it('serializes concurrent record updates and keeps the original body unchanged', async () => {
    const diagnostics = store(); const id = await diagnostics.begin('fixture-user', 'direct', 'synthetic report');
    await Promise.all([diagnostics.update(id, { result: 'parsed' }), diagnostics.update(id, { result: 'saved', stage: 'submit' })]);
    expect(await read(id)).toMatchObject({ result: 'saved', text: 'synthetic report' });
  });
  it('runs cleanup at startup and hourly, stops cleanly, and has no model/network path', async () => {
    vi.useFakeTimers(); const prune = vi.spyOn(PasteDiagnosticStore.prototype, 'prune').mockResolvedValue();
    startPasteDiagnosticMaintenance(); startPasteDiagnosticMaintenance(); expect(prune).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_600_000); expect(prune).toHaveBeenCalledTimes(2);
    stopPasteDiagnosticMaintenance(); await vi.advanceTimersByTimeAsync(3_600_000); expect(prune).toHaveBeenCalledTimes(2);
  });
});
it('redacts JSON labels, query secrets and unterminated private-key blocks', () => {
  const input = '{"token":"synthetic-token","client_secret":"synthetic-client"} https://example.invalid/?api_key=synthetic-query&ok=1\n-----BEGIN RSA PRIVATE KEY-----\nsynthetic-key';
  const redacted = redactPasteText(input).text;
  for (const part of ['synthetic-token', 'synthetic-client', 'synthetic-query', 'synthetic-key']) expect(redacted).not.toContain(part);
});
