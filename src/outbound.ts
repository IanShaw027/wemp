/**
 * 微信公众号消息发送
 */
import type { ResolvedWechatMpAccount } from "./types.js";
import { sendCustomMessage } from "./api.js";

/**
 * 发送文本消息
 */
export async function sendText(opts: {
  to: string;
  text: string;
  accountId: string;
  replyToId?: string;
  account: ResolvedWechatMpAccount;
}): Promise<{ messageId?: string; error?: string }> {
  const { to, text, account } = opts;

  // 微信客服消息单条建议不超过 600 字，超过则分段发送
  const maxLength = 600;
  const parts = splitMessage(text, maxLength);

  for (let i = 0; i < parts.length; i++) {
    const result = await sendCustomMessage(account, to, parts[i]);
    if (!result.success) {
      return { error: result.error };
    }
    // 分段发送时稍微延迟
    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return { messageId: `wechat-mp-${Date.now()}` };
}

/**
 * 分割长消息
 */
function splitMessage(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // 尝试在标点符号处断开
    let splitIndex = maxLength;
    const punctuation = ["。", "！", "？", "\n", "；", "，"];

    for (let i = maxLength; i > maxLength - 100 && i > 0; i--) {
      if (punctuation.includes(remaining[i])) {
        splitIndex = i + 1;
        break;
      }
    }

    parts.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return parts;
}
