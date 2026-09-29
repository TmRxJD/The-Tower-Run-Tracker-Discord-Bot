/**
 * Lets pending I/O callbacks (gateway packets, interaction ACKs) run before continuing.
 *
 * Awaiting an already-settled promise only yields to the microtask queue, which never
 * services I/O: a loop of `await`s over synchronous storage work still starves every other
 * user until it finishes. `setImmediate` runs after the poll phase, so queued events get a turn.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs `worker` over `items` in slices of `chunkSize`, yielding to the event loop between
 * slices so a long synchronous-heavy job cannot hold the loop for its whole duration.
 */
export async function forEachChunkYielding<T>(
  items: readonly T[],
  chunkSize: number,
  worker: (chunk: T[], startIndex: number) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.floor(chunkSize));
  for (let start = 0; start < items.length; start += size) {
    if (start > 0) {
      await yieldToEventLoop();
    }
    await worker(items.slice(start, start + size), start);
  }
}
