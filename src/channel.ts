/**
 * 微信公众号 Channel Plugin
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ResolvedWechatMpAccount, WechatMpChannelConfig } from "./types.js";
import { listWechatMpAccountIds, resolveWechatMpAccount, applyWechatMpAccountConfig } from "./config.js";
import { sendText } from "./outbound.js";
import { registerWechatMpWebhookTarget, initPairingConfig } from "./webhook-handler.js";
import { wechatMpOnboardingAdapter } from "./onboarding.js";
import { getAccessToken } from "./api.js";

const DEFAULT_ACCOUNT_ID = "default";

export const wechatMpPlugin: ChannelPlugin<ResolvedWechatMpAccount> = {
  id: "wemp",
  meta: {
    id: "wemp",
    label: "微信公众号",
    selectionLabel: "微信公众号",
    docsPath: "/docs/channels/wemp",
    blurb: "通过服务号客服消息接口连接微信",
    order: 60,
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
    textChunkLimit: 600,
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
        initPairingConfig(channelCfg);
      }

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
