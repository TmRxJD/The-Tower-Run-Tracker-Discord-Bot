import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
it('bounds a hung read, opens a circuit and admits recovery without retrying writes', async () => {
  vi.resetModules(); vi.useFakeTimers();
  const { withCloudReadBudget } = await import('./cloud-read-budget.js');
  let finish!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const failed = expect(withCloudReadBudget(read, 1000)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  await vi.advanceTimersByTimeAsync(1000); await failed;
  const second = vi.fn(async () => 'unexpected');
  await expect(withCloudReadBudget(second)).rejects.toThrow('temporarily unavailable');
  expect(second).not.toHaveBeenCalled();
  finish('late success'); await vi.advanceTimersByTimeAsync(0);
  await expect(withCloudReadBudget(second)).rejects.toThrow('temporarily unavailable');
  await vi.advanceTimersByTimeAsync(30000);
  await expect(withCloudReadBudget(async () => 'recovered')).resolves.toBe('recovered');
});
it('does not open the outage circuit for a normal missing document', async () => {
  vi.resetModules(); const { withCloudReadBudget } = await import('./cloud-read-budget.js');
  await expect(withCloudReadBudget(async () => { throw { code: 404 }; })).rejects.toMatchObject({ code: 404 });
  await expect(withCloudReadBudget(async () => 'available')).resolves.toBe('available');
});
it('caps unresolved SDK reads across circuit reopenings', async () => {
  vi.resetModules(); vi.useFakeTimers(); const { withCloudReadBudget } = await import('./cloud-read-budget.js');
  for (let wave = 0; wave < 16; wave++) {
    const rejected = expect(withCloudReadBudget(() => new Promise(() => {}), 1)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(1); await rejected; await vi.advanceTimersByTimeAsync(30000);
  }
  const read = vi.fn(async () => 'must not start');
  await expect(withCloudReadBudget(read)).rejects.toThrow('temporarily unavailable'); expect(read).not.toHaveBeenCalled();
});
