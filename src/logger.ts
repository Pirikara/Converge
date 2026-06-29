import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function enabled(level: LogLevel): boolean {
  return order[level] >= order[threshold];
}

export const log = {
  debug(msg: string): void {
    if (enabled("debug")) console.error(pc.dim(`[debug] ${msg}`));
  },
  info(msg: string): void {
    if (enabled("info")) console.error(`${pc.cyan("converge")} ${msg}`);
  },
  warn(msg: string): void {
    if (enabled("warn")) console.error(`${pc.yellow("warn")} ${msg}`);
  },
  error(msg: string): void {
    if (enabled("error")) console.error(`${pc.red("error")} ${msg}`);
  },
};
