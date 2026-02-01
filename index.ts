import type { OpenclawPluginApi } from "openclaw/plugin-sdk";
import { wechatMpPlugin } from "./src/channel.js";
import { setWechatMpRuntime } from "./src/runtime.js";
import { handleWechatMpWebhookRequest } from "./src/webhook-handler.js";
import { verifyPairingCode } from "./src/pairing.js";
import { sendCustomMessage, createMenu, deleteMenu, getMenu, createOpenClawDefaultMenu, createMenuFromConfig } from "./src/api.js";
import { resolveWechatMpAccount } from "./src/config.js";

// 扩展 API 类型以包含 registerCommand
interface ExtendedPluginApi extends OpenclawPluginApi {
  registerCommand: (command: {
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
  }) => void;
  config: any;
}

const plugin = {
  id: "wemp",
  name: "微信公众号",
  description: "微信公众号渠道插件 (服务号客服消息)",
  register(api: OpenclawPluginApi) {
    const extApi = api as ExtendedPluginApi;

    setWechatMpRuntime(api.runtime);
    api.registerChannel({ plugin: wechatMpPlugin });
    api.registerHttpHandler(handleWechatMpWebhookRequest);

    // 注册 /pair 命令，用于跨渠道配对
    extApi.registerCommand({
      name: "pair",
      description: "配对微信公众号账号 (用法: /pair wemp <配对码>)",
      acceptsArgs: true,
      requireAuth: false,  // 不使用内置授权检查，我们自己检查
      handler: async (ctx) => {
        const args = ctx.args?.trim() || "";
        const parts = args.split(/\s+/);

        // 检查是否是授权用户（只有授权用户才能批准配对）
        // 从配置文件读取允许使用 /pair 命令的用户列表
        const cfg = ctx.config || extApi.config;
        const wempCfg = (cfg as any)?.channels?.wemp;
        const pairAllowFrom: string[] = wempCfg?.pairAllowFrom || [];

        // 如果配置了 pairAllowFrom，则检查发送者是否在列表中
        if (pairAllowFrom.length > 0) {
          const senderId = ctx.senderId || "";
          const senderLower = senderId.trim().toLowerCase();
          const isAllowed = pairAllowFrom.some(entry => {
            const normalized = String(entry).trim().toLowerCase();
            return normalized === "*" ||
                   (senderLower.length > 0 && normalized === senderLower);
          });

          if (!isAllowed) {
            return {
              text: `⚠️ 你没有权限使用此命令。\n\n` +
                `你的用户 ID: ${senderId}\n` +
                `渠道: ${ctx.channel || "unknown"}\n\n` +
                `请将你的用户 ID 添加到配置文件的 channels.wemp.pairAllowFrom 列表中。`,
            };
          }
        } else {
          // 如果没有配置 pairAllowFrom，则使用 isAuthorizedSender
          if (!ctx.isAuthorizedSender) {
            return {
              text: `⚠️ 你没有权限使用此命令。\n\n` +
                `你的用户 ID: ${ctx.senderId || "unknown"}\n` +
                `渠道: ${ctx.channel || "unknown"}\n\n` +
                `请在配置文件中设置 channels.wemp.pairAllowFrom 来指定允许的用户。`,
            };
          }
        }

        // 检查参数格式
        if (parts.length < 2) {
          return {
            text: "用法: /pair wemp <配对码>\n\n" +
              "请先在微信公众号中发送「配对」获取配对码，然后在这里使用该命令完成配对。",
          };
        }

        const channel = parts[0].toLowerCase();
        const code = parts[1];

        // 只处理 wemp 渠道
        if (channel !== "wemp" && channel !== "wechat") {
          return {
            text: `不支持的渠道: ${channel}\n\n此命令仅支持 wemp (微信公众号) 渠道。`,
          };
        }

        // 验证配对码格式
        if (!/^\d{6}$/.test(code)) {
          return {
            text: "配对码格式错误，应为 6 位数字。",
          };
        }

        // 验证配对码
        const result = verifyPairingCode(
          code,
          ctx.senderId || "unknown",
          ctx.senderId, // 使用 senderId 作为用户名
          ctx.channel || "unknown"
        );

        if (!result) {
          return {
            text: "配对失败：配对码无效或已过期。\n\n请在微信公众号中重新发送「配对」获取新的配对码。",
          };
        }

        // 通知微信用户配对成功
        try {
          const account = resolveWechatMpAccount(cfg, result.accountId);
          if (account) {
            await sendCustomMessage(
              account,
              result.openId,
              `🎉 配对成功！\n\n` +
                `已与 ${ctx.senderId || "未知用户"} 绑定。\n` +
                `配对渠道: ${ctx.channel || "未知"}\n\n` +
                `现在你可以使用完整的 AI 助手功能了。`
            );
          }
        } catch (err) {
          console.error("[wemp] 发送配对成功通知失败:", err);
        }

        return {
          text: `✅ 配对成功！\n\n微信用户已绑定到你的账号。`,
        };
      },
    });

    // 注册 /wemp-menu 命令，用于管理自定义菜单
    extApi.registerCommand({
      name: "wemp-menu",
      description: "管理微信公众号自定义菜单 (用法: /wemp-menu create|delete|get)",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() || "";
        const action = args.split(/\s+/)[0]?.toLowerCase();
        const cfg = ctx.config || extApi.config;
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
export * from "./src/config.js";
export * from "./src/outbound.js";
export * from "./src/crypto.js";
export { handleWechatMpWebhookRequest, registerWechatMpWebhookTarget } from "./src/webhook-handler.js";
