/**
 * 配对 API 模块
 * 处理配对 API 请求（POST /wemp/api/pair）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import type { ResolvedWechatMpAccount } from "./types.js";
import { getPairingApiToken, parseSubjectId } from "./pairing.js";
import { getWechatMpRuntime } from "./runtime.js";
import { readRequestBody } from "./http.js";
import { logError } from "./log.js";

const MAX_PAIRING_API_BODY_BYTES = 32 * 1024; // 32KB (强安全)

// /api/pair 简单限流（按 remoteAddress）
const pairingApiRate = new Map<string, { count: number; resetAt: number }>();
const PAIRING_API_RATE_LIMIT = { windowMs: 60_000, max: 30 };

/**
 * 检查配对 API 速率限制
 */
function checkPairingApiRateLimit(req: IncomingMessage): { ok: true } | { ok: false; retryAfterSec: number } {
  const ip = req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  // Lazy cleanup: remove expired entries (run occasionally to avoid overhead)
  if (pairingApiRate.size > 1000) {
    for (const [key, val] of pairingApiRate) {
      if (now > val.resetAt) pairingApiRate.delete(key);
    }
  }

  const current = pairingApiRate.get(ip);
  if (!current || now > current.resetAt) {
    pairingApiRate.set(ip, { count: 1, resetAt: now + PAIRING_API_RATE_LIMIT.windowMs });
    return { ok: true };
  }

  current.count += 1;
  if (current.count > PAIRING_API_RATE_LIMIT.max) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

/**
 * 时间安全的字符串比较
 * 避免长度不匹配时的时序泄漏
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // Avoid timing leak on length mismatch by always comparing same-length buffers
  const maxLen = Math.max(ba.length, bb.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  ba.copy(paddedA);
  bb.copy(paddedB);
  return ba.length === bb.length && crypto.timingSafeEqual(paddedA, paddedB);
}

type PairingApiBody = {
  code?: string;
  token?: string;
};

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function findAccountByToken(params: {
  accounts: ResolvedWechatMpAccount[];
  token: string;
}): { account?: ResolvedWechatMpAccount; anyConfigured: boolean } {
  const token = params.token ?? "";
  let anyConfigured = false;
  for (const account of params.accounts) {
    const expectedToken = getPairingApiToken(account.accountId);
    if (!expectedToken) continue;
    anyConfigured = true;
    if (timingSafeEqualString(token, expectedToken)) {
      return { account, anyConfigured };
    }
  }
  return { account: undefined, anyConfigured };
}

/**
 * 处理配对 API 请求
 * POST /wemp/api/pair
 * Body: { code: string, token: string }
 *
 * Notes:
 * - This endpoint is optional and disabled by default (requires explicit pairingApiToken config).
 * - It approves an OpenClaw pairing code for channel "wemp" and triggers `--notify`.
 */
export async function handlePairingApi(
  req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedWechatMpAccount
): Promise<boolean> {
  return await handlePairingApiMulti(req, res, [account]);
}

/**
 * 处理配对 API 请求（多账号）
 * - 允许同一路径注册多个公众号账号时，通过 token 自动选择目标账号
 * - 单账号场景与 handlePairingApi 保持相同语义
 */
export async function handlePairingApiMulti(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: ResolvedWechatMpAccount[],
): Promise<boolean> {
  try {
    const rate = checkPairingApiRateLimit(req);
    if (!rate.ok) {
      const retryAfter = (rate as { ok: false; retryAfterSec: number }).retryAfterSec;
      res.setHeader("Retry-After", String(retryAfter));
      writeJson(res, 429, { error: "Too Many Requests" });
      return true;
    }

    let rawBody = "";
    try {
      rawBody = await readRequestBody(req, MAX_PAIRING_API_BODY_BYTES);
    } catch (err) {
      writeJson(res, String(err).includes("too large") ? 413 : 400, { error: "Bad Request" });
      return true;
    }

    let body: PairingApiBody;
    try {
      body = JSON.parse(rawBody) as any;
    } catch {
      writeJson(res, 400, { error: "Invalid JSON" });
      return true;
    }

    // 验证 token
    const resolved = body.token
      ? findAccountByToken({ accounts, token: body.token })
      : { account: undefined, anyConfigured: accounts.some((a) => Boolean(getPairingApiToken(a.accountId))) };

    if (!resolved.anyConfigured) {
      // 强安全：没有显式配置则禁用此端点
      writeJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (!body.token || !resolved.account) {
      writeJson(res, 401, { error: "Unauthorized" });
      return true;
    }

    if (!body.code) {
      writeJson(res, 400, { error: "Missing code" });
      return true;
    }

    const runtime = getWechatMpRuntime();
    const runCommandWithTimeout = (runtime as any)?.system?.runCommandWithTimeout as
      | undefined
      | ((argv: string[], opts: any) => Promise<{ stdout: string; stderr: string; code: number | null }>);

    if (typeof runCommandWithTimeout !== "function") {
      writeJson(res, 501, { error: "Pairing approval runtime not available" });
      return true;
    }

    const stripAnsi = (text: string): string =>
      String(text ?? "").replace(/\u001b\[[0-9;]*m/gu, "");

    const extractApprovedSenderId = (stdout: string, stderr: string): string | null => {
      const combined = stripAnsi(`${stdout}\n${stderr}`);
      // openclaw prints: "Approved <channel> sender <id>."
      const match = combined.match(/sender\s+([^\s.]+)\./iu);
      return match?.[1] ? String(match[1]).trim() : null;
    };

    const code = String(body.code ?? "").trim().toUpperCase();
    if (!code) {
      writeJson(res, 400, { error: "Missing code" });
      return true;
    }

    const result = await runCommandWithTimeout(
      ["openclaw", "pairing", "approve", "--channel", "wemp", code, "--notify"],
      { timeoutMs: 15_000 },
    );

    if (result?.code && result.code !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      writeJson(res, 400, {
        error: "Failed to approve pairing code",
        details: stderr || undefined,
      });
      return true;
    }

    const approvedId = extractApprovedSenderId(String(result?.stdout ?? ""), String(result?.stderr ?? ""));
    const parsed = approvedId ? parseSubjectId(approvedId) : null;
    writeJson(res, 200, {
      success: true,
      id: approvedId ?? undefined,
      accountId: parsed?.accountId ?? undefined,
      openId: parsed?.openId ?? undefined,
    });
  } catch (err) {
    logError(`[wemp] 配对 API 错误:`, err);
    writeJson(res, 500, { error: "Internal server error" });
  }

  return true;
}
