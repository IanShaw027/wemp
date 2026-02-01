# 微信公众号渠道插件 (wemp)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

微信公众号 (WeChat Official Account) 渠道插件，支持接收和回复公众号消息。

## 功能特性

- ✅ 接收公众号文本消息
- ✅ 接收语音消息（支持语音识别转文字）
- ✅ 接收图片消息
- ✅ 通过客服消息接口回复（无 5 秒超时限制）
- ✅ 支持明文和安全模式（AES 加密）
- ✅ 长消息自动分段发送
- ✅ 关注/取关事件处理
- ✅ 交互式配置向导
- ✅ **双 Agent 模式**：客服模式 + 个人助理模式
- ✅ **跨渠道配对**：通过其他渠道（Telegram、QQ 等）配对后解锁完整功能

## 安装

### 方式一：克隆到 extensions 目录（推荐）

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

wemp 支持两种工作模式：

| 模式 | Agent | 说明 |
|------|-------|------|
| 客服模式 | `wemp-cs` | 未配对用户，功能受限 |
| 个人助理模式 | `main` | 已配对用户，完整功能 |

### 配置双 Agent

要使用双 Agent 模式，需要在 OpenClaw/Clawdbot 中配置两个 Agent：

#### 1. 创建客服 Agent（wemp-cs）

编辑 `~/.openclaw/openclaw.json`（或 `~/.clawdbot/clawdbot.json`）：

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

#### 2. Agent 配置说明

| Agent | 用途 | 建议配置 |
|-------|------|----------|
| `wemp-cs` | 客服模式，面向未配对的公众用户 | 限制工具使用，简洁回复 |
| `main` | 个人助理，面向已配对的授权用户 | 完整工具权限 |

#### 3. 在配置文件中设置 Agent ID（推荐）

在 `~/.openclaw/openclaw.json` 的 `channels.wemp` 中添加配置：

```json
{
  "channels": {
    "wemp": {
      "enabled": true,
      "appId": "wx1234567890abcdef",
      "appSecret": "your_app_secret",
      "token": "your_token",
      "agentPaired": "main",
      "agentUnpaired": "wechat-cs",
      "pairingApiToken": "your-secure-token"
    }
  }
}
```

#### 4. 或通过环境变量配置

如果你想使用环境变量而不是配置文件：

```bash
export WEMP_AGENT_PAIRED=main              # 已配对用户使用的 Agent
export WEMP_AGENT_UNPAIRED=wechat-cs       # 未配对用户使用的 Agent
export WEMP_PAIRING_API_TOKEN=your-token   # 配对 API Token
```

### 用户命令

在微信公众号中发送以下命令：

- **配对** / **绑定**：获取 6 位配对码
- **解除配对** / **取消绑定**：取消配对
- **状态** / **/status**：查看当前模式

### 跨渠道配对流程

1. 用户在微信公众号发送「配对」，获取配对码（如 `123456`）
2. 用户在其他已授权渠道（如 Telegram、QQ）发送：`/pair wemp 123456`
3. 配对成功后，用户在微信公众号将使用完整的个人助理功能

### 配对 API

其他渠道可以通过 API 完成配对：

```bash
POST /wemp/api/pair
Content-Type: application/json

{
  "code": "123456",
  "userId": "user123",
  "userName": "张三",
  "channel": "telegram",
  "token": "your-api-token"
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `agentPaired` | string | `main` | 已配对用户使用的 Agent ID |
| `agentUnpaired` | string | `wemp-cs` | 未配对用户使用的 Agent ID |
| `pairingApiToken` | string | `wemp-pairing-token` | 配对 API 验证 Token |

### 环境变量配置（可选）

环境变量会被配置文件中的值覆盖：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEMP_AGENT_PAIRED` | `main` | 已配对用户使用的 Agent ID |
| `WEMP_AGENT_UNPAIRED` | `wemp-cs` | 未配对用户使用的 Agent ID |
| `WEMP_PAIRING_API_TOKEN` | `wemp-pairing-token` | 配对 API 验证 Token |
| `WEMP_DATA_DIR` | `~/.openclaw/data/wemp` | 配对数据存储目录 |

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

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build

# 监听模式
npm run dev
```

## 文件结构

```
wemp/
├── index.ts              # 入口文件
├── src/
│   ├── api.ts            # 微信 API 封装
│   ├── channel.ts        # Channel Plugin 定义
│   ├── config.ts         # 配置解析
│   ├── crypto.ts         # 消息加解密
│   ├── onboarding.ts     # CLI 配置向导
│   ├── outbound.ts       # 出站消息处理
│   ├── pairing.ts        # 配对功能
│   ├── runtime.ts        # 运行时状态
│   ├── types.ts          # 类型定义
│   └── webhook-handler.ts # Webhook 处理
├── openclaw.plugin.json  # 插件元数据（OpenClaw）
├── clawdbot.plugin.json  # 插件元数据（Clawdbot 兼容）
├── package.json
└── tsconfig.json
```

## License

MIT

## 相关链接

### OpenClaw 部署与接入指南

- [腾讯云服务器 OpenClaw 一键秒级部署指南](https://cloud.tencent.com/developer/article/2624003) | [视频教程](https://cloud.tencent.com/developer/video/85003)

**其他渠道快速接入指南：**

- [QQ 快速接入指南](https://cloud.tencent.com/developer/article/2626045)
- [企业微信快速接入指南](https://cloud.tencent.com/developer/article/2625147)
- [飞书快速接入指南](https://cloud.tencent.com/developer/article/2626151)
- [钉钉快速接入指南](https://cloud.tencent.com/developer/article/2625121)
- [Telegram 快速接入指南](https://cloud.tencent.com/developer/article/2623991)
- [Discord 快速接入指南](https://cloud.tencent.com/developer/article/2626068)

### 微信公众号相关

- [微信公众平台](https://mp.weixin.qq.com)
- [微信公众号开发文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
