type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Structured JSON logger. Callers must never pass document bytes, API keys or
 * raw model responses as fields; log only ids, stages, timings and error classes.
 */
export function createLogger(level: Level = "info", base: Record<string, unknown> = {}): Logger {
  const emit = (l: Level, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[l] < RANK[level]) return;
    const line = JSON.stringify({ level: l, time: new Date().toISOString(), msg, ...base, ...fields });
    (l === "error" || l === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}

export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};
