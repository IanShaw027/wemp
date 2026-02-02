/**
 * Pairing (OpenClaw-native)
 *
 * - Pairing requests + approvals are handled by OpenClaw's pairing-store (via runtime.channel.pairing.*).
 * - wemp uses OpenClaw allowFrom store as the source of truth for "paired" access.
 * - Optional local "opt-out" flag allows a user to disable paired-mode routing without requiring
 *   the owner to remove allowFrom store entries.
 */
import * as path from "node:path";
import { getDataDir, readJsonFile, writeJsonFile, withFileLock } from "./storage.js";

const DATA_DIR = getDataDir();
const OPT_OUT_FILE = path.join(DATA_DIR, "pairing-optout.json");
const OPT_OUT_LOCK_BASE = path.join(DATA_DIR, "pairing-optout");

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_ID = "wemp";

type OptOutStore = { version: 1; optOut: Record<string, true> };
const OPT_OUT_DEFAULT: OptOutStore = { version: 1, optOut: {} };

function buildSubjectId(accountId: string, openId: string): string {
  const a = String(accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
  const o = String(openId ?? "").trim();
  return `${a}:${o}`;
}

export function parseSubjectId(raw: string): { accountId: string; openId: string } {
  const value = String(raw ?? "").trim();
  const idx = value.indexOf(":");
  if (idx <= 0) {
    return { accountId: DEFAULT_ACCOUNT_ID, openId: value };
  }
  const accountId = value.slice(0, idx).trim() || DEFAULT_ACCOUNT_ID;
  const openId = value.slice(idx + 1).trim();
  return { accountId, openId };
}

function readOptOutStore(): OptOutStore {
  const parsed = readJsonFile<OptOutStore>(OPT_OUT_FILE, OPT_OUT_DEFAULT);
  if (!parsed || typeof parsed !== "object") return OPT_OUT_DEFAULT;
  const version = (parsed as any).version;
  const optOut = (parsed as any).optOut;
  if (version !== 1 || !optOut || typeof optOut !== "object" || Array.isArray(optOut)) {
    return OPT_OUT_DEFAULT;
  }
  return {
    version: 1,
    optOut: optOut as Record<string, true>,
  };
}

function writeOptOutStore(next: OptOutStore): void {
  writeJsonFile(OPT_OUT_FILE, next);
}

function isOptedOutSync(accountId: string, openId: string): boolean {
  const key = buildSubjectId(accountId, openId);
  const store = readOptOutStore();
  return store.optOut[key] === true;
}

export function setOptOut(accountId: string, openId: string, optedOut: boolean): void {
  withFileLock(OPT_OUT_LOCK_BASE, () => {
    const store = readOptOutStore();
    const key = buildSubjectId(accountId, openId);
    const next: OptOutStore = { version: 1, optOut: { ...store.optOut } };
    if (optedOut) {
      next.optOut[key] = true;
    } else {
      delete next.optOut[key];
    }
    writeOptOutStore(next);
  });
}

// Pairing API Token（强安全：默认禁用，必须显式配置）
// - 可通过环境变量 WEMP_PAIRING_API_TOKEN 设置（作为全局默认）
// - 也可通过配置文件按 accountId 覆盖（见 setPairingApiToken）
const pairingApiTokenByAccountId = new Map<string, string>();
let defaultPairingApiToken: string | undefined = process.env.WEMP_PAIRING_API_TOKEN?.trim() || undefined;

export function setPairingApiToken(accountId: string, token: string): void {
  const t = String(token || "").trim();
  if (!t) return;
  pairingApiTokenByAccountId.set(String(accountId || DEFAULT_ACCOUNT_ID), t);
}

export function getPairingApiToken(accountId: string): string | undefined {
  return pairingApiTokenByAccountId.get(String(accountId || DEFAULT_ACCOUNT_ID)) ?? defaultPairingApiToken;
}

// ---- OpenClaw allowFrom store cache (process-local) ----
type AllowFromCache = { refreshedAt: number; entries: Set<string> };
let allowFromCache: AllowFromCache | null = null;
const ALLOW_FROM_CACHE_TTL_MS = 10_000;

async function readAllowFromStore(runtime: any): Promise<Set<string>> {
  const now = Date.now();
  if (allowFromCache && now - allowFromCache.refreshedAt < ALLOW_FROM_CACHE_TTL_MS) {
    return allowFromCache.entries;
  }

  const readFn = runtime?.channel?.pairing?.readAllowFromStore;
  if (typeof readFn !== "function") {
    // If runtime doesn't support pairing store, treat as not paired.
    allowFromCache = { refreshedAt: now, entries: new Set<string>() };
    return allowFromCache.entries;
  }

  try {
    const list = await readFn(CHANNEL_ID);
    const entries = new Set<string>(
      (Array.isArray(list) ? list : []).map((v) => String(v ?? "").trim()).filter(Boolean),
    );
    allowFromCache = { refreshedAt: now, entries };
    return entries;
  } catch {
    allowFromCache = { refreshedAt: now, entries: new Set<string>() };
    return allowFromCache.entries;
  }
}

export function recordApprovedSubjectId(subjectId: string): void {
  const now = Date.now();
  const trimmed = String(subjectId ?? "").trim();
  if (!trimmed) return;
  if (!allowFromCache) {
    allowFromCache = { refreshedAt: now, entries: new Set([trimmed]) };
    return;
  }
  allowFromCache.entries.add(trimmed);
  allowFromCache.refreshedAt = now;
}

export async function isPaired(params: {
  runtime: any;
  accountId: string;
  openId: string;
}): Promise<boolean> {
  const openId = String(params.openId ?? "").trim();
  if (!openId) return false;

  if (isOptedOutSync(params.accountId, openId)) {
    return false;
  }

  const entries = await readAllowFromStore(params.runtime);
  const subjectId = buildSubjectId(params.accountId, openId);

  // Exact match only (account-scoped).
  return entries.has(subjectId);
}

export async function requestPairing(params: {
  runtime: any;
  accountId: string;
  openId: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
}): Promise<{ code: string; created: boolean }> {
  const upsert = params.runtime?.channel?.pairing?.upsertPairingRequest;
  if (typeof upsert !== "function") {
    throw new Error("OpenClaw pairing runtime not available");
  }
  const id = buildSubjectId(params.accountId, params.openId);
  const meta = params.meta ?? {};
  const result = await upsert({
    channel: CHANNEL_ID,
    id,
    meta,
  });
  const code = String(result?.code ?? "").trim();
  const created = Boolean(result?.created);
  return { code, created };
}
