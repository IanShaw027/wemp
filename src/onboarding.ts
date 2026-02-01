/**
 * 微信公众号 CLI Onboarding Adapter
 */
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingStatus,
  ChannelOnboardingStatusContext,
  ChannelOnboardingConfigureContext,
  ChannelOnboardingResult,
} from "clawdbot/plugin-sdk";
import { listWechatMpAccountIds, resolveWechatMpAccount } from "./config.js";

const DEFAULT_ACCOUNT_ID = "default";

interface MoltbotConfig {
  channels?: {
    "wechat-mp"?: any;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * 微信公众号 Onboarding Adapter
 */
export const wechatMpOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "wechat-mp" as any,

  getStatus: async (ctx: ChannelOnboardingStatusContext): Promise<ChannelOnboardingStatus> => {
    const { cfg } = ctx;
    const configured = listWechatMpAccountIds(cfg as MoltbotConfig).some((accountId) => {
      const account = resolveWechatMpAccount(cfg as MoltbotConfig, accountId);
      return Boolean(account.appId && account.appSecret && account.token);
    });

    return {
      channel: "wechat-mp" as any,
      configured,
      statusLines: [`微信公众号: ${configured ? "已配置" : "需要 AppID、AppSecret 和 Token"}`],
      selectionHint: configured ? "已配置" : "支持服务号客服消息",
      quickstartScore: configured ? 1 : 30,
    };
  },

  configure: async (ctx: ChannelOnboardingConfigureContext): Promise<ChannelOnboardingResult> => {
    const { cfg, prompter, accountOverrides, shouldPromptAccountIds } = ctx;
    const moltbotCfg = cfg as MoltbotConfig;

    const override = (accountOverrides as Record<string, string>)["wechat-mp"]?.trim();
    let accountId = override ?? DEFAULT_ACCOUNT_ID;

    // 是否需要提示选择账户
    if (shouldPromptAccountIds && !override) {
      const existingIds = listWechatMpAccountIds(moltbotCfg);
      if (existingIds.length > 1) {
        accountId = await prompter.select({
          message: "选择微信公众号账户",
          options: existingIds.map((id) => ({
            value: id,
            label: id === DEFAULT_ACCOUNT_ID ? "默认账户" : id,
          })),
          initialValue: accountId,
        });
      }
    }

    let next = moltbotCfg;
    const resolvedAccount = resolveWechatMpAccount(next, accountId);
    const accountConfigured = Boolean(resolvedAccount.appId && resolvedAccount.appSecret && resolvedAccount.token);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const envAppId = typeof process !== "undefined" ? process.env?.WECHAT_MP_APP_ID?.trim() : undefined;
    const envSecret = typeof process !== "undefined" ? process.env?.WECHAT_MP_APP_SECRET?.trim() : undefined;
    const envToken = typeof process !== "undefined" ? process.env?.WECHAT_MP_TOKEN?.trim() : undefined;
    const canUseEnv = allowEnv && Boolean(envAppId && envSecret && envToken);
    const hasConfigCredentials = Boolean(
      resolvedAccount.config.appId && resolvedAccount.config.appSecret && resolvedAccount.config.token
    );

    let appId: string | null = null;
    let appSecret: string | null = null;
    let token: string | null = null;
    let encodingAESKey: string | null = null;

    // 显示帮助
    if (!accountConfigured) {
      await prompter.note(
        [
          "1) 登录微信公众平台: https://mp.weixin.qq.com/",
          "2) 进入「开发」→「基本配置」",
          "3) 获取 AppID 和 AppSecret",
          "4) 设置服务器配置（URL、Token、EncodingAESKey）",
          "",
          "注意: 需要已认证的服务号才能使用客服消息接口",
          "",
          "环境变量: WECHAT_MP_APP_ID, WECHAT_MP_APP_SECRET, WECHAT_MP_TOKEN",
        ].join("\n"),
        "微信公众号配置"
      );
    }

    // 检测环境变量
    if (canUseEnv && !hasConfigCredentials) {
      const keepEnv = await prompter.confirm({
        message: "检测到环境变量，是否使用？",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            "wechat-mp": {
              ...next.channels?.["wechat-mp"],
              enabled: true,
            },
          },
        };
      } else {
        // 手动输入
        ({ appId, appSecret, token, encodingAESKey } = await promptCredentials(prompter, resolvedAccount));
      }
    } else if (hasConfigCredentials) {
      // 已有配置
      const keep = await prompter.confirm({
        message: "微信公众号已配置，是否保留当前配置？",
        initialValue: true,
      });
      if (!keep) {
        ({ appId, appSecret, token, encodingAESKey } = await promptCredentials(prompter, resolvedAccount));
      }
    } else {
      // 没有配置，需要输入
      ({ appId, appSecret, token, encodingAESKey } = await promptCredentials(prompter, resolvedAccount));
    }

    // 应用配置
    if (appId && appSecret && token) {
      const updates: any = {
        enabled: true,
        appId,
        appSecret,
        token,
      };
      if (encodingAESKey) {
        updates.encodingAESKey = encodingAESKey;
      }

      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            "wechat-mp": {
              ...next.channels?.["wechat-mp"],
              ...updates,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            "wechat-mp": {
              ...next.channels?.["wechat-mp"],
              enabled: true,
              accounts: {
                ...next.channels?.["wechat-mp"]?.accounts,
                [accountId]: {
                  ...next.channels?.["wechat-mp"]?.accounts?.[accountId],
                  ...updates,
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next as any, accountId };
  },

  disable: (cfg) =>
    ({
      ...cfg,
      channels: {
        ...(cfg as MoltbotConfig).channels,
        "wechat-mp": { ...(cfg as MoltbotConfig).channels?.["wechat-mp"], enabled: false },
      },
    }) as any,
};

async function promptCredentials(
  prompter: any,
  resolvedAccount: any
): Promise<{
  appId: string | null;
  appSecret: string | null;
  token: string | null;
  encodingAESKey: string | null;
}> {
  const appId = String(
    await prompter.text({
      message: "请输入 AppID",
      placeholder: "例如: wx1234567890abcdef",
      initialValue: resolvedAccount.appId || undefined,
      validate: (value: string) => (value?.trim() ? undefined : "AppID 不能为空"),
    })
  ).trim();

  const appSecret = String(
    await prompter.text({
      message: "请输入 AppSecret",
      placeholder: "你的 AppSecret",
      validate: (value: string) => (value?.trim() ? undefined : "AppSecret 不能为空"),
    })
  ).trim();

  const token = String(
    await prompter.text({
      message: "请输入 Token（服务器配置中的令牌）",
      placeholder: "例如: mytoken",
      initialValue: resolvedAccount.token || undefined,
      validate: (value: string) => (value?.trim() ? undefined : "Token 不能为空"),
    })
  ).trim();

  const useEncrypt = await prompter.confirm({
    message: "是否使用安全模式（消息加解密）？",
    initialValue: Boolean(resolvedAccount.encodingAESKey),
  });

  let encodingAESKey: string | null = null;
  if (useEncrypt) {
    encodingAESKey = String(
      await prompter.text({
        message: "请输入 EncodingAESKey",
        placeholder: "43 位字符",
        initialValue: resolvedAccount.encodingAESKey || undefined,
        validate: (value: string) => {
          if (!value?.trim()) return "EncodingAESKey 不能为空";
          if (value.trim().length !== 43) return "EncodingAESKey 应为 43 位字符";
          return undefined;
        },
      })
    ).trim();
  }

  return { appId, appSecret, token, encodingAESKey };
}
