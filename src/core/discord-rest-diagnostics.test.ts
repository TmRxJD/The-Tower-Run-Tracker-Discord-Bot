import { EventEmitter } from 'node:events';
import { REST, type InternalRequest, type ResponseLike } from '@discordjs/rest';
import { afterEach, expect, it, vi } from 'vitest';
import { installDiscordRestDiagnostics } from './discord-rest-diagnostics';
import { withPerformanceTrace } from './performance-trace';
const diagnostic = vi.hoisted(() => vi.fn());
vi.mock('./diagnostics', () => ({ recordDiagnostic: diagnostic }));
afterEach(() => { vi.restoreAllMocks(); diagnostic.mockClear(); });
const request = { fullRoute: '/channels/123456789012345678/messages', method: 'POST', body: { private: 'SECRET' } } as InternalRequest;
function fixture(run: (rest: REST) => Promise<unknown>, wire = vi.fn(async () => ({ status: 200 }))) {
  const rest = Object.assign(new EventEmitter(), { options: { makeRequest: wire }, request: vi.fn(async function () { return run(rest as unknown as REST); }) }) as unknown as REST;
  installDiscordRestDiagnostics(rest);
  return rest;
}
it('separates initial preparation/queue wait from bounded wire attempts and retains safe status/retry evidence', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const wire = vi.fn(async () => { now += 2300; return { status: wire.mock.calls.length === 1 ? 502 : 200 }; });
  const rest = fixture(async r => {
    now += 800;
    await r.options.makeRequest('https://discord.com/SECRET', {});
    now += 50;
    return r.options.makeRequest('https://discord.com/SECRET', {});
  }, wire);
  await withPerformanceTrace(async () => { await rest.request(request); });
  const meta = diagnostic.mock.calls[0][1];
  expect(meta).toMatchObject({ routeFamily: 'channel-message', durationMs: 5450, initialWaitMs: 800, attemptMs: 4600, unaccountedMs: 50, attemptCount: 2, attempts: [{ status: 502, durationMs: 2300 }, { status: 200, durationMs: 2300 }], failed: false });
  expect(meta.operationId).toEqual(expect.any(String));
  expect(JSON.stringify(meta)).not.toMatch(/SECRET|123456789012345678|discord.com|POST/);
});
it('preserves response/error identity, allowlists network codes and does not emit normal fast requests', async () => {
  const result = { status: 200 }; const rest = fixture(r => r.options.makeRequest('SECRET', {}), vi.fn(async () => result));
  expect(await rest.request(request)).toBe(result); expect(diagnostic).not.toHaveBeenCalled();
  const error = Object.assign(new Error('SECRET'), { code: 'ECONNRESET' });
  const failing = fixture(r => r.options.makeRequest('SECRET', {}), vi.fn(async () => { throw error; }));
  await expect(failing.request(request)).rejects.toBe(error);
  expect(diagnostic.mock.calls[0][1]).toMatchObject({ failed: true, attempts: [{ error: 'ECONNRESET' }] });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET');
});
it('keeps overlapping requests separate and bounds attempts and log volume; installation is idempotent', async () => {
  const rest = fixture(async r => {
    r.emit('rateLimited', { retryAfter: 123, url: 'SECRET', global: false, hash: 'SECRET', limit: 1, majorParameter: 'SECRET', method: 'POST', route: 'SECRET', timeToReset: 123, sublimitTimeout: 0, scope: 'shared' });
    for (let i = 0; i < 12; i++) await r.options.makeRequest('SECRET', {});
    return {};
  });
  const wrapped = rest.request; installDiscordRestDiagnostics(rest); expect(rest.request).toBe(wrapped);
  await Promise.all(Array.from({ length: 35 }, () => withPerformanceTrace(() => rest.request(request))));
  expect(diagnostic).toHaveBeenCalledTimes(30);
  const metas = diagnostic.mock.calls.map(([, meta]) => meta);
  expect(new Set(metas.map(m => m.operationId)).size).toBe(30);
  for (const meta of metas) {
    expect(meta).toMatchObject({ attemptCount: 12, attemptsTruncated: true, rateLimitEventCount: 1, retryAfterMs: 123 });
    expect(meta.attempts).toHaveLength(8);
  }
});


it('observes installed REST post retries and includes success-body parsing without network access', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const payload = { ok: true };
  const makeRequest = vi.fn(async () => {
    now += 200;
    return { status: 200, statusText: 'OK', ok: true, headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null } as ResponseLike['headers'],
      body: null, bodyUsed: false, arrayBuffer: async () => new ArrayBuffer(0), json: async () => { now += 2100; return payload; }, text: async () => '' };
  });
  const rest = new REST({ makeRequest }).setToken('TEST_ONLY_NOT_A_CREDENTIAL');
  installDiscordRestDiagnostics(rest);
  expect(await rest.post('/channels/123456789012345678/messages', { body: { content: 'SECRET' } })).toBe(payload);
  expect(makeRequest).toHaveBeenCalledTimes(1);
  expect(diagnostic.mock.calls[0][1]).toMatchObject({ durationMs: 2300, attemptMs: 200, unaccountedMs: 2100 });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET');
});
