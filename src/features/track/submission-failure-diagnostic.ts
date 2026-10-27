type Shape = 'missing' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'other';
const failures = new WeakMap<object, { validator: 'battle-report'; requiredFieldKinds: Record<string, Shape> }>();
/** Observes presence/types only; the shared assertion remains the sole business validator. */
export function annotateSubmissionValidation(error: unknown, canonical: Record<string, unknown>): void {
  if (!error || typeof error !== 'object') return;
  const shape = (...keys: string[]): Shape => {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(canonical, key);
      if (!descriptor || !('value' in descriptor) || descriptor.value === undefined || descriptor.value === null) continue;
      const value = descriptor.value;
      if (Array.isArray(value)) return 'array';
      const kind = typeof value;
      return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'object' ? kind : 'other';
    }
    return 'missing';
  };
  failures.set(error, { validator: 'battle-report', requiredFieldKinds: {
    tier: shape('tier', 'tierDisplay'), wave: shape('wave'), duration: shape('roundDuration', 'duration'),
    coins: shape('totalCoins', 'coins'), cells: shape('totalCells', 'cells'), dice: shape('totalDice', 'rerollShards', 'dice'),
  } });
}
export function readSubmissionValidation(error: unknown) { return error && typeof error === 'object' ? failures.get(error) : undefined; }
