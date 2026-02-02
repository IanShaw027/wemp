/**
 * 消息分发模块
 * 负责将用户消息分发到 AI Agent 并处理回复
 */
import type { ResolvedWechatMpAccount } from "./types.js";
import { sendTypingStatus, sendCustomMessage, sendImageByUrl } from "./api.js";
import { isOk } from "./result.js";
import { processImagesInText } from "./image-processor.js";
import { WECHAT_MESSAGE_TEXT_LIMIT, MAX_IMAGES_PER_MESSAGE } from "./constants.js";
import { recordUsageLimitOutbound } from "./usage-limit-tracker.js";

function replaceAgentIdInSessionKey(sessionKey: string, agentId: string): string {
  const trimmedKey = (sessionKey ?? "").trim();
  const trimmedAgent = (agentId ?? "").trim();
  if (!trimmedKey || !trimmedAgent) {
    return trimmedKey;
  }
  const loweredKey = trimmedKey.toLowerCase();
  const loweredAgent = trimmedAgent.toLowerCase();
  if (!loweredKey.startsWith("agent:")) {
    return trimmedKey;
  }
  const parts = loweredKey.split(":");
  if (parts.length < 2) {
    return trimmedKey;
  }
  parts[1] = loweredAgent;
  return parts.join(":");
}

function buildWempSessionKeyFallback(params: {
  agentId: string;
  accountId: string;
  openId: string;
}): { sessionKey: string; mainSessionKey: string } {
  const agentId = (params.agentId ?? "").trim().toLowerCase() || "main";
  const accountId = (params.accountId ?? "").trim().toLowerCase() || "default";
  const openId = (params.openId ?? "").trim().toLowerCase() || "unknown";
  // Use a stable OpenClaw-style key so /usage, /clear, /new, etc can resolve agent + session properly.
  // We intentionally scope to per-peer to avoid cross-user context bleeding on public channels.
  return {
    sessionKey: `agent:${agentId}:wemp:${accountId}:dm:${openId}`,
    mainSessionKey: `agent:${agentId}:main`,
  };
}

/**
 * 使用 runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher 分发消息并获取 AI 回复
 * 参考 LINE 插件的完整实现
 */
export async function dispatchWempMessage(params: {
  account: ResolvedWechatMpAccount;
  openId: string;
  text: string;
  messageId: string;
  timestamp: number;
  agentId: string;
  cfg: any;
  runtime: any;
  imageFilePath?: string;
  captureReplies?: boolean;
  commandAuthorized?: boolean;
  forceCommandAuthorized?: boolean;
  usageLimitIgnore?: boolean;
}): Promise<string | undefined> {
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

  if (!dispatchReplyWithBufferedBlockDispatcher) {
    console.error(`[wemp:${account.accountId}] dispatchReplyWithBufferedBlockDispatcher not available in runtime`);
    return undefined;
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
  const agentIdRaw = params.agentId; // 保留传入的 agentId（基于配对状态）
  const agentId = agentIdRaw.trim().toLowerCase() || "main";
  const openIdLower = openId.toLowerCase();

  let sessionKey: string | undefined;
  let mainSessionKey: string | undefined;

  if (resolveAgentRoute) {
    try {
      const route = resolveAgentRoute({
        cfg,
        channel: "wemp",
        accountId: account.accountId,
        peer: {
          kind: "dm",
          id: openIdLower,
        },
      });
      const routeKey = typeof route?.sessionKey === "string" ? route.sessionKey : "";
      const routeMainKey = typeof route?.mainSessionKey === "string" ? route.mainSessionKey : "";
      // Some configs (dmScope="main") collapse DM sessions to agent:<id>:main; that is unsafe for public channels
      // like WeChat MP because it can cross-contaminate user context. Force per-peer scoping for wemp.
      const looksPerPeer = routeKey.includes(":dm:");
      const fallback = buildWempSessionKeyFallback({
        agentId,
        accountId: account.accountId,
        openId: openIdLower,
      });
      sessionKey = replaceAgentIdInSessionKey(looksPerPeer ? routeKey : fallback.sessionKey, agentId);
      mainSessionKey = replaceAgentIdInSessionKey(routeMainKey || fallback.mainSessionKey, agentId);
    } catch (err) {
      console.warn(`[wemp:${account.accountId}] resolveAgentRoute failed:`, err);
    }
  }

  if (!sessionKey || !mainSessionKey) {
    const fallback = buildWempSessionKeyFallback({
      agentId,
      accountId: account.accountId,
      openId: openIdLower,
    });
    sessionKey = fallback.sessionKey;
    mainSessionKey = fallback.mainSessionKey;
  }

  console.log(
    `[wemp:${account.accountId}] 路由: agentId=${agentId}, sessionKey=${sessionKey}, mainSessionKey=${mainSessionKey}`,
  );

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
  const commandAuthorized = params.forceCommandAuthorized === true || params.commandAuthorized === true;
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
    CommandAuthorized: commandAuthorized,
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
  const captureReplies = params.captureReplies === true;
  const usageLimitIgnore = params.usageLimitIgnore === true;
  let capturedText = "";
  try {
    const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: any, info: { kind: "tool" | "block" | "final" }) => {
          if (captureReplies) {
            if (info?.kind !== "final") {
              return;
            }
            const piece = String(payload?.text ?? payload?.content ?? "").trim();
            if (piece) {
              capturedText = capturedText ? `${capturedText}\n${piece}` : piece;
            }
            return;
          }
          if (info?.kind !== "final") {
            return;
          }

          // 发送正在输入状态
          sendTypingStatus(account, openId).catch(() => {});

          // 处理文本回复
          let replyText = payload.text || payload.content || "";

          // 从文本中提取图片 URL
          const { text: processedText, imageUrls: extractedImageUrls } =
            processImagesInText(replyText);
          replyText = processedText;

          if (replyText) {
            // 使用 chunkMarkdownText 分块发送长文本
            let chunks: string[];
            if (chunkMarkdownText) {
              try {
                chunks = chunkMarkdownText(replyText, WECHAT_MESSAGE_TEXT_LIMIT);
              } catch {
                chunks = [replyText];
              }
            } else {
              // 简单分块
              chunks = [];
              let remaining = replyText;
              while (remaining.length > 0) {
                chunks.push(remaining.slice(0, WECHAT_MESSAGE_TEXT_LIMIT));
                remaining = remaining.slice(WECHAT_MESSAGE_TEXT_LIMIT);
              }
            }

            let sentTextChunks = 0;
            // 发送每个分块
            for (const chunk of chunks) {
              if (chunk.trim()) {
                await sendCustomMessage(account, openId, chunk);
                sentTextChunks += 1;
              }
            }

            if (!usageLimitIgnore && sentTextChunks > 0) {
              recordUsageLimitOutbound({
                accountId: account.accountId,
                openId,
                text: replyText,
                messageCount: sentTextChunks,
              });
            }
          }

          // 合并 payload 中的媒体 URL 和从文本中提取的图片 URL
          const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const allImageUrls = [...payloadMediaUrls, ...extractedImageUrls];

          // 发送图片（限制数量）
          let imagesSent = 0;
          for (const imageUrl of allImageUrls.slice(0, MAX_IMAGES_PER_MESSAGE)) {
            if (imageUrl) {
              try {
                const result = await sendImageByUrl(account, openId, imageUrl);
                if (!isOk(result)) {
                  console.warn(`[wemp:${account.accountId}] 发送图片失败: ${result.error}`);
                } else {
                  imagesSent += 1;
                }
              } catch (err) {
                console.warn(`[wemp:${account.accountId}] 发送图片异常: ${err}`);
              }
            }
          }
          if (imagesSent > 0) {
            if (!usageLimitIgnore) {
              recordUsageLimitOutbound({
                accountId: account.accountId,
                openId,
                text: "",
                messageCount: imagesSent,
              });
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
    if (!captureReplies) {
      await sendCustomMessage(account, openId, "抱歉，处理消息时出现错误，请稍后再试。");
    }
  }

  return captureReplies ? (capturedText.trim() || undefined) : undefined;
}
