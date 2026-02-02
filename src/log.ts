import { getWechatMpRuntime } from "./runtime.js";

type LogLevel = "info" | "warn" | "error" | "debug";

function formatArg(value: any): string {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatMessage(message: string, args: any[]): string {
  const msg = String(message ?? "");
  if (!args.length) return msg;
  const suffix = args.map((v) => formatArg(v)).join(" ");
  return suffix ? `${msg} ${suffix}` : msg;
}

function emit(level: LogLevel, runtime: any | undefined, message: string, args: any[]): void {
  const r = runtime ?? getWechatMpRuntime();
  const logger = (r as any)?.logger;
  const loggerFn = logger && typeof logger[level] === "function" ? (logger[level] as any) : null;
  if (loggerFn) {
    loggerFn.call(logger, message, ...args);
    return;
  }

  const runtimeFn =
    level === "info"
      ? ((r as any)?.log ?? (r as any)?.info)
      : level === "warn"
        ? (r as any)?.warn
        : level === "error"
          ? (r as any)?.error
          : (r as any)?.debug;
  if (typeof runtimeFn === "function") {
    runtimeFn.call(r, formatMessage(message, args));
    return;
  }

  const consoleFn =
    level === "info"
      ? console.log
      : level === "warn"
        ? console.warn
        : level === "error"
          ? console.error
          : console.debug;
  consoleFn(message, ...args);
}

function splitArgs(
  first: any,
  second: any,
  rest: any[],
): { runtime: any | undefined; message: string; args: any[] } {
  if (typeof first === "string") {
    const args = [];
    if (second !== undefined) args.push(second);
    args.push(...rest);
    return { runtime: undefined, message: first, args };
  }
  const runtime = first;
  const message = String(second ?? "");
  return { runtime, message, args: rest };
}

export function logInfo(message: string, ...args: any[]): void;
export function logInfo(runtime: any, message: string, ...args: any[]): void;
export function logInfo(a: any, b?: any, ...rest: any[]): void {
  const { runtime, message, args } = splitArgs(a, b, rest);
  emit("info", runtime, message, args);
}

export function logWarn(message: string, ...args: any[]): void;
export function logWarn(runtime: any, message: string, ...args: any[]): void;
export function logWarn(a: any, b?: any, ...rest: any[]): void {
  const { runtime, message, args } = splitArgs(a, b, rest);
  emit("warn", runtime, message, args);
}

export function logError(message: string, ...args: any[]): void;
export function logError(runtime: any, message: string, ...args: any[]): void;
export function logError(a: any, b?: any, ...rest: any[]): void {
  const { runtime, message, args } = splitArgs(a, b, rest);
  emit("error", runtime, message, args);
}

export function logDebug(message: string, ...args: any[]): void;
export function logDebug(runtime: any, message: string, ...args: any[]): void;
export function logDebug(a: any, b?: any, ...rest: any[]): void {
  const { runtime, message, args } = splitArgs(a, b, rest);
  emit("debug", runtime, message, args);
}

