# 微信公众号渠道插件 (wemp)

<!-- PROJECT SHIELDS -->
<p align="center">
  <a href="https://github.com/IanShaw027/wemp/graphs/contributors"><img src="https://img.shields.io/github/contributors/IanShaw027/wemp.svg?style=flat-square" alt="Contributors"></a>
  <a href="https://github.com/IanShaw027/wemp/network/members"><img src="https://img.shields.io/github/forks/IanShaw027/wemp.svg?style=flat-square" alt="Forks"></a>
  <a href="https://github.com/IanShaw027/wemp/stargazers"><img src="https://img.shields.io/github/stars/IanShaw027/wemp.svg?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/IanShaw027/wemp/issues"><img src="https://img.shields.io/github/issues/IanShaw027/wemp.svg?style=flat-square" alt="Issues"></a>
  <a href="https://github.com/IanShaw027/wemp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/IanShaw027/wemp.svg?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green.svg?style=flat-square" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/OpenClaw-2024.1+-blue.svg?style=flat-square" alt="OpenClaw 2024.1+">
  <img src="https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=flat-square" alt="TypeScript 5.0+">
</p>

<!-- PROJECT DESCRIPTION -->
<p align="center">
  微信公众号 (WeChat Official Account) 渠道插件，支持接收和回复公众号消息。<br>
  支持双 Agent 模式，实现客服与个人助理的灵活切换。
  <br />
  <br />
  <a href="#-快速开始">快速开始</a>
  ·
  <a href="https://github.com/IanShaw027/wemp/issues/new?labels=bug">报告 Bug</a>
  ·
  <a href="https://github.com/IanShaw027/wemp/issues/new?labels=enhancement">功能建议</a>
</p>

---

<!-- TABLE OF CONTENTS -->
<details>
  <summary>目录</summary>
  <ol>
    <li><a href="#-功能特性">功能特性</a></li>
    <li><a href="#-技术栈">技术栈</a></li>
    <li>
      <a href="#-快速开始">快速开始</a>
      <ul>
        <li><a href="#前置条件">前置条件</a></li>
        <li><a href="#安装">安装</a></li>
        <li><a href="#配置">配置</a></li>
      </ul>
    </li>
    <li><a href="#-微信公众号后台配置">微信公众号后台配置</a></li>
    <li><a href="#-配对功能双-agent-模式">配对功能（双 Agent 模式）</a></li>
    <li><a href="#-常见问题">常见问题</a></li>
    <li><a href="#-路线图">路线图</a></li>
    <li><a href="#-贡献指南">贡献指南</a></li>
    <li><a href="#-许可证">许可证</a></li>
    <li><a href="#-联系方式">联系方式</a></li>
    <li><a href="#-致谢">致谢</a></li>
  </ol>
</details>

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **消息接收** | 支持文本、语音（含识别）、图片消息 |
| **客服消息回复** | 通过客服接口回复，无 5 秒超时限制 |
| **安全模式** | 支持明文和 AES 加密两种模式 |
| **长消息处理** | 自动分段发送，避免消息截断 |
| **事件处理** | 关注/取关事件自动处理 |
| **双 Agent 模式** | 客服模式 + 个人助理模式灵活切换 |
| **跨渠道配对** | 通过 Telegram、飞书等渠道配对解锁完整功能 |
| **交互式配置** | 支持命令行配置向导 |

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 技术栈

- [![TypeScript][TypeScript-badge]][TypeScript-url] - 类型安全的 JavaScript
- [![Node.js][Node-badge]][Node-url] - JavaScript 运行时
- [![OpenClaw][OpenClaw-badge]][OpenClaw-url] - AI 助手框架

[TypeScript-badge]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Node-badge]: https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white
[Node-url]: https://nodejs.org/
[OpenClaw-badge]: https://img.shields.io/badge/OpenClaw-FF6B6B?style=for-the-badge
[OpenClaw-url]: https://github.com/openclaw/openclaw

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 快速开始

### 前置条件

在安装此插件之前，请确保你已具备：

- **OpenClaw** 2024.1 或更高版本（[安装指南](https://github.com/openclaw/openclaw)）
- **Node.js** 18.0 或更高版本
- **认证的微信服务号**（订阅号无法使用客服消息接口）
- **HTTPS 域名**（微信公众号要求服务器配置必须是 HTTPS）
- **服务器公网 IP**（需要添加到微信公众号 IP 白名单）

---

## 快速开始

### 安装

```bash
# 进入 extensions 目录
cd ~/.openclaw/extensions

# 克隆项目
git clone https://github.com/IanShaw027/wemp.git wemp

# 安装依赖并编译
cd wemp
npm install
npm run build

# 重启 Gateway 以加载插件
openclaw gateway restart
```

### 方式二：使用 plugins install

```bash
# 从本地路径安装
openclaw plugins install /path/to/wemp

# 或者链接本地开发目录
openclaw plugins install --link /path/to/wemp
```

### 验证安装

```bash
# 查看已加载的插件
openclaw plugins list

# 应该能看到：
# │ 微信公众号 │ wemp │ loaded │ ...
```

## 配置

### 方式一：交互式配置（推荐）

```bash
openclaw configure --section channels
# 选择 wemp，按提示输入配置
```

### 方式二：环境变量

```bash
export WECHAT_MP_APP_ID=wx1234567890abcdef
export WECHAT_MP_APP_SECRET=your_app_secret
export WECHAT_MP_TOKEN=your_token
export WECHAT_MP_ENCODING_AES_KEY=your_aes_key  # 可选，安全模式需要

# 然后运行交互式配置，会自动检测环境变量
openclaw configure --section channels
```

### 方式三：手动编辑配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "wemp": {
      "enabled": true,
      "appId": "wx1234567890abcdef",
      "appSecret": "your_app_secret",
      "token": "your_token",
      "encodingAESKey": "your_aes_key",
      "webhookPath": "/wemp"
    }
  }
}
```

配置完成后重启 Gateway：

```bash
openclaw gateway restart
```

## 微信公众号后台配置

1. 登录 [微信公众平台](https://mp.weixin.qq.com)
2. 「设置与开发」→「基本配置」→「服务器配置」
3. 配置：
   - **URL**: `https://YOUR_DOMAIN/wemp`（必须是 HTTPS）
   - **Token**: 与配置中的 `token` 一致
   - **EncodingAESKey**: 随机生成（可选，安全模式需要）
   - **消息加解密方式**: 明文模式 / 安全模式
4. 配置 IP 白名单（添加你的服务器 IP）
5. 启用服务器配置

### HTTPS 配置

微信公众号要求服务器配置 URL 必须是 HTTPS。推荐使用 nginx 反向代理：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /wemp {
        proxy_pass http://127.0.0.1:18789;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 配置项说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `appId` | string | 是 | 公众号 AppID |
| `appSecret` | string | 是* | AppSecret，与 `appSecretFile` 二选一 |
| `appSecretFile` | string | 是* | AppSecret 文件路径 |
| `token` | string | 是 | 服务器配置 Token |
| `encodingAESKey` | string | 否 | 消息加解密密钥（安全模式需要） |
| `enabled` | boolean | 否 | 是否启用，默认 `true` |
| `name` | string | 否 | 账户显示名称 |
| `webhookPath` | string | 否 | Webhook 路径，默认 `/wemp` |

## 使用

### 启动

```bash
# 后台启动
openclaw gateway restart

# 前台启动（查看日志）
openclaw gateway --port 18789 --verbose
```

### 验证

```bash
# 检查状态
openclaw status

# 应该能看到：
# │ 微信公众号 │ ON │ OK │ ...

# 查看日志
openclaw logs --limit 100
```

## 注意事项

1. **服务号要求**: 客服消息接口需要认证的服务号（订阅号只能被动回复）
2. **48 小时限制**: 用户 48 小时内与公众号有互动才能发送客服消息
3. **IP 白名单**: 需要在公众号后台配置服务器 IP 白名单
4. **HTTPS 必须**: 微信公众号服务器配置 URL 必须是 HTTPS

## 配对功能（双 Agent 模式）

### 概述

wemp 插件支持**双 Agent 模式**，这是一种安全的访问控制机制：

- **未配对用户**：使用功能受限的客服 Agent（如 `wemp-cs`），适合面向公众的基础问答
- **已配对用户**：使用功能完整的个人助理 Agent（如 `main`），可以执行复杂任务

这种设计允许你将微信公众号开放给公众使用，同时保护你的完整 AI 能力只对授权用户开放。

### 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│                        微信公众号用户                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   检查配对状态    │
                    └─────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │    未配对用户     │             │    已配对用户     │
    │  使用 wemp-cs    │             │   使用 main      │
    │  (功能受限)       │             │  (完整功能)       │
    └─────────────────┘             └─────────────────┘
```

### 配对流程详解

#### 第一步：微信用户获取配对码

微信公众号用户发送「配对」或「绑定」，系统返回 6 位数字配对码：

```
用户发送: 配对

系统回复:
配对码: 123456

请在 5 分钟内，通过其他已授权渠道（如 Telegram、QQ）发送以下命令完成配对：

/pair wemp 123456

配对后，你将获得完整的 AI 助手功能。
```

#### 第二步：管理员批准配对

管理员在其他渠道（Telegram、飞书等）发送配对命令：

```
/pair wemp 123456
```

系统验证配对码后，返回成功消息：

```
配对成功！

微信用户已绑定到你的账号。
```

#### 第三步：微信用户收到通知

微信用户会收到配对成功的通知：

```
配对成功！

已与 123456789 绑定。
配对渠道: telegram

现在你可以使用完整的 AI 助手功能了。
```

之后，该微信用户的所有消息都会由 `main` Agent 处理，享有完整功能。

---

### 配置指南

#### 1. 创建双 Agent

在 `~/.openclaw/openclaw.json` 中配置两个 Agent：

```json
{
  "agents": {
    "wemp-cs": {
      "name": "微信客服",
      "model": "claude-3-5-sonnet-20241022",
      "systemPrompt": "你是一个微信公众号客服助手。请简洁友好地回答用户问题。\n\n注意：\n- 你的功能有所限制，无法执行复杂任务\n- 如果用户需要更多功能，请提示他们发送「配对」绑定账号",
      "tools": []
    },
    "main": {
      "name": "个人助理",
      "model": "claude-3-5-sonnet-20241022",
      "systemPrompt": "你是用户的个人 AI 助理，可以帮助用户完成各种任务。",
      "tools": ["*"]
    }
  }
}
```

**Agent 配置建议：**

| Agent | 用途 | 模型建议 | 工具权限 |
|-------|------|----------|----------|
| `wemp-cs` | 客服模式，面向公众 | 较便宜的模型 | 无或受限 |
| `main` | 个人助理，面向授权用户 | 高性能模型 | 完整权限 |

#### 2. 配置 wemp 渠道

在 `~/.openclaw/openclaw.json` 的 `channels.wemp` 中添加完整配置：

```json
{
  "channels": {
    "wemp": {
      "enabled": true,
      "appId": "wx1234567890abcdef",
      "appSecret": "your_app_secret",
      "token": "your_token",
      "encodingAESKey": "your_aes_key",
      "webhookPath": "/wemp",

      "agentPaired": "main",
      "agentUnpaired": "wemp-cs",
      "pairingApiToken": "your-secure-random-token",
      "pairAllowFrom": [
        "123456789",
        "ou_xxxxxxxxxxxxxxxx"
      ]
    }
  }
}
```

#### 3. 配置 `/pair` 命令权限（重要）

`pairAllowFrom` 配置决定了谁可以使用 `/pair` 命令批准配对请求。这是一个安全措施，防止未授权用户自行配对。

```json
{
  "channels": {
    "wemp": {
      "pairAllowFrom": [
        "123456789",
        "ou_xxxxxxxxxxxxxxxx"
      ]
    }
  }
}
```

**配置说明：**

- 数组中的每个元素是一个用户 ID
- 只有这些用户才能使用 `/pair wemp <code>` 命令
- 如果数组为空 `[]`，则使用渠道的默认授权检查
- 支持通配符 `"*"` 允许所有用户（不推荐）

---

### 获取用户 ID

要配置 `pairAllowFrom`，你需要知道自己在各渠道的用户 ID。

#### Telegram

| 方法 | 说明 |
|------|------|
| `/whoami` 命令 | 在 Telegram 机器人中发送 `/whoami` |
| `/status` 命令 | 在 Telegram 机器人中发送 `/status` |
| @userinfobot | 向 [@userinfobot](https://t.me/userinfobot) 发送任意消息 |
| Telegram 设置 | 设置 → 高级 → 实验性功能 → 显示用户 ID |

**Telegram 用户 ID 格式**：纯数字，如 `123456789`

#### 飞书

| 方法 | 说明 |
|------|------|
| `/whoami` 命令 | 在飞书机器人中发送 `/whoami` |
| `/status` 命令 | 在飞书机器人中发送 `/status` |
| 飞书开放平台 | 登录 [open.feishu.cn](https://open.feishu.cn) → 应用后台 → 用户管理 |
| 飞书 API | 通过 API 获取用户信息 |

**飞书用户 ID 格式**：Open ID，如 `ou_xxxxxxxxxxxxxxxx`

#### 微信公众号

| 方法 | 说明 |
|------|------|
| 微信公众平台 | 登录 [mp.weixin.qq.com](https://mp.weixin.qq.com) → 用户管理 → 查看用户详情 |
| 微信 API | 通过公众号 API 获取关注用户列表 |
| Gateway 日志 | 查看 `openclaw logs` 中的用户 ID |

**微信 OpenID 格式**：如 `oXXXX-xxxxxxxxxxxxxxxx`

#### 通用方法

在任意渠道发送一个无效的配对命令，系统会返回你的用户 ID：

```
/pair wemp 000000
```

返回：

```
你没有权限使用此命令。

你的用户 ID: 123456789
渠道: telegram

请将你的用户 ID 添加到配置文件的 channels.wemp.pairAllowFrom 列表中。
```

---

### 用户命令参考

微信公众号用户可以使用以下命令：

| 命令 | 别名 | 说明 |
|------|------|------|
| `配对` | `绑定` | 获取 6 位配对码，有效期 5 分钟 |
| `解除配对` | `取消绑定` | 取消当前配对，恢复客服模式 |
| `状态` | `/status` | 查看当前配对状态和使用的 Agent |

**状态命令返回示例：**

```
当前状态: 完整模式（个人助理）
Agent: main
配对时间: 2024/1/15 14:30:00
配对账号: 123456789
配对渠道: telegram

发送「配对」可以查看配对信息。
```

---

### 配对 API

除了使用 `/pair` 命令，其他系统也可以通过 HTTP API 完成配对：

**请求：**

```http
POST /wemp/api/pair
Content-Type: application/json

{
  "code": "123456",
  "userId": "user123",
  "userName": "张三",
  "channel": "telegram",
  "token": "your-pairing-api-token"
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 6 位配对码 |
| `userId` | string | 是 | 发起配对的用户 ID |
| `userName` | string | 否 | 用户显示名称 |
| `channel` | string | 否 | 发起配对的渠道名称 |
| `token` | string | 是 | 配对 API Token（与 `pairingApiToken` 配置一致） |

**成功响应：**

```json
{
  "success": true,
  "openId": "oXXXX-xxxxxxxxxxxxxxxx"
}
```

**失败响应：**

```json
{
  "error": "Invalid or expired code"
}
```

---

### 配置项参考

#### 配对相关配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `agentPaired` | string | `main` | 已配对用户使用的 Agent ID |
| `agentUnpaired` | string | `wemp-cs` | 未配对用户使用的 Agent ID |
| `pairingApiToken` | string | `wemp-pairing-token` | 配对 API 验证 Token |
| `pairAllowFrom` | string[] | `[]` | 允许使用 `/pair` 命令的用户 ID 列表 |

#### 环境变量（可选）

环境变量会被配置文件中的值覆盖：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEMP_AGENT_PAIRED` | `main` | 已配对用户使用的 Agent ID |
| `WEMP_AGENT_UNPAIRED` | `wemp-cs` | 未配对用户使用的 Agent ID |
| `WEMP_PAIRING_API_TOKEN` | `wemp-pairing-token` | 配对 API 验证 Token |
| `WEMP_DATA_DIR` | `~/.openclaw/data/wemp` | 配对数据存储目录 |

---

### 配对故障排除

#### Q: 发送「配对」没有反应？

1. 检查 Gateway 是否正常运行：`openclaw status`
2. 检查日志是否有错误：`openclaw logs`
3. 确认微信公众号服务器配置正确

#### Q: `/pair` 命令提示没有权限？

1. 检查 `pairAllowFrom` 配置是否包含你的用户 ID
2. 使用通用方法获取你的用户 ID（见上文）
3. 确保用户 ID 格式正确（注意大小写）

#### Q: 配对码已过期？

配对码有效期为 5 分钟。请重新发送「配对」获取新的配对码。

#### Q: 配对成功但仍然使用客服 Agent？

1. 重启 Gateway：`openclaw gateway restart`
2. 检查 `agentPaired` 配置是否正确
3. 查看日志确认配对状态

#### Q: 如何查看已配对的用户？

配对数据存储在 `~/.openclaw/data/wemp/paired-users.json`：

```bash
cat ~/.openclaw/data/wemp/paired-users.json
```

#### Q: 如何手动取消某个用户的配对？

编辑 `~/.openclaw/data/wemp/paired-users.json`，删除对应的用户条目，然后重启 Gateway。

## 常见问题

### Q: 配置后无法收到消息？

1. 检查服务器配置 URL 是否正确（必须是 HTTPS）
2. 检查 Token 是否与公众号后台一致
3. 检查 IP 白名单是否包含服务器 IP
4. 查看日志：`openclaw logs --limit 100`

### Q: 能收到消息但无法回复？

1. 确认是认证的服务号（订阅号无法使用客服消息接口）
2. 检查 AppSecret 是否正确
3. 确认用户在 48 小时内有互动

### Q: 如何使用安全模式？

1. 在公众号后台生成 EncodingAESKey
2. 在配置中添加 `encodingAESKey` 字段
3. 在公众号后台选择「安全模式」

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 路线图

- [x] 基础消息收发
- [x] 客服消息接口
- [x] 安全模式（AES 加密）
- [x] 双 Agent 模式
- [x] 跨渠道配对
- [x] 图片消息接收
- [x] 图片消息回复
- [x] 自定义菜单管理
- [ ] 模板消息支持
- [ ] 多账号支持

查看 [open issues](https://github.com/IanShaw027/wemp/issues) 了解更多计划中的功能和已知问题。

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 贡献指南

贡献是开源社区如此美好的原因。非常感谢你的任何贡献！

1. Fork 本项目
2. 创建你的功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

### 开发指南

```bash
# 克隆项目
git clone https://github.com/IanShaw027/wemp.git
cd wemp

# 安装依赖
npm install

# 编译
npm run build

# 监听模式（开发时使用）
npm run dev
```

### 项目结构

```
wemp/
├── index.ts              # 入口文件，注册插件和 /pair 命令
├── src/
│   ├── api.ts            # 微信 API 封装（access_token、客服消息等）
│   ├── channel.ts        # Channel Plugin 定义
│   ├── config.ts         # 配置解析
│   ├── crypto.ts         # 消息加解密（AES）
│   ├── onboarding.ts     # CLI 配置向导
│   ├── outbound.ts       # 出站消息处理
│   ├── pairing.ts        # 配对功能（生成/验证配对码）
│   ├── runtime.ts        # 运行时状态
│   ├── types.ts          # TypeScript 类型定义
│   └── webhook-handler.ts # Webhook 处理（消息接收和分发）
├── openclaw.plugin.json  # 插件元数据（OpenClaw）
├── clawdbot.plugin.json  # 插件元数据（Clawdbot 兼容）
├── package.json
└── tsconfig.json
```

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 许可证

基于 MIT 许可证分发。查看 `LICENSE` 文件了解更多信息。

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 联系方式

- 邮箱：[admin@kilan.cn](mailto:admin@kilan.cn)
- 项目链接：[https://github.com/IanShaw027/wemp](https://github.com/IanShaw027/wemp)
- 问题反馈：[GitHub Issues](https://github.com/IanShaw027/wemp/issues)

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 致谢

- [OpenClaw](https://github.com/openclaw/openclaw) - AI 助手框架
- [微信公众平台](https://mp.weixin.qq.com) - 微信公众号开发平台
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) - README 模板参考

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>

---

## 相关链接

### OpenClaw 部署与接入指南

- [腾讯云服务器 OpenClaw 一键秒级部署指南](https://cloud.tencent.com/developer/article/2624003) | [视频教程](https://cloud.tencent.com/developer/video/85003)

**其他渠道快速接入指南：**

| 渠道 | 文档链接 |
|------|----------|
| QQ | [快速接入指南](https://cloud.tencent.com/developer/article/2626045) |
| 企业微信 | [快速接入指南](https://cloud.tencent.com/developer/article/2625147) |
| 飞书 | [快速接入指南](https://cloud.tencent.com/developer/article/2626151) |
| 钉钉 | [快速接入指南](https://cloud.tencent.com/developer/article/2625121) |
| Telegram | [快速接入指南](https://cloud.tencent.com/developer/article/2623991) |
| Discord | [快速接入指南](https://cloud.tencent.com/developer/article/2626068) |

### 微信公众号相关

- [微信公众平台](https://mp.weixin.qq.com)
- [微信公众号开发文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)

<p align="right">(<a href="#微信公众号渠道插件-wemp">返回顶部</a>)</p>
