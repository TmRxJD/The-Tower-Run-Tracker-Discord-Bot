import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { REST } from '@discordjs/rest';
import { recordDiagnostic } from './diagnostics';
import { performanceDiagnosticContext } from './performance-trace';

const MAX_ATTEMPTS = 8;
const MAX_REPORTS_PER_MINUTE = 30;
const installed = new WeakSet<REST>();
const safeErrors = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'AbortError']);
function errorCategory(error: unknown): string {
  if (!error || typeof error !== 'object') return 'other';
  const { code, name } = error as { code?: unknown; name?: unknown };
  return typeof code === 'string' && safeErrors.has(code) ? code : typeof name === 'string' && safeErrors.has(name) ? name : 'other';
}
function routeFamily(route: string): string {
  if (/^\/channels\/\d+\/messages(?:\/\d+)?$/.test(route)) return 'channel-message';
  if (/^\/interactions\/[^/]+\/[^/]+\/callback$/.test(route)) return 'interaction-callback';
  if (/^\/webhooks\//.test(route)) return 'webhook';
  return 'other';
}
type Attempt = { durationMs: number; status?: number; error?: string };
type RequestTrace = { started: number; firstAttemptAt?: number; attemptCount: number; attemptMs: number; attempts: Attempt[]; rateLimitCount: number; globalRateLimitCount: number; sublimitTimeoutMs: number; retryAfterMs: number };

/** Read-only instrumentation. Never subscribe to restDebug or retain URLs, payloads or headers.
 * initialWaitMs includes request preparation and bucket/global queueing, not just queue wait.
 * attemptMs ends at response headers: body handling/backoff are in unaccountedMs.
 */
export function installDiscordRestDiagnostics(rest: REST): void {
  if (installed.has(rest)) return;
  installed.add(rest);
  const requests = new AsyncLocalStorage<RequestTrace>();
  const requestCall = rest.request;
  const makeRequest = rest.options.makeRequest;
  let windowStart = performance.now();
  let reports = 0;
  let suppressed = 0;
  const report = (meta: Record<string, unknown>) => {
    const now = performance.now();
    if (now - windowStart >= 60_000) { windowStart = now; reports = 0; }
    if (reports >= MAX_REPORTS_PER_MINUTE) { suppressed++; return; }
    reports++;
    recordDiagnostic('discord.rest.request', { ...meta, suppressedReports: suppressed });
    suppressed = 0;
  };
  rest.options.makeRequest = async function (...args) {
    const trace = requests.getStore();
    if (!trace) return makeRequest.apply(this, args);
    const started = performance.now();
    trace.firstAttemptAt ??= started;
    trace.attemptCount++;
    const attempt: Attempt = { durationMs: 0 };
    try {
      const response = await makeRequest.apply(this, args);
      attempt.status = response.status;
      return response;
    } catch (error) {
      attempt.error = errorCategory(error);
      throw error;
    } finally {
      const elapsed = performance.now() - started;
      trace.attemptMs += elapsed;
      attempt.durationMs = Math.round(elapsed);
      if (trace.attempts.length < MAX_ATTEMPTS) trace.attempts.push(attempt);
    }
  };
  rest.on('rateLimited', info => {
    const trace = requests.getStore();
    if (!trace) return;
    trace.rateLimitCount++;
    if (info.global) trace.globalRateLimitCount++;
    if (Number.isFinite(info.sublimitTimeout)) trace.sublimitTimeoutMs = Math.max(trace.sublimitTimeoutMs, info.sublimitTimeout);
    if (Number.isFinite(info.retryAfter)) trace.retryAfterMs = Math.max(trace.retryAfterMs, info.retryAfter);
  });
  rest.request = async function (request) {
    const trace: RequestTrace = { started: performance.now(), attemptCount: 0, attemptMs: 0, attempts: [], rateLimitCount: 0, globalRateLimitCount: 0, sublimitTimeoutMs: 0, retryAfterMs: 0 };
    const identity = performanceDiagnosticContext();
    const family = routeFamily(request.fullRoute);
    let failed = false;
    return requests.run(trace, async () => {
      try { return await requestCall.call(this, request); }
      catch (error) { failed = true; throw error; }
      finally {
        const duration = performance.now() - trace.started;
        if (duration >= 1500 || failed || trace.attemptCount > 1 || trace.rateLimitCount) {
          const initialWait = (trace.firstAttemptAt ?? performance.now()) - trace.started;
          report({ ...identity, requestRef: randomUUID(), routeFamily: family,
            durationMs: Math.round(duration), initialWaitMs: Math.round(initialWait),
            attemptMs: Math.round(trace.attemptMs), unaccountedMs: Math.round(Math.max(0, duration - initialWait - trace.attemptMs)),
            attemptCount: trace.attemptCount, attempts: trace.attempts, attemptsTruncated: trace.attemptCount > MAX_ATTEMPTS,
            rateLimitEventCount: trace.rateLimitCount, globalRateLimitEventCount: trace.globalRateLimitCount, sublimitTimeoutMs: Math.round(trace.sublimitTimeoutMs), retryAfterMs: Math.round(trace.retryAfterMs), failed });
        }
      }
    });
  };
}
