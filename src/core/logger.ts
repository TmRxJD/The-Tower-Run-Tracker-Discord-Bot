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

const configuredLogLevel = normalizeLogLevel(process.env.BOT_LOG_LEVEL ?? process.env.LOG_LEVEL);

function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  if (configuredLogLevel === 'silent') {
    return false;
  }

  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[configuredLogLevel];
}

function log(level: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown) {
  if (!shouldLog(level)) {
    return;
  }

  const ts = new Date().toISOString();
  const payload = meta !== undefined ? [message, meta] : [message];
  console[level === 'debug' ? 'log' : level](`[${ts}] [${level.toUpperCase()}]`, ...payload);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
