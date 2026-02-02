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
