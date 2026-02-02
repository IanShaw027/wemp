/**
 * AI 助手开关状态管理
 * 管理每个用户的 AI 助手开启/关闭状态
 */
import * as fs from "node:fs";
import * as path from "node:path";

// 数据存储路径
const DATA_DIR = process.env.WEMP_DATA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "data", "wemp");
const STATE_FILE = path.join(DATA_DIR, "ai-assistant-state.json");

let cachedStates: Record<string, AiAssistantState> | null = null;

// AI 助手状态信息
export interface AiAssistantState {
  enabled: boolean;
  enabledAt?: number;
  disabledAt?: number;
}

/**
 * 确保数据目录存在
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 加载 AI 助手状态
 */
function loadStatesFromDisk(): Record<string, AiAssistantState> {
  try {
    ensureDataDir();
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Record<string, AiAssistantState>;
    }
  } catch (e) {
    console.error("[wemp:ai-state] 加载 AI 助手状态失败:", e);
  }
  return {};
}

/**
 * 保存 AI 助手状态
 */
function saveStatesToDisk(states: Record<string, AiAssistantState>): void {
  ensureDataDir();
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(states, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function getStates(): Record<string, AiAssistantState> {
  if (cachedStates) return cachedStates;
  cachedStates = loadStatesFromDisk();
  return cachedStates;
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
  const states = getStates();
  const state = states[getUserKey(accountId, openId)];
  return state?.enabled ?? false; // 默认关闭
}

/**
 * 获取用户的 AI 助手状态
 */
export function getAiAssistantState(accountId: string, openId: string): AiAssistantState | null {
  const states = getStates();
  return states[getUserKey(accountId, openId)] || null;
}

/**
 * 开启 AI 助手
 */
export function enableAiAssistant(accountId: string, openId: string): void {
  const states = getStates();
  const userKey = getUserKey(accountId, openId);
  states[userKey] = {
    enabled: true,
    enabledAt: Date.now(),
  };
  saveStatesToDisk(states);
  console.log(`[wemp:ai-state] 用户 ${openId} 开启了 AI 助手`);
}

/**
 * 关闭 AI 助手
 */
export function disableAiAssistant(accountId: string, openId: string): void {
  const states = getStates();
  const userKey = getUserKey(accountId, openId);
  states[userKey] = {
    enabled: false,
    disabledAt: Date.now(),
  };
  saveStatesToDisk(states);
  console.log(`[wemp:ai-state] 用户 ${openId} 关闭了 AI 助手`);
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
