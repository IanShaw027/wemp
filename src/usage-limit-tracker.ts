import path from "node:path";
import { getDataDir, JsonStore } from "./storage.js";

type UsageCounters = {
  messagesIn: number;
  messagesOut: number;
  tokensIn: number;
  tokensOut: number;
  updatedAt: number;
};

type UsageStoreData = {
  version: 1;
  byDay: Record<string, Record<string, Record<string, UsageCounters>>>;
};

const DEFAULT_STORE: UsageStoreData = { version: 1, byDay: {} };

const store = new JsonStore<UsageStoreData>(
  path.join(getDataDir(), "usage-limit-stats.v1.json"),
  DEFAULT_STORE,
);

function dayKeyFromNow(now = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA");
}

function normalizeId(value: string): string {
  return (value ?? "").trim();
}

function normalizeAccountId(value: string): string {
  const trimmed = normalizeId(value);
  return trimmed ? trimmed.toLowerCase() : "default";
}

function normalizeOpenId(value: string): string {
  const trimmed = normalizeId(value);
  return trimmed ? trimmed.toLowerCase() : "unknown";
}

function ensureCounters(
  root: UsageStoreData,
  params: { dayKey: string; accountId: string; openId: string },
): UsageCounters {
  root.byDay[params.dayKey] ??= {};
  root.byDay[params.dayKey][params.accountId] ??= {};
  const existing = root.byDay[params.dayKey][params.accountId][params.openId];
  if (existing) {
    return existing;
  }
  const fresh: UsageCounters = {
    messagesIn: 0,
    messagesOut: 0,
    tokensIn: 0,
    tokensOut: 0,
    updatedAt: Date.now(),
  };
  root.byDay[params.dayKey][params.accountId][params.openId] = fresh;
  return fresh;
}

function pruneOldDays(root: UsageStoreData, keepDays = 35): void {
  const keys = Object.keys(root.byDay).sort(); // YYYY-MM-DD lexicographic order
  if (keys.length <= keepDays) {
    return;
  }
  for (const key of keys.slice(0, keys.length - keepDays)) {
    delete root.byDay[key];
  }
}

function estimateTokensFromText(text: string): number {
  const raw = (text ?? "").trim();
  if (!raw) {
    return 0;
  }
  // Remove the "[图片: ...]" helper prefix we inject for image contexts.
  const cleaned = raw.replace(/^\[图片:[^\]]+\]\s*/u, "");
  if (!cleaned) {
    return 0;
  }

  // Rough heuristic:
  // - CJK chars ~ 1 token each (often close enough).
  // - Other chars ~ 1 token per 4 chars.
  const cjkMatches = cleaned.match(/[\u4e00-\u9fff]/gu);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, cleaned.length - cjkCount);
  const approx = cjkCount + Math.ceil(nonCjkCount / 4);
  return Number.isFinite(approx) ? Math.max(0, approx) : 0;
}

export function recordUsageLimitInbound(params: {
  accountId: string;
  openId: string;
  text: string;
  messageCount?: number;
  now?: number;
}): void {
  const dayKey = dayKeyFromNow(params.now);
  const accountId = normalizeAccountId(params.accountId);
  const openId = normalizeOpenId(params.openId);
  const msgCount = typeof params.messageCount === "number" ? params.messageCount : 1;
  const tokens = estimateTokensFromText(params.text);

  store.update((root) => {
    const counters = ensureCounters(root, { dayKey, accountId, openId });
    counters.messagesIn += Math.max(0, Math.floor(msgCount));
    counters.tokensIn += tokens;
    counters.updatedAt = Date.now();
    pruneOldDays(root);
    return root;
  });
}

export function recordUsageLimitOutbound(params: {
  accountId: string;
  openId: string;
  text: string;
  messageCount?: number;
  now?: number;
}): void {
  const dayKey = dayKeyFromNow(params.now);
  const accountId = normalizeAccountId(params.accountId);
  const openId = normalizeOpenId(params.openId);
  const msgCount = typeof params.messageCount === "number" ? params.messageCount : 1;
  const tokens = estimateTokensFromText(params.text);

  store.update((root) => {
    const counters = ensureCounters(root, { dayKey, accountId, openId });
    counters.messagesOut += Math.max(0, Math.floor(msgCount));
    counters.tokensOut += tokens;
    counters.updatedAt = Date.now();
    pruneOldDays(root);
    return root;
  });
}

export function getUsageLimitToday(params: {
  accountId: string;
  openId: string;
  now?: number;
}): { dayKey: string; counters: UsageCounters } {
  const dayKey = dayKeyFromNow(params.now);
  const accountId = normalizeAccountId(params.accountId);
  const openId = normalizeOpenId(params.openId);
  const root = store.read();
  const existing = root.byDay?.[dayKey]?.[accountId]?.[openId];
  const counters: UsageCounters =
    existing ?? ({ messagesIn: 0, messagesOut: 0, tokensIn: 0, tokensOut: 0, updatedAt: 0 } as UsageCounters);
  return { dayKey, counters };
}
