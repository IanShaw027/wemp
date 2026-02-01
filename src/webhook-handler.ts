/**
 * 微信公众号 Webhook 处理
 * 支持配对功能和双 Agent 模式（客服模式 / 个人助理模式）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedWechatMpAccount, WechatMpMessage, WechatMpChannelConfig } from "./types.js";
import { verifySignature, processWechatMessage } from "./crypto.js";
import { sendTypingStatus, sendCustomMessage } from "./api.js";
import { getWechatMpRuntime } from "./runtime.js";
import {
  isPaired,
  getPairedUser,
  generatePairingCode,
  unpair,
  verifyPairingCode,
  getPairingApiToken,
  setPairingApiToken,
} from "./pairing.js";

// Agent ID 配置（默认值，可被配置文件覆盖）
let agentIdPaired = process.env.WEMP_AGENT_PAIRED || "main";
let agentIdUnpaired = process.env.WEMP_AGENT_UNPAIRED || "wemp-cs";

/**
 * 初始化配对配置（从配置文件读取）
 */
export function initPairingConfig(cfg: WechatMpChannelConfig): void {
  if (cfg.agentPaired) {
    agentIdPaired = cfg.agentPaired;
  }
  if (cfg.agentUnpaired) {
    agentIdUnpaired = cfg.agentUnpaired;
  }
  if (cfg.pairingApiToken) {
    setPairingApiToken(cfg.pairingApiToken);
  }
  console.log(`[wemp] 配对配置: agentPaired=${agentIdPaired}, agentUnpaired=${agentIdUnpaired}`);
}

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
    const rawBody = await readBody(req);

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
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
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
  const msgKey = `${openId}:${msg.msgId || msg.createTime}`;

  // 防重复处理
  if (processingMessages.has(msgKey)) {
    console.log(`[wemp:${account.accountId}] 跳过重复消息: ${msgKey}`);
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
    const agentId = paired ? agentIdPaired : agentIdUnpaired;
    console.log(`[wemp:${account.accountId}] 用户 ${openId} 使用 agent: ${agentId} (${paired ? "已配对" : "未配对"})`);

    // 构建 inbound 消息
    const inbound = {
      channel: "wemp" as const,
      accountId: account.accountId,
      chatType: "direct" as const,
      chatId: openId,
      messageId: msg.msgId ?? `${msg.createTime}`,
      authorId: openId,
      authorName: openId,
      text: msg.content,
      timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
      raw: msg,
      // 指定 agent ID
      agentId,
    };

    // 调用 runtime 处理消息
    await runtime.handleInbound(inbound);
    return;
  }

  // 其他消息类型
  if (msg.msgType === "image" || msg.msgType === "voice" || msg.msgType === "video") {
    // 语音消息如果有识别结果，当作文本处理
    if (msg.msgType === "voice" && msg.recognition) {
      const paired = isPaired(account.accountId, openId);
      const agentId = paired ? agentIdPaired : agentIdUnpaired;

      const inbound = {
        channel: "wemp" as const,
        accountId: account.accountId,
        chatType: "direct" as const,
        chatId: openId,
        messageId: msg.msgId ?? `${msg.createTime}`,
        authorId: openId,
        authorName: openId,
        text: msg.recognition,
        timestamp: parseInt(msg.createTime) * 1000 || Date.now(),
        raw: msg,
        agentId,
      };
      await runtime.handleInbound(inbound);
      return;
    }

    // 暂不支持的消息类型
    console.log(`[wemp:${account.accountId}] 暂不支持的消息类型: ${msg.msgType}`);
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
    const agentId = paired ? agentIdPaired : agentIdUnpaired;

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
  runtime: any
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
          "• 发送「解除配对」取消绑定";
      await sendCustomMessage(account, openId, welcomeMsg);
      break;

    case "unsubscribe":
      console.log(`[wemp:${account.accountId}] 用户取消关注: ${openId}`);
      break;

    default:
      console.log(`[wemp:${account.accountId}] 未处理的事件: ${msg.event}`);
  }
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
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody) as {
      code?: string;
      userId?: string;
      userName?: string;
      channel?: string;
      token?: string;
    };

    // 验证 token
    if (body.token !== getPairingApiToken()) {
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
