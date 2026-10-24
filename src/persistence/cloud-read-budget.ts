import { measurePerformanceSpan } from '../core/performance-trace';

/** Queue normal SDK fan-out instead of mistaking concurrency for an outage. Writes bypass this layer. */
const pending = new Set<Promise<unknown>>();
const waiters: Array<{ resume: () => void; reject: (error: Error) => void }> = [];
let reservations = 0;
let blockedUntil = 0;
let lastFailureAt = 0;
const cancelled = () => Object.assign(new Error('Cloud read cancelled'), { code: 'ABORT_ERR' });
const unavailable = () => Object.assign(new Error('Cloud reads temporarily unavailable'), { code: 'ETIMEDOUT' });
function drain() {
  while (waiters.length && pending.size + reservations < 16) {
    const next = waiters.shift()!;
    if (Date.now() < blockedUntil) next.reject(unavailable());
    else { reservations++; next.resume(); }
  }
}
async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled();
  if (Date.now() < blockedUntil) throw unavailable();
  if (pending.size + reservations < 16) { reservations++; return; }
  if (waiters.length >= 1024) throw Object.assign(new Error('Cloud read queue is busy'), { code: 'EBUSY' });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const entry = { resume: () => { cleanup(); resolve(); }, reject: (error: Error) => { cleanup(); reject(error); } };
    const remove = () => { const index = waiters.indexOf(entry); if (index >= 0) waiters.splice(index, 1); };
    const abort = () => { remove(); cleanup(); reject(cancelled()); drain(); };
    const timer = setTimeout(() => { remove(); cleanup(); reject(Object.assign(new Error('Cloud read capacity wait timed out'), { code: 'EBUSY' })); }, 15000);
    signal?.addEventListener('abort', abort, { once: true });
    waiters.push(entry);
  });
}
export async function withCloudReadBudget<T>(read: () => Promise<T>, timeoutMs = 5000, signal?: AbortSignal): Promise<T> {
  await measurePerformanceSpan('cloud-capacity-wait', () => acquire(signal));
  reservations--;
  if (signal?.aborted) { drain(); throw cancelled(); }
  const started = Date.now();
  const operation = Promise.resolve().then(() => { if (signal?.aborted) throw cancelled(); return measurePerformanceSpan('cloud-sdk', read); });
  pending.add(operation);
  const settled = () => { pending.delete(operation); drain(); };
  void operation.then(settled, settled);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, { once: true }); });
    const value = await Promise.race([operation, aborted, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Cloud read deadline exceeded'), { code: 'ETIMEDOUT' })), timeoutMs);
    })]);
    if (started > lastFailureAt) blockedUntil = 0;
    return value;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 0 || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_SOCKET' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      || typeof code === 'number' && (code === 408 || code === 429 || code >= 500)) {
      lastFailureAt = Date.now(); blockedUntil = lastFailureAt + 30000;
    }
    throw error;
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); drain(); }
}
