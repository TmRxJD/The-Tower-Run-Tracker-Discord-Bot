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
  const waiting = expect(withCloudReadBudget(read)).rejects.toMatchObject({ code: 'EBUSY' });
  await vi.advanceTimersByTimeAsync(15000); await waiting; expect(read).not.toHaveBeenCalled();
});

it('queues normal bulk-import fan-out rather than reporting a false backend outage', async () => {
  vi.resetModules(); vi.useFakeTimers(); const { withCloudReadBudget } = await import('./cloud-read-budget.js');
  let active = 0; let maximum = 0;
  const work = Array.from({ length: 250 }, (_, index) => withCloudReadBudget(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20)); active--; return index;
  }));
  const results = Promise.allSettled(work);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await results).every(result => result.status === 'fulfilled')).toBe(true);
  expect(maximum).toBe(16);
  await expect(withCloudReadBudget(async () => 'healthy identity lookup')).resolves.toBe('healthy identity lookup');
});
it('cancels a queued read without running it or starving subsequent healthy work', async () => {
  vi.resetModules(); const { withCloudReadBudget } = await import('./cloud-read-budget.js');
  const finish: Array<() => void> = [];
  const active = Array.from({ length: 16 }, () => withCloudReadBudget(() => new Promise<void>(resolve => { finish.push(resolve); })));
  await vi.waitFor(() => expect(finish).toHaveLength(16));
  const controller = new AbortController(); const cancelledRead = vi.fn(async () => 'must not start');
  const rejected = expect(withCloudReadBudget(cancelledRead, 5000, controller.signal)).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const healthyRead = vi.fn(async () => 'recovered'); const queued = withCloudReadBudget(healthyRead);
  controller.abort(); await rejected; expect(cancelledRead).not.toHaveBeenCalled();
  for (const resolve of finish) resolve();
  await Promise.all(active); await expect(queued).resolves.toBe('recovered');
  expect(healthyRead).toHaveBeenCalledOnce();
});
