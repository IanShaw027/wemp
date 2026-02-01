import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { wechatMpPlugin } from "./src/channel.js";
import { setWechatMpRuntime } from "./src/runtime.js";
import { handleWechatMpWebhookRequest } from "./src/webhook-handler.js";

const plugin = {
  id: "wechat-mp",
  name: "微信公众号",
  description: "微信公众号 channel plugin (服务号客服消息)",
  register(api: ClawdbotPluginApi) {
    setWechatMpRuntime(api.runtime);
    api.registerChannel({ plugin: wechatMpPlugin });
    api.registerHttpHandler(handleWechatMpWebhookRequest);
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
