/**
 * 菜单处理模块
 * 负责处理微信公众号菜单点击事件
 */
import type { ResolvedWechatMpAccount } from "./types.js";
import { sendCustomMessage, sendImageMessage, sendVoiceMessage } from "./api.js";
import { isOk } from "./result.js";
import { getMenuPayload } from "./menu-payload.js";
import { isPaired, requestPairing, setOptOut } from "./pairing.js";
import { dispatchWempMessage } from "./message-dispatcher.js";
import { isAiAssistantEnabled, enableAiAssistant, disableAiAssistant } from "./ai-assistant-state.js";
import { getUsageLimitToday } from "./usage-limit-tracker.js";
import { logInfo, logWarn } from "./log.js";
import { SAFE_CONTROL_COMMANDS, resolveCommandToken } from "./commands.js";

/**
 * 检查是否是菜单 payload ID 格式
 */
function isLikelyMenuPayloadId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value);
}

/**
 * 获取 Agent 配置
 */
function getAgentConfig(accountId: string, agentConfigByAccountId: Map<string, { agentPaired: string; agentUnpaired: string }>): { agentPaired: string; agentUnpaired: string } {
  const DEFAULT_AGENT_PAIRED = process.env.WEMP_AGENT_PAIRED || "main";
  const DEFAULT_AGENT_UNPAIRED = process.env.WEMP_AGENT_UNPAIRED || "wemp-cs";

  return (
    agentConfigByAccountId.get(accountId) ?? {
      agentPaired: DEFAULT_AGENT_PAIRED,
      agentUnpaired: DEFAULT_AGENT_UNPAIRED,
    }
  );
}

/**
 * 处理特殊命令
 * 返回 true 表示命令已处理，false 表示不是特殊命令
 */
export async function handleSpecialCommand(
  account: ResolvedWechatMpAccount,
  openId: string,
  content: string,
  opts?: {
    agentConfigByAccountId?: Map<string, { agentPaired: string; agentUnpaired: string }>;
    runtime?: any;
    cfg?: any;
  }
): Promise<boolean> {
  const runtime = opts?.runtime;
  const cfg = opts?.cfg;
  const agentConfigByAccountId = opts?.agentConfigByAccountId;
  const subjectId = `${account.accountId}:${openId}`;

  // 配对命令
  if (content === "配对" || content === "绑定") {
    // Always clear local opt-out when user asks to pair.
    try {
      setOptOut(account.accountId, openId, false);
    } catch {
      // ignore
    }

    const paired = runtime
      ? await isPaired({ runtime, accountId: account.accountId, openId })
      : false;

    if (paired) {
      await sendCustomMessage(
        account,
        openId,
        `你已经配对过了 ✅\n\n` +
          `你的 ID: ${subjectId}\n\n` +
          `发送「解除配对」可以切换为客服模式（本地生效）。\n` +
          `如需彻底移除授权，请联系管理员从 OpenClaw 的 wemp allowFrom 记录中移除该 ID。`
      );
      return true;
    }

    if (!runtime) {
      await sendCustomMessage(
        account,
        openId,
        `⚠️ 当前 OpenClaw runtime 不支持配对流程。\n\n` +
          `请联系管理员检查 wemp 插件加载是否正常。`
      );
      return true;
    }

    let requestCode = "";
    let created = false;
    try {
      const req = await requestPairing({
        runtime,
        accountId: account.accountId,
        openId,
        meta: { accountId: account.accountId },
      });
      requestCode = req.code;
      created = req.created;
    } catch (err) {
      await sendCustomMessage(
        account,
        openId,
        `❌ 创建配对请求失败：${String(err)}\n\n请稍后重试。`
      );
      return true;
    }

    if (!requestCode) {
      await sendCustomMessage(
        account,
        openId,
        `⚠️ 配对请求过多，暂时无法创建新的配对码。\n\n请稍后再试。`
      );
      return true;
    }

    const approveHint = `openclaw pairing approve wemp ${requestCode} --notify`;
    const approveHintAlt = `/pair wemp ${requestCode}`;
    const header = created ? "🔐 已创建配对请求" : "🔐 你已有一个待审批的配对请求";
    const body =
      `${header}\n\n` +
      `你的 ID: ${subjectId}\n` +
      `配对码: ${requestCode}\n` +
      `有效期: 1 小时\n\n` +
      `请让管理员批准配对（任选一种方式）：\n` +
      `A) 服务器执行：\n${approveHint}\n\n` +
      `B) 在任意已授权渠道发送：\n${approveHintAlt}\n\n` +
      `批准后，你将获得完整的 AI 助手功能。`;
    await sendCustomMessage(account, openId, body);
    return true;
  }

  // 解除配对
  if (content === "解除配对" || content === "取消绑定") {
    // OpenClaw allowFrom store is owner-managed; here we only provide a local opt-out.
    try {
      setOptOut(account.accountId, openId, true);
    } catch {
      // ignore
    }

    const paired = runtime
      ? await isPaired({ runtime, accountId: account.accountId, openId })
      : false;

    if (paired) {
      await sendCustomMessage(
        account,
        openId,
        `已解除配对 ✅\n\n` +
          `你现在使用的是客服模式（本地）。发送「配对」可以恢复完整模式。\n\n` +
          `提示：管理员端的授权记录仍可能存在（OpenClaw wemp allowFrom）。\n` +
          `如需彻底取消授权，请联系管理员移除 ID: ${subjectId}`
      );
    } else {
      await sendCustomMessage(account, openId, `你还没有配对过哦，发送「配对」开始绑定。`);
    }
    return true;
  }

  // 查看状态
  if (content === "状态" || content === "/status") {
    const paired = runtime
      ? await isPaired({ runtime, accountId: account.accountId, openId })
      : false;
    const mode = paired ? "🔓 完整模式（个人助理）" : "🔒 客服模式";

    // 使用账户特定的 agent 配置
    const agentCfg = agentConfigByAccountId
      ? getAgentConfig(account.accountId, agentConfigByAccountId)
      : { agentPaired: process.env.WEMP_AGENT_PAIRED || "main", agentUnpaired: process.env.WEMP_AGENT_UNPAIRED || "wemp-cs" };
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
    const aiEnabled = isAiAssistantEnabled(account.accountId, openId);

    let statusMsg = `当前状态: ${mode}\n`;
    statusMsg += `AI 助手: ${aiEnabled ? "✅ 已开启" : "❌ 已关闭"}\n`;
    statusMsg += `Agent: ${agentId}\n`;
    statusMsg += `ID: ${account.accountId}:${openId}\n`;
    statusMsg += `\n发送「配对」可以${paired ? "查看当前授权" : "申请绑定账号获取完整功能"}。`;
    if (!aiEnabled) {
      statusMsg += `\n点击菜单「AI助手」->「开启AI助手」开始使用。`;
    }

    await sendCustomMessage(account, openId, statusMsg);
    return true;
  }

  return false;
}

/**
 * 处理菜单点击事件
 * 需要传入 agentConfigByAccountId 以获取 agent 配置
 */
export async function handleMenuClick(
  account: ResolvedWechatMpAccount,
  openId: string,
  eventKey: string,
  runtime: any,
  cfg: any,
  agentConfigByAccountId: Map<string, { agentPaired: string; agentUnpaired: string }>
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

  // ============ AI 助手开关处理 ============
  if (eventKey === "CMD_AI_ENABLE") {
    enableAiAssistant(account.accountId, openId);
    const wempCfg = cfg?.channels?.wemp;
    const enabledMsg = wempCfg?.aiEnabledMessage ?? "✅ AI 助手已开启！\n\n现在你可以直接发送消息与我对话了。";
    await sendCustomMessage(account, openId, enabledMsg);
    return;
  }

  if (eventKey === "CMD_AI_DISABLE") {
    disableAiAssistant(account.accountId, openId);
    const wempCfg = cfg?.channels?.wemp;
    const disabledMsg = wempCfg?.aiDisabledMessage ?? "🔒 AI 助手已关闭。\n\n如需使用，请点击菜单「AI助手」->「开启AI助手」。";
    await sendCustomMessage(account, openId, disabledMsg);
    return;
  }

  // 特殊菜单处理（发送链接）
  const wempCfg = cfg?.channels?.wemp;
  logInfo(runtime, `[wemp:${account.accountId}] 菜单事件: ${eventKey}, wempCfg存在: ${!!wempCfg}`);

  // ============ 业务菜单处理 ============
  // 了解AI - 基础入门
  if (eventKey === "LEARN_BASIC") {
    const content = wempCfg?.menuContent?.learnBasic || 
      "🎓 AI 基础入门\n\n" +
      "欢迎开始您的 AI 学习之旅！\n\n" +
      "• 什么是人工智能？\n" +
      "• AI 的发展历程\n" +
      "• 常见 AI 应用场景\n\n" +
      "直接发送消息与 AI 助手对话，体验 AI 的魅力！";
    await sendCustomMessage(account, openId, content);
    return;
  }

  // 了解AI - 技术进阶
  if (eventKey === "LEARN_ADVANCED") {
    const content = wempCfg?.menuContent?.learnAdvanced || 
      "🚀 AI 技术进阶\n\n" +
      "深入了解 AI 技术：\n\n" +
      "• 大语言模型原理\n" +
      "• Prompt Engineering\n" +
      "• AI Agent 开发\n" +
      "• RAG 检索增强生成\n\n" +
      "有任何技术问题，随时向 AI 助手提问！";
    await sendCustomMessage(account, openId, content);
    return;
  }

  // 了解AI - Vibe Coding
  if (eventKey === "LEARN_VIBE") {
    const content = wempCfg?.menuContent?.learnVibe || 
      "🎨 Vibe Coding\n\n" +
      "用自然语言描述，让 AI 帮你写代码！\n\n" +
      "• 描述你想要的功能\n" +
      "• AI 生成代码实现\n" +
      "• 迭代优化直到满意\n\n" +
      "试试发送：「帮我写一个计算器程序」";
    await sendCustomMessage(account, openId, content);
    return;
  }

  // 企业方案
  if (eventKey === "ENTERPRISE") {
    const content = wempCfg?.menuContent?.enterprise || 
      "🏢 企业 AI 解决方案\n\n" +
      "启澜云智为企业提供：\n\n" +
      "• 私有化大模型部署\n" +
      "• 企业知识库搭建\n" +
      "• AI 客服系统定制\n" +
      "• AI 培训与咨询\n\n" +
      "联系我们：admin@kilan.cn\n" +
      "官网：https://kilan.cn";
    await sendCustomMessage(account, openId, content);
    return;
  }

  // ============ 使用统计（带限制信息）============
  if (eventKey === "CMD_USAGE") {
    // 获取使用限制配置
    const usageLimit = wempCfg?.usageLimit || {};
    const dailyLimit = usageLimit.dailyMessages || 0;  // 0 表示无限制
    const tokenLimit = usageLimit.dailyTokens || 0;    // 0 表示无限制
    
    // 获取正确的 agentId
    const paired = await isPaired({ runtime, accountId: account.accountId, openId });
    const agentCfg = getAgentConfig(account.accountId, agentConfigByAccountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;

    try {
      const now = Date.now();
      const statusText =
        (await dispatchWempMessage({
          account,
          openId,
          text: "/status",
          messageId: `menu:${eventKey}:${now}`,
          timestamp: now,
          agentId,
          cfg,
          runtime,
          captureReplies: true,
          // /status 和 /usage 都是安全命令：允许未配对用户查看统计
          forceCommandAuthorized: true,
        })) ?? "";

      const usageLineRaw =
        statusText
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.includes("Usage:")) ?? "";
      const usageLine = usageLineRaw.replace(/^.*Usage:\s*/u, "").trim();

      const { dayKey, counters } = getUsageLimitToday({
        accountId: account.accountId,
        openId,
      });

      const usedMessages = counters.messagesIn;
      const usedTokensEstimated = counters.tokensIn + counters.tokensOut;
      const usedTokensInEstimated = counters.tokensIn;
      const usedTokensOutEstimated = counters.tokensOut;

      const usedTokens = usedTokensEstimated;
      const usedTokensIn = usedTokensInEstimated;
      const usedTokensOut = usedTokensOutEstimated;

      const formatCompact = (value: number): string => {
        const v = Math.max(0, Math.floor(value));
        if (v < 1000) return String(v);
        if (v < 1000 * 1000) {
          const k = v / 1000;
          const fixed = k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(1) : k.toFixed(2);
          return `${fixed.replace(/\.0+$/u, "")}k`;
        }
        const m = v / (1000 * 1000);
        const fixed = m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
        return `${fixed.replace(/\.0+$/u, "")}m`;
      };

      const formatPct = (used: number, limit: number): string => {
        if (limit <= 0) return "0%";
        const pct = Math.min(999, Math.max(0, Math.round((used / limit) * 100)));
        return `${pct}%`;
      };

      let textToSend = `📊 使用统计（${dayKey}）\n`;

      if (usageLine) {
        textToSend += `\n🪟 会话窗口占用：${usageLine}\n`;
      } else {
        textToSend += `\n🪟 会话窗口占用：暂无数据\n`;
      }

      if (paired) {
        textToSend += `\n🧾 今日额度（usageLimit）\n`;
        textToSend += `• 管理者（已配对）：不受用量限制，不计入额度\n`;
      } else {
        // usageLimit 使用情况（按日，用户级）
        textToSend += `\n🧾 今日额度（usageLimit）\n`;
        if (dailyLimit > 0) {
          textToSend += `• 消息(用户请求)：${usedMessages}/${dailyLimit} (${formatPct(usedMessages, dailyLimit)})\n`;
        } else {
          textToSend += `• 消息(用户请求)：${usedMessages}（未设置上限）\n`;
        }

        const tokenLabel = "Tokens(估算)";
        if (tokenLimit > 0) {
          textToSend += `• ${tokenLabel}(输入+输出)：${formatCompact(usedTokens)}/${formatCompact(tokenLimit)} (${formatPct(usedTokens, tokenLimit)})\n`;
        } else {
          textToSend += `• ${tokenLabel}(输入+输出)：${formatCompact(usedTokens)}（未设置上限）\n`;
        }

        textToSend += `  - 输入 ~${formatCompact(usedTokensIn)} / 输出 ~${formatCompact(usedTokensOut)}\n`;
      }

      await sendCustomMessage(account, openId, textToSend);
      return;
    } catch (err) {
      logWarn(runtime, `[wemp:${account.accountId}] 获取使用统计失败:`, err);
      await sendCustomMessage(account, openId, "📊 使用统计\n\n暂无统计数据。");
      return;
    }
  }

  if (eventKey === "CMD_ARTICLES") {
    const articlesUrl = wempCfg?.articlesUrl || "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzI0NTc0NTEwNQ==&scene=124#wechat_redirect";
    logInfo(runtime, `[wemp:${account.accountId}] 发送历史文章链接: ${articlesUrl}`);
    // 微信可能过滤某些链接，尝试不同格式
    const result = await sendCustomMessage(account, openId, `📚 查看历史文章\n\n${articlesUrl}`);
    logInfo(runtime, `[wemp:${account.accountId}] 发送结果: ${JSON.stringify(result)}`);
    return;
  }

  if (eventKey === "CMD_WEBSITE") {
    const websiteUrl = wempCfg?.websiteUrl || "https://kilan.cn";
    logInfo(runtime, `[wemp:${account.accountId}] 发送官网链接: ${websiteUrl}`);
    const result = await sendCustomMessage(account, openId, `🌐 官网\n\n访问：${websiteUrl}`);
    logInfo(runtime, `[wemp:${account.accountId}] 发送结果: ${JSON.stringify(result)}`);
    return;
  }

  if (eventKey === "CMD_CONTACT") {
    const contactInfo = wempCfg?.contactInfo || "如需帮助，请直接发送消息。";
    await sendCustomMessage(account, openId, `📞 联系我们\n\n${contactInfo}`);
    return;
  }

  // ============ 处理后台菜单转换后的 BACKEND_* 类型 ============
  // 这些是从微信公众平台后台设置的"发送消息"类型菜单转换而来

  // BACKEND_TEXT_*: 发送消息-文字
  if (eventKey.startsWith("BACKEND_TEXT_")) {
    const suffix = eventKey.slice("BACKEND_TEXT_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }

    // 新格式：BACKEND_TEXT_{id}（id 对应本地存储 payload）
    // 旧格式：BACKEND_TEXT_{index}_{value}
    const originalValue = stored?.kind === "text"
      ? stored.text
      : (() => {
          const parts = eventKey.split("_");
          return parts.slice(3).join("_");
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(文字)，原始值: ${originalValue}`);

    // 检查是否有自定义的菜单响应配置
    const menuResponses = wempCfg?.menuResponses || {};
    if (menuResponses[originalValue]) {
      await sendCustomMessage(account, openId, menuResponses[originalValue]);
      return;
    }

    // 如果没有配置响应，将原始值作为消息发送给 AI 处理
    const aiEnabled = isAiAssistantEnabled(account.accountId, openId);
    if (!aiEnabled) {
      logInfo(runtime, `[wemp:${account.accountId}] 用户 ${openId.slice(0, 8)}... 的 AI 助手已关闭，跳过后台菜单文字处理`);
      const wempCfg = cfg?.channels?.wemp;
      const disabledHint = wempCfg?.aiDisabledHint ?? "AI 助手当前已关闭，请点击菜单「AI助手」->「开启AI助手」来开启。";
      // 只有当 disabledHint 非空时才发送消息
      if (disabledHint) {
        await sendCustomMessage(account, openId, disabledHint);
      }
      return;
    }

    const paired = await isPaired({ runtime, accountId: account.accountId, openId });
    const agentCfg = getAgentConfig(account.accountId, agentConfigByAccountId);
    const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;

    await dispatchWempMessage({
      account,
      openId,
      text: originalValue,
      messageId: `menu_${Date.now()}`,
      timestamp: Date.now(),
      agentId,
      cfg,
      runtime,
    });
    return;
  }

  // BACKEND_NEWS_*: 发送消息-已发表内容（图文消息）
  if (eventKey.startsWith("BACKEND_NEWS_")) {
    const suffix = eventKey.slice("BACKEND_NEWS_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }

    // 新格式：BACKEND_NEWS_{id}
    // 旧格式：BACKEND_NEWS_{index}_{encodedContentUrl}_{encodedTitle}
    const { contentUrl, title } = stored?.kind === "news"
      ? { contentUrl: stored.contentUrl, title: stored.title }
      : (() => {
          const parts = eventKey.split("_");
          const encodedContentUrl = parts[3] || "";
          const encodedTitle = parts.slice(4).join("_") || "";
          try {
            return {
              contentUrl: decodeURIComponent(encodedContentUrl),
              title: decodeURIComponent(encodedTitle),
            };
          } catch {
            return {
              contentUrl: encodedContentUrl,
              title: encodedTitle || "图文",
            };
          }
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(图文)，标题: ${title}, URL: ${contentUrl}`);

    if (contentUrl) {
      // 发送图文链接
      await sendCustomMessage(account, openId, `📰 ${title}\n\n${contentUrl}`);
    } else {
      await sendCustomMessage(account, openId, `📰 ${title}\n\n抱歉，无法获取文章链接。`);
    }
    return;
  }

  // BACKEND_IMG_*: 发送消息-图片
  if (eventKey.startsWith("BACKEND_IMG_")) {
    const suffix = eventKey.slice("BACKEND_IMG_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }
    const mediaId = stored?.kind === "image"
      ? stored.mediaId
      : (() => {
          const parts = eventKey.split("_");
          return parts.slice(3).join("_");
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(图片)，mediaId: ${mediaId}`);

    if (mediaId) {
      // 尝试发送图片（注意：后台设置的是临时素材，可能已过期）
      const result = await sendImageMessage(account, openId, mediaId);
      if (!isOk(result)) {
        await sendCustomMessage(account, openId, "抱歉，图片素材已过期或不可用。");
      }
    } else {
      await sendCustomMessage(account, openId, "抱歉，无法获取图片。");
    }
    return;
  }

  // BACKEND_VOICE_*: 发送消息-语音
  if (eventKey.startsWith("BACKEND_VOICE_")) {
    const suffix = eventKey.slice("BACKEND_VOICE_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }
    const mediaId = stored?.kind === "voice"
      ? stored.mediaId
      : (() => {
          const parts = eventKey.split("_");
          return parts.slice(3).join("_");
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(语音)，mediaId: ${mediaId}`);

    if (mediaId) {
      // 尝试发送语音（注意：后台设置的是临时素材，可能已过期）
      const result = await sendVoiceMessage(account, openId, mediaId);
      if (!isOk(result)) {
        logWarn(runtime, `[wemp:${account.accountId}] 发送语音失败: ${result.error}`);
        await sendCustomMessage(account, openId, "抱歉，语音素材已过期或不可用。");
      }
    } else {
      await sendCustomMessage(account, openId, "抱歉，无法获取语音。");
    }
    return;
  }

  // BACKEND_VIDEO_*: 发送消息-视频
  if (eventKey.startsWith("BACKEND_VIDEO_")) {
    const suffix = eventKey.slice("BACKEND_VIDEO_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }
    const videoValue = stored?.kind === "video"
      ? stored.value
      : (() => {
          const parts = eventKey.split("_");
          return parts.slice(3).join("_");
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(视频)，值: ${videoValue}`);

    if (videoValue) {
      // 判断是 URL 还是 media_id
      if (videoValue.startsWith("http://") || videoValue.startsWith("https://")) {
        // 是 URL，发送链接
        await sendCustomMessage(account, openId, `🎬 视频链接\n\n${videoValue}`);
      } else {
        // 公众号后台的 video 可能返回 media_id 或其他值，但微信客服消息发送视频通常需要缩略图等信息
        // 这里保守降级为提示，让用户改为 URL/或重新同步为 media_id 菜单类型
        await sendCustomMessage(
          account,
          openId,
          "抱歉，当前无法通过客服消息转发该视频素材。\n\n建议：\n• 将该菜单改为「跳转网页」并填写视频链接\n• 或重新同步菜单，让视频转换为可下发的 media_id 菜单"
        );
      }
    } else {
      await sendCustomMessage(account, openId, "抱歉，无法获取视频。");
    }
    return;
  }

  // BACKEND_FINDER_*: 发送消息-视频号动态
  if (eventKey.startsWith("BACKEND_FINDER_")) {
    const suffix = eventKey.slice("BACKEND_FINDER_".length);
    const stored = getMenuPayload(account.accountId, suffix);
    if (!stored && isLikelyMenuPayloadId(suffix)) {
      logWarn(runtime, `[wemp:${account.accountId}] 菜单 payload 丢失: ${eventKey}`);
      await sendCustomMessage(account, openId, "⚠️ 菜单内容已失效（本地缓存丢失）。请重新同步菜单后再试。");
      return;
    }
    const finderId = stored?.kind === "finder"
      ? stored.value
      : (() => {
          const parts = eventKey.split("_");
          return parts.slice(3).join("_");
        })();

    logInfo(runtime, `[wemp:${account.accountId}] 后台菜单点击(视频号动态)，ID: ${finderId}`);

    // 视频号动态暂不支持通过客服消息发送
    await sendCustomMessage(account, openId, "抱歉，视频号动态暂不支持通过此方式发送。");
    return;
  }

  // BACKEND_UNKNOWN_*: 未知类型（带原始类型信息）
  if (eventKey.startsWith("BACKEND_UNKNOWN_")) {
    logInfo(runtime, `[wemp:${account.accountId}] 未知类型的后台菜单点击: ${eventKey}`);
    await sendCustomMessage(account, openId, "抱歉，该菜单功能暂不支持。");
    return;
  }

  // BACKEND_EMPTY_*: 空菜单
  if (eventKey.startsWith("BACKEND_EMPTY_")) {
    logInfo(runtime, `[wemp:${account.accountId}] 空菜单点击: ${eventKey}`);
    await sendCustomMessage(account, openId, "抱歉，该菜单未配置内容。");
    return;
  }

  // UNKNOWN_*: 旧格式未知类型（兼容）
  if (eventKey.startsWith("UNKNOWN_")) {
    logInfo(runtime, `[wemp:${account.accountId}] 未知类型的后台菜单点击: ${eventKey}`);
    await sendCustomMessage(account, openId, "抱歉，该菜单功能暂不支持。");
    return;
  }

  const command = menuCommands[eventKey];
  if (!command) {
    logInfo(runtime, `[wemp:${account.accountId}] 未知的菜单事件: ${eventKey}`);
    return;
  }

  // 对于内置命令，模拟用户发送消息
  logInfo(runtime, `[wemp:${account.accountId}] 执行菜单命令: ${command}`);

  // 检查是否是特殊命令（配对、状态等）
  if (command === "配对" || command === "状态") {
    await handleSpecialCommand(account, openId, command, { agentConfigByAccountId, runtime, cfg });
    return;
  }

  // 获取正确的 agentId 和 sessionKey
  const paired = await isPaired({ runtime, accountId: account.accountId, openId });
  const agentCfg = getAgentConfig(account.accountId, agentConfigByAccountId);
  const agentId = paired ? agentCfg.agentPaired : agentCfg.agentUnpaired;
  const commandToken = resolveCommandToken(command);
  const forceCommandAuthorized = paired || SAFE_CONTROL_COMMANDS.has(commandToken);

  // 统一走消息分发流程，让 OpenClaw 自己处理 /new、/clear、/help 等内置命令。
  // 这样避免依赖不存在的 runtime.channel.commands.dispatchControlCommand。
  const now = Date.now();
  await dispatchWempMessage({
    account,
    openId,
    text: command,
    messageId: `menu:${eventKey}:${now}`,
    timestamp: now,
    agentId,
    cfg,
    runtime,
    commandAuthorized: paired,
    forceCommandAuthorized,
    usageLimitIgnore: true,
  });
}
