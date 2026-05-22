type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const isProduction = process.env.NODE_ENV === 'production';
const defaultLevel: LogLevel = process.env.NODE_ENV === 'test' ? 'error' : 'info';
const minLevel =
  LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? defaultLevel] ?? LEVELS[defaultLevel];
const useJson =
  process.env.LOG_FORMAT === 'json' || (process.env.LOG_FORMAT == null && isProduction);

// ANSI colors
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // grey
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function formatTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function extractError(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) {
      out[k] = v.message;
      if (v.stack) out[`${k}Stack`] = v.stack;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function prettyFormat(
  level: LogLevel,
  tag: string | undefined,
  msg: string,
  data?: Record<string, unknown>,
): string {
  const color = COLORS[level];
  const lvl = level.toUpperCase().padEnd(5);
  const tagStr = tag ? ` ${BOLD}[${tag}]${RESET}` : '';
  const kvPairs =
    data && Object.keys(data).length > 0
      ? ' ' +
        Object.entries(data)
          .filter(([k]) => !k.endsWith('Stack'))
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
  const stackEntry = data ? Object.entries(data).find(([k]) => k.endsWith('Stack')) : undefined;
  const stackStr = stackEntry ? `\n${stackEntry[1]}` : '';
  return `${color}${formatTime()} ${lvl}${RESET}${tagStr} ${msg}${kvPairs}${stackStr}`;
}

function jsonFormat(
  level: LogLevel,
  tag: string | undefined,
  msg: string,
  data?: Record<string, unknown>,
): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    ...(tag ? { tag } : {}),
    msg,
    ...data,
  });
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  time(label: string): (extra?: Record<string, unknown>) => void;
  child(tag: string): Logger;
}

function emit(
  level: LogLevel,
  tag: string | undefined,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (LEVELS[level] < minLevel) return;
  const processed = extractError(data);
  const line = useJson
    ? jsonFormat(level, tag, msg, processed)
    : prettyFormat(level, tag, msg, processed);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function makeLogger(tag?: string): Logger {
  return {
    debug: (msg, data) => emit('debug', tag, msg, data),
    info: (msg, data) => emit('info', tag, msg, data),
    warn: (msg, data) => emit('warn', tag, msg, data),
    error: (msg, data) => emit('error', tag, msg, data),
    time(label: string) {
      const start = performance.now();
      return (extra?: Record<string, unknown>) => {
        const durationMs = Math.round(performance.now() - start);
        emit('debug', tag, label, { durationMs, ...extra });
      };
    },
    child: (childTag: string) => makeLogger(childTag),
  };
}

export function createLogger(): Logger {
  return makeLogger();
}

export const logger = createLogger();
