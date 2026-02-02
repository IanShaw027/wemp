/**
 * 微信公众号 Channel Plugin
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ResolvedWechatMpAccount, WechatMpChannelConfig } from "./types.js";
import { listWechatMpAccountIds, resolveWechatMpAccount, applyWechatMpAccountConfig } from "./config.js";
import { sendText } from "./outbound.js";
import { registerWechatMpWebhookTarget, initPairingConfig, setStoredConfig } from "./webhook-handler.js";
import { wechatMpOnboardingAdapter } from "./onboarding.js";
import { getAccessToken, sendCustomMessage } from "./api.js";
import { parseSubjectId, recordApprovedSubjectId, setOptOut } from "./pairing.js";
import { logWarn } from "./log.js";
import { WECHAT_MESSAGE_TEXT_LIMIT } from "./constants.js";

const DEFAULT_ACCOUNT_ID = "default";

// 配对成功消息
const PAIRING_APPROVED_MESSAGE = "🎉 配对成功！你现在可以使用完整的 AI 助手功能了。";

// openclaw/plugin-sdk's ChannelPlugin type doesn't currently include the optional `pairing` field,
// but OpenClaw supports it in runtime. Keep it as an intersection to avoid widening the sdk .d.ts.
export const wechatMpPlugin: ChannelPlugin<ResolvedWechatMpAccount> & { pairing?: any } = {
  id: "wemp",
  meta: {
    id: "wemp",
    label: "微信公众号",
    selectionLabel: "微信公众号 (plugin)",
    docsPath: "/channels/wemp",
    blurb: "通过服务号客服消息接口连接微信",
    order: 86,
  },
  // 配对支持 - 让 OpenClaw CLI 能够识别 wemp 渠道
  pairing: {
    idLabel: "wempOpenId",
    normalizeAllowEntry: (entry: string) => entry.replace(/^wemp:/i, ""),
    notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
      // OpenClaw pairing-store calls notify with the approved sender id (not the code).
      // For wemp, we store sender id as `${accountId}:${openId}`.
      const parsed = parseSubjectId(id);
      const account =
        resolveWechatMpAccount(cfg, parsed.accountId) ?? resolveWechatMpAccount(cfg, DEFAULT_ACCOUNT_ID);
      if (!account?.appId) {
        throw new Error("wemp not configured");
      }
      if (!parsed.openId) {
        throw new Error("wemp notifyApproval missing openId");
      }

      await sendCustomMessage(account, parsed.openId, PAIRING_APPROVED_MESSAGE);

      // Ensure subsequent inbound checks observe the approval quickly (process-local cache),
      // and clear local opt-out so the user enters paired-mode immediately.
      try {
        recordApprovedSubjectId(id);
      } catch (err) {
        logWarn(`[wemp:${parsed.accountId}] recordApprovedSubjectId failed: ${String(err)}`);
      }
      try {
        setOptOut(parsed.accountId, parsed.openId, false);
      } catch (err) {
        logWarn(`[wemp:${parsed.accountId}] setOptOut(false) failed: ${String(err)}`);
      }
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.wemp"] },
  // CLI onboarding wizard
  onboarding: wechatMpOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listWechatMpAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWechatMpAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account?.appId && account?.appSecret && account?.token),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.appSecret && account?.token),
      tokenSource: account?.secretSource,
    }),
  },
  setup: {
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "微信公众号需要 --token (格式: appId:appSecret:token) 或 --use-env";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let appSecret = "";
      let token = "";

      if (input.token) {
        const parts = input.token.split(":");
        if (parts.length >= 3) {
          appId = parts[0];
          appSecret = parts[1];
          token = parts[2];
        }
      }

      return applyWechatMpAccountConfig(cfg, accountId, {
        appId,
        appSecret,
        token,
        name: input.name,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: WECHAT_MESSAGE_TEXT_LIMIT,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveWechatMpAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      const result = await sendText({ to, text, accountId: accountId ?? DEFAULT_ACCOUNT_ID, replyToId, account });
      return {
        channel: "wemp",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[wemp:${account.accountId}] Starting gateway (Webhook mode)`);

      // 初始化配对配置
      const channelCfg = cfg?.channels?.wemp as WechatMpChannelConfig | undefined;
      if (channelCfg) {
        initPairingConfig(account.accountId, channelCfg);
      }

      // 存储配置引用
      setStoredConfig(cfg);

      // 验证配置
      if (!account.appId || !account.appSecret || !account.token) {
        log?.error(`[wemp:${account.accountId}] Missing required config (appId, appSecret, token)`);
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: "Missing required config",
        });
        return;
      }

      // 预热 access_token
      try {
        await getAccessToken(account);
        log?.info(`[wemp:${account.accountId}] Access token obtained`);
      } catch (err) {
        log?.warn(`[wemp:${account.accountId}] Failed to get access token: ${err}`);
      }

      // 注册 webhook
      const webhookPath = account.webhookPath;
      const unregister = registerWechatMpWebhookTarget({
        account,
        path: webhookPath,
        cfg,
      });

      log?.info(`[wemp:${account.accountId}] Webhook registered at ${webhookPath}`);
      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
      });

      // 等待 abort 信号
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log?.info(`[wemp:${account.accountId}] Unregistering webhook...`);
          unregister();
          resolve();
        });
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.appSecret && account?.token),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
