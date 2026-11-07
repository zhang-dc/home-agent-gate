const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

let minLevel: LogLevel = (process.env.GATEWAY_LOG_LEVEL as LogLevel) || "info";

function enabled(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minLevel);
}

function line(level: LogLevel, scope: string, msg: string): string {
  return `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${msg}`;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string) => enabled("debug") && console.log(line("debug", scope, msg)),
    info: (msg: string) => enabled("info") && console.log(line("info", scope, msg)),
    warn: (msg: string) => enabled("warn") && console.warn(line("warn", scope, msg)),
    error: (msg: string) => enabled("error") && console.error(line("error", scope, msg)),
  };
}

export type Logger = ReturnType<typeof createLogger>;
