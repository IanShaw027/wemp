/**
 * 微信公众号 Webhook 处理
 * 支持配对功能和双 Agent 模式（客服模式 / 个人助理模式）
 *
 * 重构说明：
 * - 图片处理逻辑已移至 image-processor.ts
 * - 菜单处理逻辑已移至 menu-handler.ts
 * - 配对 API 已移至 pairing-api.ts
 * - 消息分发逻辑已移至 message-dispatcher.ts
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedWechatMpAccount, WechatMpMessage, WechatMpChannelConfig } from "./types.js";
import { verifySignature, processWechatMessage } from "./crypto.js";
import { sendTypingStatus, sendCustomMessage, downloadImageToFile } from "./api.js";
import { isAiAssistantEnabled } from "./ai-assistant-state.js";
import { getWechatMpRuntime } from "./runtime.js";
import { readRequestBody } from "./http.js";
import { handlePairingApiMulti } from "./pairing-api.js";
import { dispatchWempMessage } from "./message-dispatcher.js";
import { handleMenuClick, handleSpecialCommand } from "./menu-handler.js";
import { logError, logInfo, logWarn } from "./log.js";
import { isOk } from "./result.js";
import { recordUsageLimitInbound } from "./usage-limit-tracker.js";
import { isSafeControlCommand } from "./commands.js";
import {
  isPaired,
  setPairingApiToken,
} from "./pairing.js";
import {
  AI_DISABLED_HINT_THROTTLE_MS,
  PENDING_IMAGE_TIMEOUT,
  MAX_WEBHOOK_BODY_BYTES,
  MESSAGE_DEDUP_TIMEOUT_MS,
} from "./constants.js";

// 存储配置引用
let storedConfig: any = null;

// Agent ID 配置（默认值，可被配置文件覆盖；按 accountId 隔离）
const DEFAULT_AGENT_PAIRED = process.env.WEMP_AGENT_PAIRED || "main";
const DEFAULT_AGENT_UNPAIRED = process.env.WEMP_AGENT_UNPAIRED || "wemp-cs";
const agentConfigByAccountId = new Map<string, { agentPaired: string; agentUnpaired: string }>();

function getAgentConfig(accountId: string): { agentPaired: string; agentUnpaired: string } {
  return (
    agentConfigByAccountId.get(accountId) ?? {
      agentPaired: DEFAULT_AGENT_PAIRED,
      agentUnpaired: DEFAULT_AGENT_UNPAIRED,
    }
  );
}

/**
 * 初始化配对配置（从配置文件读取）
 */
export function initPairingConfig(accountId: string, cfg: WechatMpChannelConfig): void {
  const current = getAgentConfig(accountId);
  agentConfigByAccountId.set(accountId, {
    agentPaired: cfg.agentPaired || current.agentPaired,
    agentUnpaired: cfg.agentUnpaired || current.agentUnpaired,
  });

  if (cfg.pairingApiToken) {
    setPairingApiToken(accountId, cfg.pairingApiToken);
  }

  const finalCfg = getAgentConfig(accountId);
  logInfo(
    `[wemp:${accountId}] 配对配置: agentPaired=${finalCfg.agentPaired}, agentUnpaired=${finalCfg.agentUnpaired}`
  );
}

/**
 * 设置配置引用
 */
export function setStoredConfig(cfg: any): void {
  storedConfig = cfg;
}

// 注册的 webhook 目标
type WebhookTarget = { account: ResolvedWechatMpAccount; cfg: any };
const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveNormalizedPath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveTargetsForPath(pathname: string): { key: string; targets: WebhookTarget[] } | null {
  const direct = webhookTargets.get(pathname);
  if (direct && direct.length > 0) return { key: pathname, targets: direct };

  // Support subpaths like /wemp/api/pair; choose the longest matching prefix.
  let bestKey = "";
  let bestTargets: WebhookTarget[] | undefined;
  for (const [key, targets] of webhookTargets.entries()) {
    if (!targets.length) continue;
    if (pathname === key || pathname.startsWith(`${key}/`)) {
      if (key.length > bestKey.length) {
        bestKey = key;
        bestTargets = targets;
      }
    }
  }
  return bestTargets ? { key: bestKey, targets: bestTargets } : null;
}

// 处理中的消息（防重复）
const processingMessages = new Set<string>();

// AI 助手关闭状态提示节流（避免刷屏）
const aiDisabledHintLastSentAt = new Map<string, number>(); // key: accountId:openId

async function maybeSendAiDisabledHint(account: ResolvedWechatMpAccount, openId: string, cfg: any): Promise<void> {
  const wempCfg = cfg?.channels?.wemp;
  const disabledHint = wempCfg?.aiDisabledHint ?? "AI 助手当前已关闭，请点击菜单「AI助手」->「开启AI助手」来开启。";
  if (!disabledHint) return;

  const key = `${account.accountId}:${openId}`;
  const now = Date.now();
  const last = aiDisabledHintLastSentAt.get(key);
  if (last && now - last < AI_DISABLED_HINT_THROTTLE_MS) return;

  // 先更新节流时间，避免并发时重复发送
  aiDisabledHintLastSentAt.set(key, now);
  await sendCustomMessage(account, openId, disabledHint);
}

// 待处理的图片（用户发送图片后等待说明）
// key: accountId:openId, value: { filePath, timestamp }
const pendingImages = new Map<string, { filePath: string; timestamp: number }>();

type InboundTextDebounceItem = {
  account: ResolvedWechatMpAccount;
  openId: string;
  text: string;
  messageId: string;
  timestamp: number;
  agentId: string;
  paired: boolean;
  cfg: any;
  runtime: any;
  imageFilePath?: string;
  forceCommandAuthorized?: boolean;
  usageLimitIgnore?: boolean;
};

const inboundDebouncersByMs = new Map<number, any>();

function resolveInboundDebounceMs(runtime: any, cfg: any): number {
  const resolveMs = runtime?.channel?.debounce?.resolveInboundDebounceMs;
  if (typeof resolveMs !== "function") return 0;
  try {
    const ms = resolveMs({ cfg, channel: "wemp" });
    return typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  } catch {
    return 0;
  }
}

function shouldDebounceInboundText(text: string, imageFilePath?: string): boolean {
  if (imageFilePath) return false;
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  // Preserve immediate handling for explicit slash commands.
  if (trimmed.startsWith("/")) return false;
  return true;
}

async function dispatchInboundTextNow(item: InboundTextDebounceItem): Promise<void> {
  await dispatchWempMessage({
    account: item.account,
    openId: item.openId,
    text: item.text,
    messageId: item.messageId,
    timestamp: item.timestamp,
    agentId: item.agentId,
    commandAuthorized: item.paired,
    forceCommandAuthorized: item.forceCommandAuthorized,
    usageLimitIgnore: item.usageLimitIgnore ?? item.paired,
    cfg: item.cfg,
    runtime: item.runtime,
    imageFilePath: item.imageFilePath,
  });
}

async function dispatchInboundTextWithOptionalDebounce(item: InboundTextDebounceItem): Promise<void> {
  const debounceMs = resolveInboundDebounceMs(item.runtime, item.cfg);
  const createDebouncer = item.runtime?.channel?.debounce?.createInboundDebouncer;

  if (!debounceMs || typeof createDebouncer !== "function" || !shouldDebounceInboundText(item.text, item.imageFilePath)) {
    await dispatchInboundTextNow(item);
    return;
  }

  let debouncer = inboundDebouncersByMs.get(debounceMs);
  if (!debouncer) {
    debouncer = createDebouncer({
      debounceMs,
      buildKey: (x: InboundTextDebounceItem) => `${x.account.accountId}:${x.openId}`,
      onFlush: async (items: InboundTextDebounceItem[]) => {
        if (!items.length) return;
        const last = items[items.length - 1];
        const combinedText = items.map((x) => String(x.text ?? "").trim()).filter(Boolean).join("\n");
        await dispatchInboundTextNow({
          ...last,
          text: combinedText || last.text,
        });
      },
      onError: (err: unknown, items: InboundTextDebounceItem[]) => {
        const last = items[items.length - 1];
        const hint = last ? `[wemp:${last.account.accountId}]` : "[wemp]";
        logWarn(`${hint} inbound debounce flush failed:`, err);
      },
    });
    inboundDebouncersByMs.set(debounceMs, debouncer);
  }

  await debouncer.enqueue(item);
}

/**
 * 注册 Webhook 目标
 */
export function registerWechatMpWebhookTarget(opts: {
  account: ResolvedWechatMpAccount;
  path: string;
  cfg: any;
}): () => void {
  const { account, cfg } = opts;
  const path = normalizeWebhookPath(opts.path);
  const list = webhookTargets.get(path) ?? [];
  const target: WebhookTarget = { account, cfg };
  webhookTargets.set(path, [...list, target]);
  logInfo(`[wemp:${account.accountId}] Webhook registered at ${path} (targets=${webhookTargets.get(path)?.length ?? 1})`);

  return () => {
    const current = webhookTargets.get(path) ?? [];
    const next = current.filter((t) => t !== target);
    if (next.length > 0) {
      webhookTargets.set(path, next);
    } else {
      webhookTargets.delete(path);
    }
    logInfo(`[wemp:${account.accountId}] Webhook unregistered from ${path} (targets=${next.length})`);
  };
}

/**
 * 从请求中解析查询参数
 */
function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

/**
 * 处理 Webhook 请求
 * 使用 (req, res) => Promise<boolean> 接口，与 Openclaw 的 HTTP handler 接口匹配
 */
export async function handleWechatMpWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const pathname = resolveNormalizedPath(req);

  logInfo(`[wemp] Received request: ${req.method} ${pathname}`);
  logInfo(`[wemp] Registered targets: ${Array.from(webhookTargets.keys()).join(", ") || "none"}`);

  const resolved = resolveTargetsForPath(pathname);
  if (!resolved) {
    logInfo(`[wemp] No matching target for ${pathname}`);
    return false;
  }

  // Prefer the most recently registered target when multiple are present (matches old Map overwrite semantics).
  const targets = resolved.targets.slice().reverse();
  return await handleRequest(req, res, targets, pathname);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targets: WebhookTarget[],
  pathname: string
): Promise<boolean> {
  const queryParams = resolveQueryParams(req);
  const query = Object.fromEntries(queryParams);

  // 配对 API 端点
  if (req.method === "POST" && pathname.endsWith("/api/pair")) {
    return await handlePairingApiMulti(
      req,
      res,
      targets.map((t) => t.account),
    );
  }

  // GET 请求 - 服务器验证
  if (req.method === "GET") {
    const { signature, timestamp, nonce, echostr } = query;

    let selected: WebhookTarget | undefined;
    for (const target of targets) {
      if (verifySignature(target.account.token, signature ?? "", timestamp ?? "", nonce ?? "")) {
        selected = target;
        break;
      }
    }

    if (!selected) {
      logWarn(`[wemp] 服务器验证失败 (path=${pathname})`);
      res.statusCode = 403;
      res.end("验证失败");
      return true;
    }

    logInfo(`[wemp:${selected.account.accountId}] 服务器验证成功`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(echostr ?? "");
    return true;
  }

  // POST 请求 - 接收消息
  if (req.method === "POST") {
    let rawBody = "";
    try {
      rawBody = await readRequestBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      const accountHint = targets[0]?.account?.accountId ? `:${targets[0].account.accountId}` : "";
      logWarn(`[wemp${accountHint}] 读取请求体失败: ${err}`);
      res.statusCode = String(err).includes("too large") ? 413 : 400;
      res.end("Bad Request");
      return true;
    }

    let selected: WebhookTarget | undefined;
    let parsed: ReturnType<typeof processWechatMessage> | undefined;
    for (const target of targets) {
      const attempt = processWechatMessage(target.account, rawBody, query);
      if (isOk(attempt)) {
        selected = target;
        parsed = attempt;
        break;
      }
    }

    if (!selected || !parsed || !isOk(parsed)) {
      // Use the first target (after reverse) for logging only
      const hint = targets[0]?.account?.accountId ? `account=${targets[0].account.accountId}` : "account=unknown";
      const errorText = (parsed && !isOk(parsed)) ? parsed.error : "验证失败或消息解析失败";
      logWarn(`[wemp] ${hint} ${errorText}`);
      res.statusCode = String(errorText).includes("验证失败") ? 403 : 400;
      res.end(String(errorText));
      return true;
    }

    const account = selected.account;
    const cfg = selected.cfg;
    const msg = parsed.data;
    logInfo(`[wemp:${account.accountId}] 收到消息: type=${msg.msgType}, from=${msg.fromUserName}`);

    // 立即返回 success，避免微信超时
    res.statusCode = 200;
    res.end("success");

    // 异步处理消息
    setImmediate(() => {
      handleMessage(account, msg, cfg).catch((err) => {
        logError(`[wemp:${account.accountId}] 处理消息失败:`, err);
      });
    });

    return true;
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
  return true;
}

/**
 * 处理微信消息
 */
async function handleMessage(
  account: ResolvedWechatMpAccount,
  msg: WechatMpMessage,
  cfg: any
): Promise<void> {
  const runtime = getWechatMpRuntime();
  if (!runtime) {
    logError(`[wemp:${account.accountId}] Runtime not available`);
    return;
  }

  const openId = msg.fromUserName;
  const msgKey = `${account.accountId}:${openId}:${msg.msgId || msg.createTime}`;

  // 防重复处理
  if (processingMessages.has(msgKey)) {
    logInfo(runtime, `[wemp:${account.accountId}] 跳过重复消息: ${msgKey}`);
    return;
  }
  processingMessages.add(msgKey);
  setTimeout(() => processingMessages.delete(msgKey), MESSAGE_DEDUP_TIMEOUT_MS);

  // 处理事件
  if (msg.msgType === "event") {
    await handleEvent(account, msg, runtime, cfg);
    return;
  }

  // 处理文本消息
  if (msg.msgType === "text" && msg.content) {
    const trimmed = msg.content.trim();

    // === 特殊命令处理 ===
    const commandResult = await handleSpecialCommand(account, openId, trimmed, {
      runtime,
      cfg: storedConfig || cfg,
      agentConfigByAccountId: agentConfigByAccountId,
    });
    if (commandResult) {
      return; // 命令已处理
    }

    // === 检查 AI 助手是否开启 ===
    const aiEnabled = isAiAssistantEnabled(account.accountId, openId);
    if (!aiEnabled) {
      // AI 助手关闭状态，不处理消息
      logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 的 AI 助手已关闭，跳过消息处理`);
      await maybeSendAiDisabledHint(account, openId, cfg);
      return;
    }

    // === 正常对话 ===
    // 发送正在输入状态
    sendTypingStatus(account, openId).catch(() => {});

    // 根据配对状态选择 agent
    const paired = await isPaired({ runtime, accountId: account.accountId, openId });
    const agentCfg = getAgentConfig(account.accountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
    logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 使用 agent: ${agentId} (${paired ? "已配对" : "未配对"})`);

    const safeCommand = isSafeControlCommand(trimmed);
    const usageLimitIgnore = paired || safeCommand;
    const forceCommandAuthorized = paired || safeCommand;

    // 配对用户视为"管理者"，不纳入 usageLimit 统计/限制；安全控制命令也不计入额度
    if (!paired && !safeCommand) {
      recordUsageLimitInbound({
        accountId: account.accountId,
        openId,
        text: trimmed,
        messageCount: 1,
        now: parseInt(msg.createTime) * 1000 || Date.now(),
      });
    }

    // 检查是否有待处理的图片
    const pendingKey = `${account.accountId}:${openId}`;
    const pendingImage = pendingImages.get(pendingKey);
    let imageFilePath: string | undefined;

    if (pendingImage) {
      // 检查图片是否过期
      if (Date.now() - pendingImage.timestamp < PENDING_IMAGE_TIMEOUT) {
        imageFilePath = pendingImage.filePath;
        logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 有待处理图片: ${imageFilePath}`);
      }
      // 无论是否过期，都清除待处理图片
      pendingImages.delete(pendingKey);
    }

    // 使用 wemp 的消息分发器（内部走 OpenClaw reply dispatcher）处理消息
    await dispatchInboundTextWithOptionalDebounce({
      account,
      openId,
      text: msg.content,
      messageId: msg.msgId ?? `${msg.createTime}`,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      agentId,
      paired,
      forceCommandAuthorized,
      usageLimitIgnore,
      cfg: storedConfig || cfg,
      runtime,
      imageFilePath,
    });
    return;
  }

  // 处理图片消息
  if (msg.msgType === "image" && msg.picUrl) {
    // 检查 AI 助手是否开启
    const aiEnabled = isAiAssistantEnabled(account.accountId, openId);
    if (!aiEnabled) {
      logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 的 AI 助手已关闭，跳过图片处理`);
      await maybeSendAiDisabledHint(account, openId, cfg);
      return;
    }

    // 下载图片到本地文件（避免 base64 数据过大导致上下文溢出）
    const downloadResult = await downloadImageToFile(msg.picUrl);
    if (!downloadResult.success) {
      logError(runtime, `[wemp:${account.accountId}] 下载图片失败: ${downloadResult.error}`);
      await sendCustomMessage(account, openId, "抱歉，图片下载失败，请重新发送。");
      return;
    }

    // 保存图片文件路径，等待用户发送说明
    const pendingKey = `${account.accountId}:${openId}`;
    pendingImages.set(pendingKey, {
      filePath: downloadResult.data,
      timestamp: Date.now(),
    });

    // 提示用户说明图片用途
    await sendCustomMessage(
      account,
      openId,
      "收到图片，请问你想让我做什么？\n\n" +
        "例如：\n" +
        "- 识别图片内容\n" +
        "- 翻译图片中的文字\n" +
        "- 提取图片中的信息\n\n" +
        "请发送文字说明你的需求（5 分钟内有效）。"
    );
    return;
  }

  // 处理语音消息
  if (msg.msgType === "voice" && msg.recognition) {
    // 检查 AI 助手是否开启
    const aiEnabled = isAiAssistantEnabled(account.accountId, openId);
    if (!aiEnabled) {
      logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 的 AI 助手已关闭，跳过语音处理`);
      await maybeSendAiDisabledHint(account, openId, cfg);
      return;
    }

    sendTypingStatus(account, openId).catch(() => {});

    const paired = await isPaired({ runtime, accountId: account.accountId, openId });
    const agentCfg = getAgentConfig(account.accountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
    logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId} 发送语音(识别), 使用 agent: ${agentId} (${paired ? "已配对" : "未配对"})`);

    const safeCommand = isSafeControlCommand(msg.recognition);
    const usageLimitIgnore = paired || safeCommand;
    const forceCommandAuthorized = paired || safeCommand;

    if (!paired && !safeCommand) {
      recordUsageLimitInbound({
        accountId: account.accountId,
        openId,
        text: msg.recognition,
        messageCount: 1,
        now: parseInt(msg.createTime) * 1000 || Date.now(),
      });
    }

    await dispatchInboundTextWithOptionalDebounce({
      account,
      openId,
      text: msg.recognition,
      messageId: msg.msgId ?? `${msg.createTime}`,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      agentId,
      paired,
      forceCommandAuthorized,
      usageLimitIgnore,
      cfg: storedConfig || cfg,
      runtime,
    });
    return;
  }

  // 暂不支持的消息类型
  if (msg.msgType === "voice" || msg.msgType === "video") {
    logInfo(runtime, `[wemp:${account.accountId}] 暂不支持的消息类型: ${msg.msgType}`);
  }
}

/**
 * 处理事件
 */
async function handleEvent(
  account: ResolvedWechatMpAccount,
  msg: WechatMpMessage,
  runtime: any,
  cfg: any
): Promise<void> {
  const openId = msg.fromUserName;

  switch (msg.event) {
    case "subscribe":
      logInfo(runtime, `[wemp:${account.accountId}] 用户关注: ${openId}`);
      // 发送欢迎消息（支持配置自定义）
      const wempCfg = cfg?.channels?.wemp;
      const defaultWelcomeMsg =
        "欢迎关注！我是 AI 助手 🌊\n\n" +
        "💡 小提示：\n" +
        "• 点击底部菜单「AI助手」->「开启AI助手」开始使用\n" +
        "• 发送「配对」绑定账号，解锁完整功能\n" +
        "• 发送「状态」查看当前模式";
      const welcomeMsg = wempCfg?.welcomeMessage ?? defaultWelcomeMsg;
      await sendCustomMessage(account, openId, welcomeMsg);
      break;

    case "unsubscribe":
      logInfo(runtime, `[wemp:${account.accountId}] 用户取消关注: ${openId}`);
      break;

    case "CLICK":
      // 处理菜单点击事件
      logInfo(runtime, `[wemp:${account.accountId}] 菜单点击: ${msg.eventKey}, from=${openId}`);
      await handleMenuClick(account, openId, msg.eventKey || "", runtime, cfg, agentConfigByAccountId);
      break;

    default:
      logInfo(runtime, `[wemp:${account.accountId}] 未处理的事件: ${msg.event}`);
  }
}
