/** Bounded inactive UI state. Durable records and in-flight work must not use this cache. */
export class TransientCache<K, V> extends Map<K, V> {
  private readonly expires = new Map<K, number>();
  constructor(private readonly capacity = 1_024, private readonly ttlMs = 30 * 60_000, private readonly now = Date.now) {
    super();
    if (capacity < 1 || ttlMs <= 0) throw new Error('Invalid transient cache limits.');
  }
  private prune(): void {
    for (const [key, deadline] of this.expires) if (deadline <= this.now()) this.delete(key);
  }
  override set(key: K, value: V): this {
    this.prune(); this.delete(key); super.set(key, value); this.expires.set(key, this.now() + this.ttlMs);
    while (super.size > this.capacity) this.delete(super.keys().next().value as K);
    return this;
  }
  override get(key: K): V | undefined {
    if (!this.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key); super.set(key, value); this.expires.set(key, this.now() + this.ttlMs);
    return value;
  }
  override has(key: K): boolean {
    if ((this.expires.get(key) ?? Infinity) <= this.now()) this.delete(key);
    return super.has(key);
  }
  override delete(key: K): boolean { this.expires.delete(key); return super.delete(key); }
  override clear(): void { this.expires.clear(); super.clear(); }
  override get size(): number { this.prune(); return super.size; }
  override entries() { this.prune(); return super.entries(); }
  override keys() { this.prune(); return super.keys(); }
  override values() { this.prune(); return super.values(); }
  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.prune(); super.forEach(callback, thisArg);
  }
  override [Symbol.iterator]() { return this.entries(); }
}
