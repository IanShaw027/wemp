/**
 * 运行时上下文
 */
import type { ClawdbotRuntime } from "clawdbot/plugin-sdk";

let runtime: ClawdbotRuntime | null = null;

export function setWechatMpRuntime(r: ClawdbotRuntime) {
  runtime = r;
}

export function getWechatMpRuntime(): ClawdbotRuntime | null {
  return runtime;
}
