/**
 * 微信公众号 Channel Plugin 类型定义
 */

export interface WechatMpChannelConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  appSecretFile?: string;
  token?: string;
  encodingAESKey?: string;
  name?: string;
  webhookPath?: string;
  accounts?: Record<string, WechatMpAccountConfig>;
  /**
   * Allowlist for who can use `/pair wemp <code>` from other channels.
   * Example: ["telegram:123", "discord:456"].
   */
  pairAllowFrom?: string[];
  // 配对功能配置
  agentPaired?: string;      // 已配对用户使用的 Agent ID
  agentUnpaired?: string;    // 未配对用户使用的 Agent ID
  pairingApiToken?: string;  // 配对 API Token
  // 菜单同步配置
  syncMenu?: boolean;        // 是否启动时同步菜单（默认 false）
  // AI 助手开关相关配置
  welcomeMessage?: string;      // 用户关注后的欢迎消息
  aiEnabledMessage?: string;    // AI 助手开启时的提示消息
  aiDisabledMessage?: string;   // AI 助手关闭时的提示消息
  aiDisabledHint?: string;      // AI 助手关闭状态下收到消息时的提示（设为空字符串可禁用）

  // 业务菜单内容（可选覆盖）
  menuContent?: {
    learnBasic?: string;
    learnAdvanced?: string;
    learnVibe?: string;
    enterprise?: string;
  };

  // 后台菜单“发送文字消息”的值 -> 自定义回复内容
  menuResponses?: Record<string, string>;

  // 菜单中的链接内容
  articlesUrl?: string;
  websiteUrl?: string;
  contactInfo?: string;

  // 使用限制：仅对未配对用户生效（配对用户视为管理员）
  usageLimit?: {
    dailyMessages?: number;
    dailyTokens?: number;
  };

  // 菜单配置（可选）
  menu?: any;
  customMenu?: any;
}

export interface WechatMpAccountConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  appSecretFile?: string;
  token?: string;
  encodingAESKey?: string;
  name?: string;
  webhookPath?: string;
}

export interface ResolvedWechatMpAccount {
  accountId: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  token: string;
  encodingAESKey: string;
  name?: string;
  webhookPath: string;
  secretSource?: "config" | "file" | "env";
  config: WechatMpAccountConfig;
}

export interface WechatMpAccountRuntime {
  accountId: string;
  running: boolean;
  connected: boolean;
  lastConnectedAt: number | null;
  lastError: string | null;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

export interface WechatMpMessage {
  toUserName: string;
  fromUserName: string;
  createTime: string;
  msgType: string;
  content?: string;
  msgId?: string;
  event?: string;
  eventKey?: string;
  picUrl?: string;
  mediaId?: string;
  format?: string;
  recognition?: string;
  thumbMediaId?: string;
  locationX?: string;
  locationY?: string;
  scale?: string;
  label?: string;
  title?: string;
  description?: string;
  url?: string;
}
