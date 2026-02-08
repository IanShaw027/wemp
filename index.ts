import type { OpenclawPluginApi } from "openclaw/plugin-sdk";
import { wechatMpPlugin } from "./src/channel.js";
import { logError, logInfo, logWarn } from "./src/log.js";
import { setWechatMpRuntime } from "./src/runtime.js";
import { handleWechatMpWebhookRequest } from "./src/webhook-handler.js";
import { sendCustomMessage, createMenu, deleteMenu, getMenu, createMenuFromConfig, syncMenuWithAiAssistant } from "./src/api.js";
import { resolveWechatMpAccount } from "./src/config.js";
import { registerWempTools } from "./src/tools.js";
import { WempConfigSchema, WempConfigUiHints } from "./src/config-schema.js";

const plugin = {
  id: "wemp",
  name: "微信公众号",
  description: "微信公众号渠道插件 (服务号客服消息)",
  configSchema: {
    schema: WempConfigSchema,
    uiHints: WempConfigUiHints,
  },
  register(api: OpenclawPluginApi) {
    setWechatMpRuntime(api.runtime);
    api.registerChannel({ plugin: wechatMpPlugin });
    api.registerHttpHandler(handleWechatMpWebhookRequest);

    // 注册 Agent 工具
    registerWempTools(api);
    logInfo(api.runtime, "[wemp] Registered 7 agent tools: wemp_draft, wemp_publish, wemp_comment, wemp_stats, wemp_user, wemp_qrcode, wemp_template");

    // 启动时同步菜单（异步执行，不阻塞启动）
    // 只有显式开启 syncMenu: true 才会同步
    // 注意：syncMenuWithAiAssistant 内部已有日志输出，这里不再重复输出
    const cfg = (api as any).config;
    const wempCfg = cfg?.channels?.wemp;
    if (wempCfg?.enabled && wempCfg?.syncMenu === true) {
      setImmediate(async () => {
        try {
          const account = resolveWechatMpAccount(cfg, "default");
          if (account) {
            await syncMenuWithAiAssistant(account, cfg);
          }
        } catch (err) {
          logError(api.runtime, `[wemp:default] 菜单同步失败:`, err);
        }
      });
    }

    const registerCommand = (api as any).registerCommand as undefined | ((command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      requireAuth?: boolean;
      handler: (ctx: {
        senderId?: string;
        channel?: string;
        args?: string;
        config?: any;
        isAuthorizedSender?: boolean;
      }) => Promise<{ text: string }>;
    }) => void);

    if (!registerCommand) {
      logWarn(api.runtime, "[wemp] registerCommand not available in this OpenClaw runtime; /pair and /wemp-menu will be disabled.");
      return;
    }

    // 注册 /pair 命令，用于跨渠道配对
    registerCommand({
      name: "pair",
      description: "批准微信公众号配对请求 (用法: /pair wemp <配对码>)",
      acceptsArgs: true,
      requireAuth: false,  // 不使用内置授权检查，我们自己检查
      handler: async (ctx) => {
        const args = ctx.args?.trim() || "";
        const parts = args.split(/\s+/);

        // 检查是否是授权用户（只有主会话的授权用户才能批准配对）
        if (!ctx.isAuthorizedSender) {
          return {
            text: `⚠️ 你没有权限使用此命令。\n\n` +
              `你的用户 ID: ${ctx.senderId || "unknown"}\n` +
              `渠道: ${ctx.channel || "unknown"}\n\n` +
              `只有主会话的授权用户才能使用此命令。`,
          };
        }

        // 检查参数格式
        if (parts.length < 2) {
          return {
            text: "用法: /pair wemp <配对码>\n\n" +
              "请先在微信公众号中发送「配对」获取配对码，然后在这里使用该命令完成配对。",
          };
        }

        const channel = parts[0].toLowerCase();
        const codeRaw = parts[1];

        // 只处理 wemp 渠道
        if (channel !== "wemp" && channel !== "wechat") {
          return {
            text: `不支持的渠道: ${channel}\n\n此命令仅支持 wemp (微信公众号) 渠道。`,
          };
        }

        const code = String(codeRaw ?? "").trim().toUpperCase();
        if (!code) {
          return { text: "配对码不能为空。" };
        }

        const runCommandWithTimeout = (api as any)?.runtime?.system?.runCommandWithTimeout as
          | undefined
          | ((argv: string[], opts: any) => Promise<{ stdout: string; stderr: string; code: number | null }>);
        if (typeof runCommandWithTimeout !== "function") {
          return {
            text: "⚠️ 当前 OpenClaw runtime 不支持执行 CLI 命令，无法使用 /pair 自动批准。\n\n" +
              `请在服务器上手动执行：openclaw pairing approve --channel wemp ${code} --notify`,
          };
        }

        // 通过 OpenClaw CLI 批准 pairing code（会写入 allowFrom store，并触发 --notify 回调）
        const result = await runCommandWithTimeout(
          ["openclaw", "pairing", "approve", "--channel", "wemp", code, "--notify"],
          { timeoutMs: 15_000 },
        );

        if (result?.code && result.code !== 0) {
          const stderr = String(result.stderr ?? "").trim();
          return {
            text: `❌ 批准失败（code=${result.code}）。\n\n` +
              (stderr ? `错误信息：\n${stderr}\n\n` : "") +
              `你可以在服务器上重试：openclaw pairing approve --channel wemp ${code} --notify`,
          };
        }

        return {
          text: `✅ 已批准配对请求。\n\n如果你使用了 --notify，公众号用户会收到配对成功通知。`,
        };
      },
    });

    // 注册 /wemp-menu 命令，用于管理自定义菜单
    registerCommand({
      name: "wemp-menu",
      description: "管理微信公众号自定义菜单 (用法: /wemp-menu create|delete|get)",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() || "";
        const action = args.split(/\s+/)[0]?.toLowerCase();
        const cfg = ctx.config || (api as any).config;
        const account = resolveWechatMpAccount(cfg, "default");

        if (!account) {
          return { text: "❌ 微信公众号未配置。" };
        }

        switch (action) {
          case "create": {
            // 从配置读取菜单，支持自定义
            const menu = createMenuFromConfig(cfg);
            const result = await createMenu(account, menu);
            if (result.success) {
              // 生成菜单结构描述
              const menuDesc = menu.button.map((btn, i) => {
                const prefix = i === menu.button.length - 1 ? "└─" : "├─";
                const childPrefix = i === menu.button.length - 1 ? "   " : "│  ";
                let desc = `${prefix} ${btn.name}\n`;
                if (btn.sub_button) {
                  btn.sub_button.forEach((sub, j) => {
                    const subPrefix = j === btn.sub_button!.length - 1 ? "└─" : "├─";
                    const typeHint = sub.type === "view" ? `(${sub.url})` : sub.key ? `(${sub.key})` : "";
                    desc += `${childPrefix}${subPrefix} ${sub.name} ${typeHint}\n`;
                  });
                }
                return desc;
              }).join("");

              return {
                text: "✅ 自定义菜单创建成功！\n\n" +
                  "菜单结构：\n" +
                  menuDesc + "\n" +
                  "注意：取消关注再重新关注可立即看到新菜单，或等待最多 24 小时自动更新。",
              };
            } else {
              return { text: `❌ 创建菜单失败: ${result.error}` };
            }
          }

          case "delete": {
            const result = await deleteMenu(account);
            if (result.success) {
              return { text: "✅ 自定义菜单已删除。" };
            } else {
              return { text: `❌ 删除菜单失败: ${result.error}` };
            }
          }

          case "get": {
            const result = await getMenu(account);
            if (result.success) {
              return {
                text: "当前菜单配置：\n\n" +
                  "```json\n" +
                  JSON.stringify(result.menu, null, 2) +
                  "\n```",
              };
            } else {
              return { text: `❌ 获取菜单失败: ${result.error}` };
            }
          }

          default:
            return {
              text: "用法: /wemp-menu <action>\n\n" +
                "可用操作：\n" +
                "• create - 创建菜单（从配置读取或使用默认）\n" +
                "• delete - 删除自定义菜单\n" +
                "• get    - 查看当前菜单配置\n\n" +
                "自定义菜单配置示例（openclaw.json）：\n" +
                "channels.wemp.menu = { button: [...] }",
            };
        }
      },
    });
  },
};

export default plugin;

export { wechatMpPlugin } from "./src/channel.js";
export { setWechatMpRuntime, getWechatMpRuntime } from "./src/runtime.js";
export { wechatMpOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/api/index.js";
export * from "./src/api-utils.js";
export * from "./src/config.js";
export * from "./src/outbound.js";
export * from "./src/crypto.js";
export { handleWechatMpWebhookRequest, registerWechatMpWebhookTarget } from "./src/webhook-handler.js";
export * from "./src/ai-assistant-state.js";
