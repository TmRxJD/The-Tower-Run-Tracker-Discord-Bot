export type LogLevel = 'silent' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function normalizeLogLevel(value?: string): LogLevel {
  switch (value?.toLowerCase()) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'silent':
      return value.toLowerCase() as LogLevel;
    default:
      return process.env.NODE_ENV === 'development' ? 'info' : 'warn';
  }
}

const configuredLogLevel = normalizeLogLevel(process.env.BOT_LOG_LEVEL);

function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  if (configuredLogLevel === 'silent') {
    return false;
  }

  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[configuredLogLevel];
}

/**
 * Per-message rate limit. An outage makes the same warning repeat for every user with a
 * full stack trace each time: one incident wrote 15.7M lines (1.1 GB) to the pm2 error log,
 * and synchronous console writes are not free on the event loop. Identical messages past
 * the limit are dropped and reported once per window as a count.
 */
const THROTTLE_WINDOW_MS = 60_000;
const DEFAULT_THROTTLE_MAX_PER_WINDOW = 20;
const MAX_THROTTLE_KEYS = 500;

function resolveThrottleLimit(): number {
  const configured = Number(process.env.BOT_LOG_THROTTLE_PER_MINUTE);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_THROTTLE_MAX_PER_WINDOW;
}

interface ThrottleBucket {
  level: Exclude<LogLevel, 'silent'>;
  message: string;
  windowStart: number;
  count: number;
  suppressed: number;
}

const throttleBuckets = new Map<string, ThrottleBucket>();
let throttleSweep: ReturnType<typeof setInterval> | null = null;

function write(level: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const payload = meta !== undefined ? [message, meta] : [message];
  console[level === 'debug' ? 'log' : level](`[${ts}] [${level.toUpperCase()}]`, ...payload);
}

function reportSuppressed(bucket: ThrottleBucket) {
  if (bucket.suppressed > 0) {
    write(bucket.level, `[logger] suppressed ${bucket.suppressed} repeats of "${bucket.message}" in the last ${Math.round(THROTTLE_WINDOW_MS / 1000)}s`);
    bucket.suppressed = 0;
  }
}

function ensureThrottleSweep() {
  if (throttleSweep) return;
  // Reports suppressed counts for messages that stop repeating, so they are not lost.
  throttleSweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of throttleBuckets) {
      if (now - bucket.windowStart >= THROTTLE_WINDOW_MS) {
        reportSuppressed(bucket);
        throttleBuckets.delete(key);
      }
    }
  }, THROTTLE_WINDOW_MS);
  throttleSweep.unref?.();
}

function admit(level: Exclude<LogLevel, 'silent'>, message: string): boolean {
  const limit = resolveThrottleLimit();
  if (limit === 0) {
    return true;
  }

  const now = Date.now();
  const key = `${level}:${message}`;
  let bucket = throttleBuckets.get(key);

  if (bucket && now - bucket.windowStart >= THROTTLE_WINDOW_MS) {
    reportSuppressed(bucket);
    throttleBuckets.delete(key);
    bucket = undefined;
  }

  if (!bucket) {
    if (throttleBuckets.size >= MAX_THROTTLE_KEYS) {
      // Messages that embed ids would otherwise grow this without bound.
      throttleBuckets.clear();
    }
    bucket = { level, message, windowStart: now, count: 0, suppressed: 0 };
    throttleBuckets.set(key, bucket);
    ensureThrottleSweep();
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    bucket.suppressed += 1;
    return false;
  }
  return true;
}

function log(level: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown) {
  if (!shouldLog(level) || !admit(level, message)) {
    return;
  }

  write(level, message, meta);
}

/** Test hook: forgets all rate-limit state. */
export function resetLoggerThrottle(): void {
  throttleBuckets.clear();
  if (throttleSweep) {
    clearInterval(throttleSweep);
    throttleSweep = null;
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
