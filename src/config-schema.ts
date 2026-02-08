/**
 * wemp 插件配置 JSON Schema
 * 用于配置校验和 Control UI 表单生成
 *
 * 兼容策略：
 * - 保持与现有运行时代码和 README 配置项一致
 * - 对已存在配置字段保持向后兼容，避免升级后配置被拒绝
 */
import { Type, type Static } from "@sinclair/typebox";

const MenuButtonSchema = Type.Object(
  {
    name: Type.String({ description: "菜单名称" }),
    type: Type.Optional(Type.String({ description: "菜单类型" })),
    key: Type.Optional(Type.String({ description: "菜单 key" })),
    url: Type.Optional(Type.String({ description: "跳转 URL" })),
    sub_button: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ description: "子菜单名称" }),
          type: Type.String({ description: "子菜单类型" }),
          key: Type.Optional(Type.String({ description: "子菜单 key" })),
          url: Type.Optional(Type.String({ description: "子菜单跳转 URL" })),
        }, { additionalProperties: true })
      )
    ),
  },
  { additionalProperties: true }
);

const AccountSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "是否启用该账号", default: true })),
    appId: Type.Optional(Type.String({ description: "公众号 AppID" })),
    appSecret: Type.Optional(
      Type.String({
        description: "公众号 AppSecret",
        format: "password",
      })
    ),
    appSecretFile: Type.Optional(Type.String({ description: "AppSecret 文件路径" })),
    token: Type.Optional(Type.String({ description: "消息校验 Token" })),
    encodingAESKey: Type.Optional(Type.String({ description: "消息加解密密钥（43位）" })),
    webhookPath: Type.Optional(Type.String({ description: "Webhook 路径", default: "/wemp" })),
    name: Type.Optional(Type.String({ description: "账号名称" })),
  },
  { additionalProperties: false }
);

export const WempConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "是否启用微信公众号渠道", default: false })),

    appId: Type.Optional(Type.String({ description: "公众号 AppID" })),
    appSecret: Type.Optional(
      Type.String({
        description: "公众号 AppSecret",
        format: "password",
      })
    ),
    appSecretFile: Type.Optional(Type.String({ description: "AppSecret 文件路径" })),
    token: Type.Optional(Type.String({ description: "消息校验 Token" })),
    encodingAESKey: Type.Optional(Type.String({ description: "消息加解密密钥（43位）" })),
    EncodingAESKey: Type.Optional(Type.String({ description: "兼容字段：消息加解密密钥（43位）" })),
    webhookPath: Type.Optional(Type.String({ description: "Webhook 路径", default: "/wemp" })),
    name: Type.Optional(Type.String({ description: "账号名称（用于多账号区分）" })),

    accounts: Type.Optional(
      Type.Record(Type.String(), AccountSchema, {
        description: "多账号配置",
      })
    ),

    // 配对与 Agent 配置（当前代码实际使用）
    agentPaired: Type.Optional(Type.String({ description: "已配对用户使用的 Agent ID", default: "main" })),
    agentUnpaired: Type.Optional(Type.String({ description: "未配对用户使用的 Agent ID", default: "wemp-cs" })),
    pairingApiToken: Type.Optional(Type.String({ description: "配对 API Token", format: "password" })),

    // 菜单与文案配置
    syncMenu: Type.Optional(Type.Boolean({ description: "启动时是否同步自定义菜单", default: false })),
    menu: Type.Optional(
      Type.Object(
        {
          button: Type.Array(MenuButtonSchema),
        },
        { description: "自定义菜单配置", additionalProperties: true }
      )
    ),
    customMenu: Type.Optional(Type.Any({ description: "自定义菜单第三栏配置" })),

    menuContent: Type.Optional(
      Type.Object(
        {
          learnBasic: Type.Optional(Type.String({ description: "基础学习内容" })),
          learnAdvanced: Type.Optional(Type.String({ description: "进阶学习内容" })),
          learnVibe: Type.Optional(Type.String({ description: "Vibe 学习内容" })),
          enterprise: Type.Optional(Type.String({ description: "企业服务内容" })),
        },
        { description: "菜单静态文案配置", additionalProperties: false }
      )
    ),
    menuResponses: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "菜单 key 到回复文案映射",
      })
    ),

    welcomeMessage: Type.Optional(Type.String({ description: "关注后的欢迎消息" })),
    aiEnabledMessage: Type.Optional(Type.String({ description: "AI 助手开启提示" })),
    aiDisabledMessage: Type.Optional(Type.String({ description: "AI 助手关闭提示" })),
    aiDisabledHint: Type.Optional(Type.String({ description: "AI 关闭状态提示（空字符串可禁用）" })),

    articlesUrl: Type.Optional(Type.String({ description: "历史文章链接" })),
    websiteUrl: Type.Optional(Type.String({ description: "官网链接" })),
    contactInfo: Type.Optional(Type.String({ description: "联系信息" })),

    // 使用限制（兼容现有字段）
    usageLimit: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean({ description: "是否启用限制", default: false })),
          dailyMessages: Type.Optional(Type.Number({ description: "每日消息上限（0=不限）", default: 0 })),
          dailyTokens: Type.Optional(Type.Number({ description: "每日 Token 上限（0=不限）", default: 0 })),
          // 保留新增字段，避免已写入的新配置失效
          dailyLimit: Type.Optional(Type.Number({ description: "兼容字段：每日上限" })),
          monthlyLimit: Type.Optional(Type.Number({ description: "兼容字段：每月上限" })),
        },
        { description: "使用限制配置", additionalProperties: false }
      )
    ),

    // 保留 PR 中新增但当前代码未使用的策略字段，避免破坏已有尝试
    dmPolicy: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("pairing"), Type.Literal("allowlist")], {
        description: "私聊策略：open-开放 pairing-需配对 allowlist-白名单",
        default: "pairing",
      })
    ),
    allowFrom: Type.Optional(Type.Array(Type.String(), { description: "白名单用户 OpenID 列表" })),
    csAgent: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean({ description: "是否启用客服 Agent", default: true })),
          agentId: Type.Optional(Type.String({ description: "客服 Agent ID", default: "wechat-cs" })),
          model: Type.Optional(Type.String({ description: "客服 Agent 使用模型" })),
          systemPrompt: Type.Optional(Type.String({ description: "客服 Agent 系统提示词" })),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export type WempConfig = Static<typeof WempConfigSchema>;

/**
 * UI Hints for Control UI
 */
export const WempConfigUiHints = {
  appId: {
    label: "AppID",
    placeholder: "wx1234567890abcdef",
  },
  appSecret: {
    label: "AppSecret",
    placeholder: "YOUR_API_KEY_HERE",
    sensitive: true,
  },
  appSecretFile: {
    label: "AppSecret 文件路径",
    placeholder: "/path/to/app-secret.txt",
  },
  token: {
    label: "消息校验 Token",
    placeholder: "YOUR_TOKEN_HERE",
    sensitive: true,
  },
  encodingAESKey: {
    label: "加密密钥",
    placeholder: "43位字符",
    sensitive: true,
  },
  webhookPath: {
    label: "Webhook 路径",
    placeholder: "/wemp",
  },
  agentPaired: {
    label: "已配对 Agent ID",
    placeholder: "main",
  },
  agentUnpaired: {
    label: "未配对 Agent ID",
    placeholder: "wemp-cs",
  },
  pairingApiToken: {
    label: "配对 API Token",
    placeholder: "YOUR_TOKEN_HERE",
    sensitive: true,
  },
  syncMenu: {
    label: "启动时同步菜单",
  },
  "usageLimit.dailyMessages": {
    label: "每日消息上限",
  },
  "usageLimit.dailyTokens": {
    label: "每日 Token 上限",
  },
  dmPolicy: {
    label: "私聊策略",
    options: [
      { value: "open", label: "开放（所有人可用）" },
      { value: "pairing", label: "配对（需要配对码）" },
      { value: "allowlist", label: "白名单（仅指定用户）" },
    ],
  },
  "csAgent.enabled": {
    label: "启用客服 Agent",
  },
  "csAgent.agentId": {
    label: "客服 Agent ID",
  },
} as const;
