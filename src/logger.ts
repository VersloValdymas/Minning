const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  if (level in LEVELS) threshold = LEVELS[level as LogLevel];
}

function write(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export type Logger = Record<LogLevel, (msg: string, extra?: unknown) => void>;

export function createLogger(scope: string): Logger {
  return {
    trace: (m, e) => write('trace', scope, m, e),
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
