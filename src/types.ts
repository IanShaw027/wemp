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
