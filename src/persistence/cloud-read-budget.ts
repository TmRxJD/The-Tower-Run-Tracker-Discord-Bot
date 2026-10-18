/** Bound cloud reads; never timeout/retry an uncertain write in this layer. */
const pending = new Set<Promise<unknown>>();
let blockedUntil = 0;
let lastFailureAt = 0;
export async function withCloudReadBudget<T>(read: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  if (Date.now() < blockedUntil || pending.size >= 16) throw Object.assign(new Error('Cloud reads temporarily unavailable'), { code: 'ETIMEDOUT' });
  const started = Date.now();
  const operation = Promise.resolve().then(read);
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Cloud read deadline exceeded'), { code: 'ETIMEDOUT' })), timeoutMs);
    })]);
    if (started > lastFailureAt) blockedUntil = 0;
    return value;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (!(typeof code === 'number' && code >= 400 && code < 500 && code !== 429)) {
      lastFailureAt = Date.now(); blockedUntil = lastFailureAt + 30000;
    }
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
