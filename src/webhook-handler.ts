/**
 * 微信公众号 Webhook 处理
 */
import type { HttpHandlerContext, HttpHandlerResult } from "clawdbot/plugin-sdk";
import type { ResolvedWechatMpAccount, WechatMpMessage } from "./types.js";
import { verifySignature, processWechatMessage } from "./crypto.js";
import { sendTypingStatus } from "./api.js";
import { getWechatMpRuntime } from "./runtime.js";
import { resolveWechatMpAccount } from "./config.js";

// 注册的 webhook 目标
const webhookTargets = new Map<string, {
  account: ResolvedWechatMpAccount;
  cfg: any;
}>();

// 处理中的消息（防重复）
const processingMessages = new Set<string>();

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
  console.log(`[wechat-mp:${account.accountId}] Webhook registered at ${path}`);

  return () => {
    webhookTargets.delete(path);
    console.log(`[wechat-mp:${account.accountId}] Webhook unregistered from ${path}`);
  };
}

/**
 * 处理 Webhook 请求
 */
export async function handleWechatMpWebhookRequest(ctx: HttpHandlerContext): Promise<HttpHandlerResult | null> {
  const { req, url } = ctx;
  const pathname = url.pathname;

  console.log(`[wechat-mp] Received request: ${req.method} ${pathname}`);
  console.log(`[wechat-mp] Registered targets: ${Array.from(webhookTargets.keys()).join(", ") || "none"}`);

  // 查找匹配的 webhook 目标
  const target = webhookTargets.get(pathname);
  if (!target) {
    // 也检查是否是 /wechat-mp 开头的路径
    for (const [path, t] of webhookTargets) {
      if (pathname === path || pathname.startsWith(path + "/")) {
        return handleRequest(ctx, t.account, t.cfg);
      }
    }
    console.log(`[wechat-mp] No matching target for ${pathname}`);
    return null;
  }

  return handleRequest(ctx, target.account, target.cfg);
}

async function handleRequest(
  ctx: HttpHandlerContext,
  account: ResolvedWechatMpAccount,
  cfg: any
): Promise<HttpHandlerResult> {
  const { req, url } = ctx;
  const query = Object.fromEntries(url.searchParams);

  // GET 请求 - 服务器验证
  if (req.method === "GET") {
    const { signature, timestamp, nonce, echostr } = query;

    if (verifySignature(account.token, signature ?? "", timestamp ?? "", nonce ?? "")) {
      console.log(`[wechat-mp:${account.accountId}] 服务器验证成功`);
      return {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: echostr ?? "",
      };
    } else {
      console.warn(`[wechat-mp:${account.accountId}] 服务器验证失败`);
      return { status: 403, body: "验证失败" };
    }
  }

  // POST 请求 - 接收消息
  if (req.method === "POST") {
    const rawBody = await readBody(req);

    const result = processWechatMessage(account, rawBody, query);
    if (!result.success || !result.message) {
      console.warn(`[wechat-mp:${account.accountId}] ${result.error}`);
      return { status: result.error?.includes("验证失败") ? 403 : 400, body: result.error ?? "Error" };
    }

    const msg = result.message;
    console.log(`[wechat-mp:${account.accountId}] 收到消息: type=${msg.msgType}, from=${msg.fromUserName}`);

    // 立即返回 success，避免微信超时
    // 异步处理消息
    setImmediate(() => {
      handleMessage(account, msg, cfg).catch((err) => {
        console.error(`[wechat-mp:${account.accountId}] 处理消息失败:`, err);
      });
    });

    return { status: 200, body: "success" };
  }

  return { status: 405, body: "Method Not Allowed" };
}

/**
 * 读取请求体
 */
async function readBody(req: any): Promise<string> {
  if (typeof req.text === "function") {
    return req.text();
  }
  if (req.body) {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
    if (typeof req.body.toString === "function") return req.body.toString();
  }
  return "";
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
    console.error(`[wechat-mp:${account.accountId}] Runtime not available`);
    return;
  }

  const openId = msg.fromUserName;
  const msgKey = `${openId}:${msg.msgId || msg.createTime}`;

  // 防重复处理
  if (processingMessages.has(msgKey)) {
    console.log(`[wechat-mp:${account.accountId}] 跳过重复消息: ${msgKey}`);
    return;
  }
  processingMessages.add(msgKey);
  setTimeout(() => processingMessages.delete(msgKey), 30000);

  // 处理事件
  if (msg.msgType === "event") {
    await handleEvent(account, msg, runtime);
    return;
  }

  // 处理文本消息
  if (msg.msgType === "text" && msg.content) {
    // 发送正在输入状态
    sendTypingStatus(account, openId).catch(() => {});

    // 构建 inbound 消息
    const inbound = {
      channel: "wechat-mp" as const,
      accountId: account.accountId,
      chatType: "direct" as const,
      chatId: openId,
      messageId: msg.msgId ?? `${msg.createTime}`,
      authorId: openId,
      authorName: openId,
      text: msg.content,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      raw: msg,
    };

    // 调用 runtime 处理消息
    await runtime.handleInbound(inbound);
    return;
  }

  // 其他消息类型
  if (msg.msgType === "image" || msg.msgType === "voice" || msg.msgType === "video") {
    // 语音消息如果有识别结果，当作文本处理
    if (msg.msgType === "voice" && msg.recognition) {
      const inbound = {
        channel: "wechat-mp" as const,
        accountId: account.accountId,
        chatType: "direct" as const,
        chatId: openId,
        messageId: msg.msgId ?? `${msg.createTime}`,
        authorId: openId,
        authorName: openId,
        text: msg.recognition,
        timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
        raw: msg,
      };
      await runtime.handleInbound(inbound);
      return;
    }

    // 暂不支持的消息类型
    console.log(`[wechat-mp:${account.accountId}] 暂不支持的消息类型: ${msg.msgType}`);
  }
}

/**
 * 处理事件
 */
async function handleEvent(
  account: ResolvedWechatMpAccount,
  msg: WechatMpMessage,
  runtime: any
): Promise<void> {
  const openId = msg.fromUserName;

  switch (msg.event) {
    case "subscribe":
      console.log(`[wechat-mp:${account.accountId}] 用户关注: ${openId}`);
      // 可以发送欢迎消息
      break;

    case "unsubscribe":
      console.log(`[wechat-mp:${account.accountId}] 用户取消关注: ${openId}`);
      break;

    default:
      console.log(`[wechat-mp:${account.accountId}] 未处理的事件: ${msg.event}`);
  }
}
