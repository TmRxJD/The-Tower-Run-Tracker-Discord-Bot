import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function linesOf(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.slice(1).join(' '));
}

async function loadLogger() {
  vi.resetModules();
  return import('./logger.js');
}

describe('logger rate limit', () => {
  let warn: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    process.env.BOT_LOG_LEVEL = 'warn';
    delete process.env.BOT_LOG_THROTTLE_PER_MINUTE;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.BOT_LOG_LEVEL;
    delete process.env.BOT_LOG_THROTTLE_PER_MINUTE;
  });

  it('passes the first 20 identical messages through and drops the rest', async () => {
    const { logger } = await loadLogger();

    for (let i = 0; i < 500; i += 1) {
      logger.warn('[authority-sync] cloud count query failed', { userId: `u${i}` });
    }

    expect(warn).toHaveBeenCalledTimes(20);
  });

  it('reports how many repeats were dropped when the window rolls over', async () => {
    const { logger } = await loadLogger();
    for (let i = 0; i < 25; i += 1) logger.warn('flood', { i });
    expect(warn).toHaveBeenCalledTimes(20);

    vi.advanceTimersByTime(61_000);
    logger.warn('flood', { i: 'next window' });

    const lines = linesOf(warn);
    expect(lines.some((line) => line.includes('suppressed 5 repeats of "flood"'))).toBe(true);
    // ...and the new window logs normally again.
    expect(lines.at(-1)).toContain('flood');
  });

  it('reports the dropped count even when the message never repeats again', async () => {
    const { logger } = await loadLogger();
    for (let i = 0; i < 30; i += 1) logger.warn('one-off flood');

    vi.advanceTimersByTime(61_000);

    const lines = linesOf(warn);
    expect(lines.some((line) => line.includes('suppressed 10 repeats of "one-off flood"'))).toBe(true);
  });

  it('limits each message separately', async () => {
    const { logger } = await loadLogger();

    for (let i = 0; i < 30; i += 1) logger.warn('noisy');
    logger.warn('rare');

    const lines = linesOf(warn);
    expect(lines.filter((line) => line.includes('noisy'))).toHaveLength(20);
    expect(lines.filter((line) => line.includes('rare'))).toHaveLength(1);
  });

  it('throttles warn and error independently', async () => {
    const { logger } = await loadLogger();

    for (let i = 0; i < 30; i += 1) logger.warn('same text');
    logger.error('same text');

    expect(warn).toHaveBeenCalledTimes(20);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('can be turned off', async () => {
    process.env.BOT_LOG_THROTTLE_PER_MINUTE = '0';
    const { logger } = await loadLogger();

    for (let i = 0; i < 100; i += 1) logger.warn('unthrottled');

    expect(warn).toHaveBeenCalledTimes(100);
  });

  it('still honours the configured level', async () => {
    process.env.BOT_LOG_LEVEL = 'error';
    const { logger } = await loadLogger();

    logger.warn('hidden');
    logger.error('shown');

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
