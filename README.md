# 微信公众号渠道插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

微信公众号 (WeChat Official Account) 的 Clawdbot 渠道插件，支持接收和回复公众号消息。

## 功能特性

- ✅ 接收公众号文本消息
- ✅ 接收语音消息（支持语音识别转文字）
- ✅ 接收图片消息
- ✅ 通过客服消息接口回复（无 5 秒超时限制）
- ✅ 支持明文和安全模式（AES 加密）
- ✅ 长消息自动分段发送
- ✅ 关注/取关事件处理
- ✅ 交互式配置向导

## 安装

### 方式一：克隆到 extensions 目录（推荐）

```bash
# 进入 extensions 目录
cd ~/.clawdbot/extensions

# 克隆项目
git clone https://github.com/YOUR_USERNAME/wechat-mp.git

# 安装依赖并编译
cd wechat-mp
npm install
npm run build

# 重启 Gateway 以加载插件
clawdbot gateway restart
```

### 方式二：使用 plugins install

```bash
# 从本地路径安装
clawdbot plugins install /path/to/wechat-mp

# 或者链接本地开发目录
clawdbot plugins install --link /path/to/wechat-mp
```

### 验证安装

```bash
# 查看已加载的插件
clawdbot plugins list

# 应该能看到：
# │ 微信公众号 │ wechat-mp │ loaded │ ...
```

## 配置

### 方式一：交互式配置（推荐）

```bash
clawdbot configure --section channels
# 选择 wechat-mp，按提示输入配置
```

### 方式二：环境变量

```bash
export WECHAT_MP_APP_ID=wx1234567890abcdef
export WECHAT_MP_APP_SECRET=your_app_secret
export WECHAT_MP_TOKEN=your_token
export WECHAT_MP_ENCODING_AES_KEY=your_aes_key  # 可选，安全模式需要

# 然后运行交互式配置，会自动检测环境变量
clawdbot configure --section channels
```

### 方式三：手动编辑配置

编辑 `~/.clawdbot/clawdbot.json`：

```json
{
  "channels": {
    "wechat-mp": {
      "enabled": true,
      "appId": "wx1234567890abcdef",
      "appSecret": "your_app_secret",
      "token": "your_token",
      "encodingAESKey": "your_aes_key",
      "webhookPath": "/wechat-mp/webhook"
    }
  }
}
```

配置完成后重启 Gateway：

```bash
clawdbot gateway restart
```

## 微信公众号后台配置

1. 登录 [微信公众平台](https://mp.weixin.qq.com)
2. 「设置与开发」→「基本配置」→「服务器配置」
3. 配置：
   - **URL**: `https://YOUR_DOMAIN/wechat-mp/webhook`（必须是 HTTPS）
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

    location /wechat-mp/ {
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
| `webhookPath` | string | 否 | Webhook 路径，默认 `/wechat-mp/webhook` |

## 使用

### 启动

```bash
# 后台启动
clawdbot gateway restart

# 前台启动（查看日志）
clawdbot gateway --port 18789 --verbose
```

### 验证

```bash
# 检查状态
clawdbot channels status

# 应该能看到：
# - 微信公众号 default: enabled, configured, running, connected

# 查看日志
clawdbot channels logs --channel wechat-mp
```

## 多账户支持

```json
{
  "channels": {
    "wechat-mp": {
      "enabled": true,
      "appId": "默认账户 AppID",
      "appSecret": "默认账户 AppSecret",
      "token": "默认账户 Token",
      "accounts": {
        "account2": {
          "enabled": true,
          "appId": "第二个账户 AppID",
          "appSecret": "第二个账户 AppSecret",
          "token": "第二个账户 Token",
          "webhookPath": "/wechat-mp/webhook/account2"
        }
      }
    }
  }
}
```

## 注意事项

1. **服务号要求**: 客服消息接口需要认证的服务号（订阅号只能被动回复）
2. **48 小时限制**: 用户 48 小时内与公众号有互动才能发送客服消息
3. **IP 白名单**: 需要在公众号后台配置服务器 IP 白名单
4. **HTTPS 必须**: 微信公众号服务器配置 URL 必须是 HTTPS

## 常见问题

### Q: 配置后无法收到消息？

1. 检查服务器配置 URL 是否正确（必须是 HTTPS）
2. 检查 Token 是否与公众号后台一致
3. 检查 IP 白名单是否包含服务器 IP
4. 查看日志：`clawdbot channels logs --channel wechat-mp`

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
wechat-mp/
├── index.ts              # 入口文件
├── src/
│   ├── api.ts            # 微信 API 封装
│   ├── channel.ts        # Channel Plugin 定义
│   ├── config.ts         # 配置解析
│   ├── crypto.ts         # 消息加解密
│   ├── onboarding.ts     # CLI 配置向导
│   ├── outbound.ts       # 出站消息处理
│   ├── runtime.ts        # 运行时状态
│   ├── types.ts          # 类型定义
│   └── webhook-handler.ts # Webhook 处理
├── clawdbot.plugin.json  # 插件元数据
├── package.json
└── tsconfig.json
```

## License

MIT

## 相关链接

- [微信公众平台](https://mp.weixin.qq.com)
- [微信公众号开发文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
- [Clawdbot 文档](https://docs.clawd.bot)
