/**
 * 微信公众号 API 封装
 */
import type { ResolvedWechatMpAccount } from "./types.js";

// Access Token 缓存
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * 获取 Access Token
 */
export async function getAccessToken(account: ResolvedWechatMpAccount): Promise<string> {
  const cacheKey = account.accountId;
  const cached = tokenCache.get(cacheKey);

  // 提前 5 分钟刷新
  if (cached && Date.now() < cached.expiresAt - 300000) {
    return cached.token;
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${account.appId}&secret=${account.appSecret}`;

  const response = await fetch(url);
  const data = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };

  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errcode} - ${data.errmsg}`);
  }

  const token = data.access_token!;
  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;

  tokenCache.set(cacheKey, { token, expiresAt });
  console.log(`[wechat-mp:${account.accountId}] Access Token 已刷新`);

  return token;
}

/**
 * 发送客服消息（文本）
 */
export async function sendCustomMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "text",
        text: { content },
      }),
    });

    const data = await response.json() as { errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return { success: false, error: `${data.errcode} - ${data.errmsg}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 发送「正在输入」状态
 */
export async function sendTypingStatus(
  account: ResolvedWechatMpAccount,
  openId: string
): Promise<boolean> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        command: "Typing",
      }),
    });

    const data = await response.json() as { errcode?: number };
    return data.errcode === 0;
  } catch {
    return false;
  }
}
