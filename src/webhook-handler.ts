/**
 * 微信公众号 Webhook 处理
 * 支持配对功能和双 Agent 模式（客服模式 / 个人助理模式）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import type { ResolvedWechatMpAccount, WechatMpMessage, WechatMpChannelConfig } from "./types.js";
import { verifySignature, processWechatMessage } from "./crypto.js";
import { sendTypingStatus, sendCustomMessage, sendImageByUrl, downloadImageToFile } from "./api.js";
import { getWechatMpRuntime } from "./runtime.js";

// 匹配文本中的图片 URL（支持 markdown 格式和纯 URL）
const IMAGE_URL_PATTERNS = [
  /!\[.*?\]\((https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s)]*)?)\)/gi, // ![alt](http url)
  /(?<!\()(https?:\/\/[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s<>"']*)?)(?!\))/gi, // 纯 http URL
];

// 匹配 data URL 格式的图片
const DATA_URL_PATTERNS = [
  /!\[.*?\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/gi, // ![alt](data:image/...;base64,...)
  /(?<!\()(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)(?!\))/gi, // 纯 data URL
];

// 已知的图片服务域名（这些服务的 URL 可能没有扩展名）
const KNOWN_IMAGE_HOSTS = [
  "picsum.photos",
  "unsplash.com",
  "images.unsplash.com",
  "source.unsplash.com",
  "placekitten.com",
  "placehold.co",
  "placeholder.com",
];

/**
 * 从文本中提取图片 URL（包括 http URL 和 data URL）
 */
function extractImageUrls(text: string): { httpUrls: string[]; dataUrls: string[] } {
  const httpUrls = new Set<string>();
  const dataUrls = new Set<string>();

  // 1. 匹配 data URL 格式的图片
  for (const pattern of DATA_URL_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url) dataUrls.add(url);
    }
  }

  // 2. 匹配带扩展名的 HTTP 图片 URL
  for (const pattern of IMAGE_URL_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url) httpUrls.add(url);
    }
  }

  // 3. 匹配已知图片服务的 URL（可能没有扩展名）
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  const allUrls = text.matchAll(urlPattern);
  for (const match of allUrls) {
    const url = match[0];
    try {
      const hostname = new URL(url).hostname;
      if (KNOWN_IMAGE_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))) {
        httpUrls.add(url);
      }
    } catch {
      // 无效 URL，忽略
    }
  }

  return { httpUrls: Array.from(httpUrls), dataUrls: Array.from(dataUrls) };
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 处理文本中的图片，提取并移除图片 URL
 * 返回处理后的文本和图片 URL 列表（data URL 和 http URL 合并）
 */
function processImagesInText(text: string): { text: string; imageUrls: string[] } {
  let processedText = text;
  const { httpUrls, dataUrls } = extractImageUrls(text);
  const allImageUrls = [...dataUrls, ...httpUrls]; // data URL 优先

  // 从文本中移除已提取的图片 URL（包括 markdown 格式）
  for (const url of allImageUrls) {
    // 对于 data URL，需要特殊处理（因为太长，用简化的正则）
    if (url.startsWith("data:")) {
      // 移除 markdown 格式的 data URL
      processedText = processedText.replace(/!\[.*?\]\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/gi, "");
    } else {
      processedText = processedText
        .replace(new RegExp(`!\\[.*?\\]\\(${escapeRegExp(url)}\\)`, "g"), "")
        .replace(new RegExp(escapeRegExp(url), "g"), "");
    }
  }

  // 清理多余的空行
  processedText = processedText.replace(/\n{3,}/g, "\n\n").trim();

  return { text: processedText, imageUrls: allImageUrls };
}
import {
  isPaired,
  getPairedUser,
  generatePairingCode,
  unpair,
  verifyPairingCode,
  getPairingApiToken,
  setPairingApiToken,
} from "./pairing.js";

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

function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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
  console.log(
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
const webhookTargets = new Map<string, {
  account: ResolvedWechatMpAccount;
  cfg: any;
}>();

// 处理中的消息（防重复）
const processingMessages = new Set<string>();

// 待处理的图片（用户发送图片后等待说明）
// key: accountId:openId, value: { filePath, timestamp }
const pendingImages = new Map<string, { filePath: string; timestamp: number }>();
const PENDING_IMAGE_TIMEOUT = 5 * 60 * 1000; // 5 分钟过期

const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024; // 1MB (强安全)
const MAX_PAIRING_API_BODY_BYTES = 32 * 1024; // 32KB (强安全)

// /api/pair 简单限流（按 remoteAddress）
const pairingApiRate = new Map<string, { count: number; resetAt: number }>();
const PAIRING_API_RATE_LIMIT = { windowMs: 60_000, max: 30 };

function checkPairingApiRateLimit(req: IncomingMessage): { ok: true } | { ok: false; retryAfterSec: number } {
  const ip = req.socket?.remoteAddress || "unknown";
  const now = Date.now();
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
 * 注册 Webhook 目标
 */
export function registerWechatMpWebhookTarget(opts: {
  account: ResolvedWechatMpAccount;
  path: string;
  cfg: any;
}): () => void {
  const { account, path, cfg } = opts;
  webhookTargets.set(path, { account, cfg });
  console.log(`[wemp:${account.accountId}] Webhook registered at ${path}`);

  return () => {
    webhookTargets.delete(path);
    console.log(`[wemp:${account.accountId}] Webhook unregistered from ${path}`);
  };
}

/**
 * 从请求中解析路径
 */
function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.pathname || "/";
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
  const pathname = resolvePath(req);

  console.log(`[wemp] Received request: ${req.method} ${pathname}`);
  console.log(`[wemp] Registered targets: ${Array.from(webhookTargets.keys()).join(", ") || "none"}`);

  // 查找匹配的 webhook 目标
  const target = webhookTargets.get(pathname);
  if (!target) {
    // 也检查是否是 /wemp 开头的路径
    for (const [path, t] of webhookTargets) {
      if (pathname === path || pathname.startsWith(path + "/")) {
        return handleRequest(req, res, t.account, t.cfg);
      }
    }
    console.log(`[wemp] No matching target for ${pathname}`);
    return false;
  }

  return handleRequest(req, res, target.account, target.cfg);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedWechatMpAccount,
  cfg: any
): Promise<boolean> {
  const queryParams = resolveQueryParams(req);
  const query = Object.fromEntries(queryParams);
  const pathname = resolvePath(req);

  // 配对 API 端点
  if (req.method === "POST" && pathname.endsWith("/api/pair")) {
    return handlePairingApi(req, res, account);
  }

  // GET 请求 - 服务器验证
  if (req.method === "GET") {
    const { signature, timestamp, nonce, echostr } = query;

    if (verifySignature(account.token, signature ?? "", timestamp ?? "", nonce ?? "")) {
      console.log(`[wemp:${account.accountId}] 服务器验证成功`);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(echostr ?? "");
      return true;
    } else {
      console.warn(`[wemp:${account.accountId}] 服务器验证失败`);
      res.statusCode = 403;
      res.end("验证失败");
      return true;
    }
  }

  // POST 请求 - 接收消息
  if (req.method === "POST") {
    let rawBody = "";
    try {
      rawBody = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] 读取请求体失败: ${err}`);
      res.statusCode = String(err).includes("too large") ? 413 : 400;
      res.end("Bad Request");
      return true;
    }

    const result = processWechatMessage(account, rawBody, query);
    if (!result.success || !result.message) {
      console.warn(`[wemp:${account.accountId}] ${result.error}`);
      res.statusCode = result.error?.includes("验证失败") ? 403 : 400;
      res.end(result.error ?? "Error");
      return true;
    }

    const msg = result.message;
    console.log(`[wemp:${account.accountId}] 收到消息: type=${msg.msgType}, from=${msg.fromUserName}`);

    // 立即返回 success，避免微信超时
    res.statusCode = 200;
    res.end("success");

    // 异步处理消息
    setImmediate(() => {
      handleMessage(account, msg, cfg).catch((err) => {
        console.error(`[wemp:${account.accountId}] 处理消息失败:`, err);
      });
    });

    return true;
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
  return true;
}

/**
 * 读取请求体
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (limit=${maxBytes})`));
        try {
          req.destroy();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      resolve(body);
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
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
    console.error(`[wemp:${account.accountId}] Runtime not available`);
    return;
  }

  const openId = msg.fromUserName;
  const msgKey = `${account.accountId}:${openId}:${msg.msgId || msg.createTime}`;

  // 防重复处理
  if (processingMessages.has(msgKey)) {
    console.log(`[wemp:${account.accountId}] 跳过重复消息: ${msgKey}`);
    return;
  }
  processingMessages.add(msgKey);
  setTimeout(() => processingMessages.delete(msgKey), 30000);

  // 处理事件
  if (msg.msgType === "event") {
    await handleEvent(account, msg, runtime, cfg);
    return;
  }

  // 处理文本消息
  if (msg.msgType === "text" && msg.content) {
    const trimmed = msg.content.trim();

    // === 特殊命令处理 ===
    const commandResult = await handleSpecialCommand(account, openId, trimmed);
    if (commandResult) {
      return; // 命令已处理
    }

    // === 正常对话 ===
    // 发送正在输入状态
    sendTypingStatus(account, openId).catch(() => {});

    // 根据配对状态选择 agent
    const paired = isPaired(account.accountId, openId);
    const agentCfg = getAgentConfig(account.accountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
    console.log(`[wemp:${account.accountId}] 用户 ${openId} 使用 agent: ${agentId} (${paired ? "已配对" : "未配对"})`);

    // 检查是否有待处理的图片
    const pendingKey = `${account.accountId}:${openId}`;
    const pendingImage = pendingImages.get(pendingKey);
    let imageFilePath: string | undefined;

    if (pendingImage) {
      // 检查图片是否过期
      if (Date.now() - pendingImage.timestamp < PENDING_IMAGE_TIMEOUT) {
        imageFilePath = pendingImage.filePath;
        console.log(`[wemp:${account.accountId}] 用户 ${openId} 有待处理图片: ${imageFilePath}`);
      }
      // 无论是否过期，都清除待处理图片
      pendingImages.delete(pendingKey);
    }

    // 使用 dispatchReplyFromConfig 处理消息
    await dispatchWempMessage({
      account,
      openId,
      text: msg.content,
      messageId: msg.msgId ?? `${msg.createTime}`,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      agentId,
      cfg: storedConfig || cfg,
      runtime,
      imageFilePath,
    });
    return;
  }

  // 处理图片消息
  if (msg.msgType === "image" && msg.picUrl) {
    // 下载图片到本地文件（避免 base64 数据过大导致上下文溢出）
    const downloadResult = await downloadImageToFile(msg.picUrl);
    if (!downloadResult.success || !downloadResult.filePath) {
      console.error(`[wemp:${account.accountId}] 下载图片失败: ${downloadResult.error}`);
      await sendCustomMessage(account, openId, "抱歉，图片下载失败，请重新发送。");
      return;
    }

    // 保存图片文件路径，等待用户发送说明
    const pendingKey = `${account.accountId}:${openId}`;
    pendingImages.set(pendingKey, {
      filePath: downloadResult.filePath,
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
    sendTypingStatus(account, openId).catch(() => {});

    const paired = isPaired(account.accountId, openId);
    const agentCfg = getAgentConfig(account.accountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
    console.log(`[wemp:${account.accountId}] 用户 ${openId} 发送语音(识别), 使用 agent: ${agentId} (${paired ? "已配对" : "未配对"})`);

    await dispatchWempMessage({
      account,
      openId,
      text: msg.recognition,
      messageId: msg.msgId ?? `${msg.createTime}`,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      agentId,
      cfg: storedConfig || cfg,
      runtime,
    });
    return;
  }

  // 暂不支持的消息类型
  if (msg.msgType === "voice" || msg.msgType === "video") {
    console.log(`[wemp:${account.accountId}] 暂不支持的消息类型: ${msg.msgType}`);
  }
}

/**
 * 使用 runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher 分发消息并获取 AI 回复
 * 参考 LINE 插件的完整实现
 */
async function dispatchWempMessage(params: {
  account: ResolvedWechatMpAccount;
  openId: string;
  text: string;
  messageId: string;
  timestamp: number;
  agentId: string;
  cfg: any;
  runtime: any;
  imageFilePath?: string;
}): Promise<void> {
  const { account, openId, text, messageId, timestamp, cfg, runtime, imageFilePath } = params;

  // 从 runtime 获取需要的函数
  const dispatchReplyWithBufferedBlockDispatcher = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  const finalizeInboundContext = runtime.channel?.reply?.finalizeInboundContext;
  const resolveAgentRoute = runtime.channel?.routing?.resolveAgentRoute;
  const formatInboundEnvelope = runtime.channel?.reply?.formatInboundEnvelope;
  const resolveEnvelopeFormatOptions = runtime.channel?.reply?.resolveEnvelopeFormatOptions;
  const recordChannelActivity = runtime.channel?.activity?.record;
  const chunkMarkdownText = runtime.channel?.text?.chunkMarkdownText;
  const recordSessionMetaFromInbound = runtime.channel?.session?.recordSessionMetaFromInbound;
  const resolveStorePath = runtime.channel?.session?.resolveStorePath;
  const updateLastRoute = runtime.channel?.session?.updateLastRoute;
  // 命令处理相关
  const isControlCommandMessage = runtime.channel?.commands?.isControlCommandMessage;
  const dispatchControlCommand = runtime.channel?.commands?.dispatchControlCommand;

  if (!dispatchReplyWithBufferedBlockDispatcher) {
    console.error(`[wemp:${account.accountId}] dispatchReplyWithBufferedBlockDispatcher not available in runtime`);
    return;
  }

  // 0. 检查是否是内置命令（/help, /clear, /new 等）
  if (isControlCommandMessage && dispatchControlCommand) {
    const isControlCmd = isControlCommandMessage(text, cfg);
    if (isControlCmd) {
      console.log(`[wemp:${account.accountId}] 检测到内置命令: ${text}`);
      try {
        const result = await dispatchControlCommand({
          command: text,
          cfg,
          channel: "wemp",
          accountId: account.accountId,
          sessionKey: `wemp:${account.accountId}:${openId}`,
          senderId: openId,
          deliver: async (response: string) => {
            await sendCustomMessage(account, openId, response);
          },
        });
        if (result?.handled) {
          console.log(`[wemp:${account.accountId}] 内置命令已处理`);
          return;
        }
      } catch (err) {
        console.warn(`[wemp:${account.accountId}] 内置命令处理失败:`, err);
      }
    }
  }

  // 1. 记录渠道活动
  try {
    recordChannelActivity?.({
      channel: "wemp",
      accountId: account.accountId,
      direction: "inbound",
    });
  } catch (err) {
    console.warn(`[wemp:${account.accountId}] recordChannelActivity failed:`, err);
  }

  // 2. 解析路由 - 但保留我们基于配对状态的 agentId
  const agentId = params.agentId; // 保留传入的 agentId（基于配对状态）

  // 构建 sessionKey - 包含 agentId 以区分不同 agent 的会话
  let sessionKey = `wemp:${agentId}:${account.accountId}:${openId}`;
  let mainSessionKey = `wemp:${account.accountId}:${openId}`;

  // 尝试使用 resolveAgentRoute 获取更多路由信息，但不覆盖 agentId
  if (resolveAgentRoute) {
    try {
      const route = resolveAgentRoute({
        cfg,
        channel: "wemp",
        accountId: account.accountId,
        peer: {
          kind: "dm",
          id: openId,
        },
      });
      // 只使用 route 的 mainSessionKey 格式，但保留我们的 agentId
      if (route.mainSessionKey) {
        mainSessionKey = route.mainSessionKey;
      }
      // sessionKey 需要包含我们的 agentId
      sessionKey = `wemp:${agentId}:${account.accountId}:${openId}`;
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] resolveAgentRoute failed:`, err);
    }
  }

  console.log(`[wemp:${account.accountId}] 路由: agentId=${agentId}, sessionKey=${sessionKey}`);

  // 3. 构建消息信封
  const fromAddress = `wemp:${openId}`;

  // 如果有图片，添加图片路径标记（参考 QQBot 的做法，避免 base64 数据过大）
  let messageText = text;
  if (imageFilePath) {
    messageText = `[图片: ${imageFilePath}]\n\n${text}`;
  }

  let body = messageText;

  if (formatInboundEnvelope) {
    try {
      const envelopeOptions = resolveEnvelopeFormatOptions?.(cfg);
      body = formatInboundEnvelope({
        channel: "WEMP",
        from: openId,
        timestamp,
        body: messageText,
        chatType: "direct",
        sender: { id: openId },
        envelope: envelopeOptions,
      }) ?? messageText;
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] formatInboundEnvelope failed:`, err);
    }
  }

  // 4. 构建 inbound context
  let ctx: any = {
    Body: body,
    RawBody: messageText,
    CommandBody: text,
    From: fromAddress,
    To: fromAddress,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    ChatType: "direct",
    ConversationLabel: openId,
    SenderId: openId,
    Provider: "wemp",
    Surface: "wemp",
    MessageSid: messageId,
    Timestamp: timestamp,
    OriginatingChannel: "wemp",
    OriginatingTo: fromAddress,
    // 指定 agent ID - 这是关键！
    AgentId: agentId,
  };

  // 添加图片附件（使用本地文件路径）
  if (imageFilePath) {
    ctx.Attachments = [
      {
        type: "image",
        url: imageFilePath,
        contentType: "image/jpeg",
      },
    ];
    ctx.MediaUrls = [imageFilePath];
    ctx.NumMedia = "1";
  }

  // 使用 finalizeInboundContext 处理 context
  if (finalizeInboundContext) {
    ctx = finalizeInboundContext(ctx);
  }

  // 5. 记录会话元数据
  if (recordSessionMetaFromInbound && resolveStorePath) {
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      await recordSessionMetaFromInbound({
        storePath,
        sessionKey: ctx.SessionKey ?? sessionKey,
        ctx,
      });
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] recordSessionMetaFromInbound failed:`, err);
    }
  }

  // 6. 更新最后路由
  if (updateLastRoute && resolveStorePath) {
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      await updateLastRoute({
        storePath,
        sessionKey: mainSessionKey,
        deliveryContext: {
          channel: "wemp",
          to: openId,
          accountId: account.accountId,
        },
        ctx,
      });
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] updateLastRoute failed:`, err);
    }
  }

  // 7. 分发消息并获取回复
  try {
    const textLimit = 600; // 微信客服消息限制

    const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          // 发送正在输入状态
          sendTypingStatus(account, openId).catch(() => {});

          // 处理文本回复
          let replyText = payload.text || payload.content || "";

          // 从文本中提取图片 URL
          const { text: processedText, imageUrls: extractedImageUrls } = processImagesInText(replyText);
          replyText = processedText;

          if (replyText) {
            // 使用 chunkMarkdownText 分块发送长文本
            let chunks: string[];
            if (chunkMarkdownText) {
              try {
                chunks = chunkMarkdownText(replyText, textLimit);
              } catch {
                chunks = [replyText];
              }
            } else {
              // 简单分块
              chunks = [];
              let remaining = replyText;
              while (remaining.length > 0) {
                chunks.push(remaining.slice(0, textLimit));
                remaining = remaining.slice(textLimit);
              }
            }

            // 发送每个分块
            for (const chunk of chunks) {
              if (chunk.trim()) {
                await sendCustomMessage(account, openId, chunk);
              }
            }
          }

          // 合并 payload 中的媒体 URL 和从文本中提取的图片 URL
          const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const allImageUrls = [...payloadMediaUrls, ...extractedImageUrls];

          // 发送图片（最多 10 张）
          for (const imageUrl of allImageUrls.slice(0, 10)) {
            if (imageUrl) {
              try {
                const result = await sendImageByUrl(account, openId, imageUrl);
                if (!result.success) {
                  console.warn(`[wemp:${account.accountId}] 发送图片失败: ${result.error}`);
                }
              } catch (err) {
                console.warn(`[wemp:${account.accountId}] 发送图片异常: ${err}`);
              }
            }
          }

          // 记录出站活动
          try {
            recordChannelActivity?.({
              channel: "wemp",
              accountId: account.accountId,
              direction: "outbound",
            });
          } catch {}
        },
        onError: (err: any, info: any) => {
          console.error(`[wemp:${account.accountId}] ${info?.kind || "reply"} 失败:`, err);
        },
      },
      replyOptions: {},
    });

    if (!queuedFinal) {
      console.log(`[wemp:${account.accountId}] 没有生成回复`);
    }
  } catch (err) {
    console.error(`[wemp:${account.accountId}] 消息分发失败:`, err);
    // 发送错误消息
    await sendCustomMessage(account, openId, "抱歉，处理消息时出现错误，请稍后再试。");
  }
}

/**
 * 处理特殊命令
 * 返回 true 表示命令已处理，false 表示不是特殊命令
 */
async function handleSpecialCommand(
  account: ResolvedWechatMpAccount,
  openId: string,
  content: string
): Promise<boolean> {
  // 配对命令
  if (content === "配对" || content === "绑定") {
    if (isPaired(account.accountId, openId)) {
      const user = getPairedUser(account.accountId, openId);
      await sendCustomMessage(
        account,
        openId,
        `你已经配对过了 ✅\n\n` +
          `配对时间: ${user ? new Date(user.pairedAt).toLocaleString("zh-CN") : "未知"}\n` +
          `配对账号: ${user?.pairedByName || user?.pairedBy || "未知"}\n` +
          `配对渠道: ${user?.pairedByChannel || "未知"}\n\n` +
          `发送「解除配对」可以取消绑定。`
      );
    } else {
      const code = generatePairingCode(account.accountId, openId);
      await sendCustomMessage(
        account,
        openId,
        `🔗 配对码: ${code}\n\n` +
          `请在 5 分钟内，通过其他已授权渠道（如 Telegram、QQ）发送以下命令完成配对：\n\n` +
          `/pair wemp ${code}\n\n` +
          `配对后，你将获得完整的 AI 助手功能。`
      );
    }
    return true;
  }

  // 解除配对
  if (content === "解除配对" || content === "取消绑定") {
    if (isPaired(account.accountId, openId)) {
      unpair(account.accountId, openId);
      await sendCustomMessage(
        account,
        openId,
        `已解除配对 ✅\n\n你现在使用的是客服模式，功能有所限制。发送「配对」可以重新绑定。`
      );
    } else {
      await sendCustomMessage(account, openId, `你还没有配对过哦，发送「配对」开始绑定。`);
    }
    return true;
  }

  // 查看状态
  if (content === "状态" || content === "/status") {
    const paired = isPaired(account.accountId, openId);
    const user = getPairedUser(account.accountId, openId);
    const mode = paired ? "🔓 完整模式（个人助理）" : "🔒 客服模式";
    const agentCfg = getAgentConfig(account.accountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;

    let statusMsg = `当前状态: ${mode}\n`;
    statusMsg += `Agent: ${agentId}\n`;
    if (paired && user) {
      statusMsg += `配对时间: ${new Date(user.pairedAt).toLocaleString("zh-CN")}\n`;
      statusMsg += `配对账号: ${user.pairedByName || user.pairedBy || "未知"}\n`;
      statusMsg += `配对渠道: ${user.pairedByChannel || "未知"}\n`;
    }
    statusMsg += `\n发送「配对」可以${paired ? "查看配对信息" : "绑定账号获取完整功能"}。`;

    await sendCustomMessage(account, openId, statusMsg);
    return true;
  }

  return false;
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
      console.log(`[wemp:${account.accountId}] 用户关注: ${openId}`);
      // 发送欢迎消息
      const paired = isPaired(account.accountId, openId);
      const welcomeMsg = paired
        ? "欢迎回来！🌊 你已经配对过了，可以直接开始对话。"
        : "欢迎关注！我是 AI 助手 🌊\n\n" +
          "你可以直接发消息和我聊天。\n\n" +
          "💡 小提示：\n" +
          "• 发送「配对」绑定账号，解锁完整功能\n" +
          "• 发送「状态」查看当前模式\n" +
          "• 点击底部菜单使用更多功能";
      await sendCustomMessage(account, openId, welcomeMsg);
      break;

    case "unsubscribe":
      console.log(`[wemp:${account.accountId}] 用户取消关注: ${openId}`);
      break;

    case "CLICK":
      // 处理菜单点击事件
      console.log(`[wemp:${account.accountId}] 菜单点击: ${msg.eventKey}, from=${openId}`);
      await handleMenuClick(account, openId, msg.eventKey || "", runtime, cfg);
      break;

    default:
      console.log(`[wemp:${account.accountId}] 未处理的事件: ${msg.event}`);
  }
}

/**
 * 处理菜单点击事件
 */
async function handleMenuClick(
  account: ResolvedWechatMpAccount,
  openId: string,
  eventKey: string,
  runtime: any,
  cfg: any
): Promise<void> {
  // 菜单命令映射
  const menuCommands: Record<string, string> = {
    CMD_NEW: "/new",
    CMD_CLEAR: "/clear",
    CMD_UNDO: "/undo",
    CMD_HELP: "/help",
    CMD_STATUS: "状态",
    CMD_PAIR: "配对",
    CMD_MODEL: "/model",
    CMD_USAGE: "/usage",
  };

  // 特殊菜单处理（发送链接）
  const wempCfg = cfg?.channels?.wemp;
  if (eventKey === "CMD_ARTICLES") {
    const articlesUrl = wempCfg?.articlesUrl || "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzI0NTc0NTEwNQ==&scene=124#wechat_redirect";
    await sendCustomMessage(account, openId, `📚 历史文章\n\n点击查看：${articlesUrl}`);
    return;
  }

  if (eventKey === "CMD_WEBSITE") {
    const websiteUrl = wempCfg?.websiteUrl || "https://kilan.cn";
    await sendCustomMessage(account, openId, `🌐 官网\n\n访问：${websiteUrl}`);
    return;
  }

  if (eventKey === "CMD_CONTACT") {
    const contactInfo = wempCfg?.contactInfo || "如需帮助，请直接发送消息。";
    await sendCustomMessage(account, openId, `📞 联系我们\n\n${contactInfo}`);
    return;
  }

  const command = menuCommands[eventKey];
  if (!command) {
    console.log(`[wemp:${account.accountId}] 未知的菜单事件: ${eventKey}`);
    return;
  }

  // 对于内置命令，模拟用户发送消息
  console.log(`[wemp:${account.accountId}] 执行菜单命令: ${command}`);

  // 检查是否是特殊命令（配对、状态等）
  if (command === "配对" || command === "状态") {
    await handleSpecialCommand(account, openId, command);
    return;
  }

  // 对于 OpenClaw 内置命令，通过 dispatchControlCommand 处理
  const dispatchControlCommand = runtime?.channel?.commands?.dispatchControlCommand;
  const isControlCommandMessage = runtime?.channel?.commands?.isControlCommandMessage;

  if (dispatchControlCommand && isControlCommandMessage) {
    const isControlCmd = isControlCommandMessage(command, cfg);
    if (isControlCmd) {
      try {
        const result = await dispatchControlCommand({
          command,
          cfg,
          channel: "wemp",
          accountId: account.accountId,
          sessionKey: `wemp:${account.accountId}:${openId}`,
          senderId: openId,
          deliver: async (response: string) => {
            await sendCustomMessage(account, openId, response);
          },
        });
        if (result?.handled) {
          return;
        }
      } catch (err) {
        console.warn(`[wemp:${account.accountId}] 菜单命令处理失败:`, err);
      }
    }
  }

  // 如果命令未被处理，发送提示
  await sendCustomMessage(account, openId, `命令 ${command} 暂不支持。`);
}

/**
 * 处理配对 API 请求
 * POST /wemp/api/pair
 * Body: { code: string, userId: string, userName?: string, channel?: string, token: string }
 */
async function handlePairingApi(
  req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedWechatMpAccount
): Promise<boolean> {
  try {
    const rate = checkPairingApiRateLimit(req);
    if (!rate.ok) {
      res.statusCode = 429;
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Too Many Requests" }));
      return true;
    }

    let rawBody = "";
    try {
      rawBody = await readBody(req, MAX_PAIRING_API_BODY_BYTES);
    } catch (err) {
      res.statusCode = String(err).includes("too large") ? 413 : 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Bad Request" }));
      return true;
    }

    let body: {
      code?: string;
      userId?: string;
      userName?: string;
      channel?: string;
      token?: string;
    };
    try {
      body = JSON.parse(rawBody) as any;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    // 验证 token
    const expectedToken = getPairingApiToken(account.accountId);
    if (!expectedToken) {
      // 强安全：没有显式配置则禁用此端点
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not Found" }));
      return true;
    }
    if (!body.token || !timingSafeEqualString(body.token, expectedToken)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    if (!body.code || !body.userId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing code or userId" }));
      return true;
    }

    const result = verifyPairingCode(body.code, body.userId, body.userName, body.channel);

    if (result) {
      // 通知微信用户配对成功
      await sendCustomMessage(
        account,
        result.openId,
        `🎉 配对成功！\n\n` +
          `已与 ${body.userName || body.userId} 绑定。\n` +
          `配对渠道: ${body.channel || "未知"}\n\n` +
          `现在你可以使用完整的 AI 助手功能了。`
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, openId: result.openId }));
    } else {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid or expired code" }));
    }
  } catch (err) {
    console.error(`[wemp:${account.accountId}] 配对 API 错误:`, err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }

  return true;
}
