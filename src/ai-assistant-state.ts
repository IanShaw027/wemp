/**
 * AI 助手开关状态管理
 * 管理每个用户的 AI 助手开启/关闭状态
 */
import * as path from "node:path";
import { getDataDir, JsonStore } from "./storage.js";
import { logInfo } from "./log.js";

// 数据存储路径
const DATA_DIR = getDataDir();
const STATE_FILE = path.join(DATA_DIR, "ai-assistant-state.json");

// 使用 JsonStore 管理存储
const stateStore = new JsonStore<Record<string, AiAssistantState>>(STATE_FILE, {});

// AI 助手状态信息
export interface AiAssistantState {
  enabled: boolean;
  enabledAt?: number;
  disabledAt?: number;
}

/**
 * 生成用户唯一标识（accountId:openId）
 */
function getUserKey(accountId: string, openId: string): string {
  return `${accountId}:${openId}`;
}

/**
 * 检查用户的 AI 助手是否开启
 * 默认为关闭状态
 */
export function isAiAssistantEnabled(accountId: string, openId: string): boolean {
  const states = stateStore.read();
  const state = states[getUserKey(accountId, openId)];
  return state?.enabled ?? false; // 默认关闭
}

/**
 * 获取用户的 AI 助手状态
 */
export function getAiAssistantState(accountId: string, openId: string): AiAssistantState | null {
  const states = stateStore.read();
  return states[getUserKey(accountId, openId)] || null;
}

/**
 * 开启 AI 助手
 */
export function enableAiAssistant(accountId: string, openId: string): void {
  const userKey = getUserKey(accountId, openId);
  stateStore.update((states) => {
    states[userKey] = {
      enabled: true,
      enabledAt: Date.now(),
    };
    return states;
  });
  logInfo(`[wemp:ai-state] 用户 ${openId.slice(0, 8)}... 开启了 AI 助手`);
}

/**
 * 关闭 AI 助手
 */
export function disableAiAssistant(accountId: string, openId: string): void {
  const userKey = getUserKey(accountId, openId);
  stateStore.update((states) => {
    states[userKey] = {
      enabled: false,
      disabledAt: Date.now(),
    };
    return states;
  });
  logInfo(`[wemp:ai-state] 用户 ${openId.slice(0, 8)}... 关闭了 AI 助手`);
}

/**
 * 切换 AI 助手状态
 * 返回切换后的状态
 */
export function toggleAiAssistant(accountId: string, openId: string): boolean {
  const isEnabled = isAiAssistantEnabled(accountId, openId);
  if (isEnabled) {
    disableAiAssistant(accountId, openId);
    return false;
  } else {
    enableAiAssistant(accountId, openId);
    return true;
  }
}
