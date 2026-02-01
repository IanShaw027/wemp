/**
 * 微信公众号 API 封装
 */
import type { ResolvedWechatMpAccount } from "./types.js";

// Access Token 缓存
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Media ID 缓存 (临时素材有效期 3 天)
const mediaCache = new Map<string, { mediaId: string; expiresAt: number }>();

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
  console.log(`[wemp:${account.accountId}] Access Token 已刷新`);

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
 * 上传临时素材（图片）
 * 返回 media_id，有效期 3 天
 * 支持 HTTP URL、data URL、本地文件路径
 */
export async function uploadTempMedia(
  account: ResolvedWechatMpAccount,
  imageSource: string,
  type: "image" | "voice" | "video" | "thumb" = "image"
): Promise<{ success: boolean; mediaId?: string; error?: string }> {
  try {
    // 检查缓存（对于 data URL 使用前 100 字符作为 key）
    const cacheKey = `${account.accountId}:${type}:${imageSource.slice(0, 100)}`;
    const cached = mediaCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { success: true, mediaId: cached.mediaId };
    }

    let imageBuffer: ArrayBuffer;
    let contentType = "image/jpeg";

    // 处理不同类型的图片来源
    if (imageSource.startsWith("data:")) {
      // data URL 格式: data:image/png;base64,xxxxx
      const matches = imageSource.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return { success: false, error: "无效的 data URL 格式" };
      }
      contentType = matches[1];
      const base64Data = matches[2];
      imageBuffer = Buffer.from(base64Data, "base64").buffer;
    } else if (imageSource.startsWith("/") || imageSource.match(/^[A-Za-z]:\\/)) {
      // 本地文件路径
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      try {
        const fileBuffer = await fs.readFile(imageSource);
        imageBuffer = fileBuffer.buffer;
        // 根据扩展名推断 content type
        const ext = path.extname(imageSource).toLowerCase();
        if (ext === ".png") contentType = "image/png";
        else if (ext === ".gif") contentType = "image/gif";
        else if (ext === ".webp") contentType = "image/webp";
        else contentType = "image/jpeg";
      } catch (err) {
        return { success: false, error: `读取本地文件失败: ${err}` };
      }
    } else {
      // HTTP/HTTPS URL
      const imageResponse = await fetch(imageSource);
      if (!imageResponse.ok) {
        return { success: false, error: `下载图片失败: ${imageResponse.status}` };
      }
      imageBuffer = await imageResponse.arrayBuffer();
      contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    }

    // 确定文件扩展名
    let ext = "jpg";
    if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("gif")) ext = "gif";

    // 上传到微信
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=${type}`;

    // 构建 multipart/form-data
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).slice(2);
    const filename = `image.${ext}`;

    const bodyParts: Uint8Array[] = [];

    // 添加文件字段
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    bodyParts.push(new TextEncoder().encode(header));
    bodyParts.push(new Uint8Array(imageBuffer));
    bodyParts.push(new TextEncoder().encode(`\r\n--${boundary}--\r\n`));

    // 合并所有部分
    const totalLength = bodyParts.reduce((sum, part) => sum + part.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of bodyParts) {
      body.set(part, offset);
      offset += part.length;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const data = await response.json() as { media_id?: string; errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return { success: false, error: `上传失败: ${data.errcode} - ${data.errmsg}` };
    }

    const mediaId = data.media_id!;

    // 缓存 media_id (有效期 3 天，提前 1 小时过期)
    mediaCache.set(cacheKey, {
      mediaId,
      expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000) - (60 * 60 * 1000),
    });

    return { success: true, mediaId };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 发送客服消息（图片）
 */
export async function sendImageMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  mediaId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "image",
        image: { media_id: mediaId },
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
 * 发送客服消息（图片，通过 URL）
 * 自动上传并发送
 */
export async function sendImageByUrl(
  account: ResolvedWechatMpAccount,
  openId: string,
  imageUrl: string
): Promise<{ success: boolean; error?: string }> {
  // 先上传获取 media_id
  const uploadResult = await uploadTempMedia(account, imageUrl, "image");
  if (!uploadResult.success || !uploadResult.mediaId) {
    return { success: false, error: uploadResult.error || "上传图片失败" };
  }

  // 发送图片消息
  return sendImageMessage(account, openId, uploadResult.mediaId);
}

/**
 * 发送客服消息（图文消息）
 * 注意：图文消息需要先创建永久素材，这里使用外链图文
 */
export async function sendNewsMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  articles: Array<{
    title: string;
    description: string;
    url: string;
    picurl?: string;
  }>
): Promise<{ success: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "news",
        news: { articles },
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

/**
 * 下载图片并转换为 data URL
 */
export async function downloadImageAsDataUrl(
  imageUrl: string
): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return { success: false, error: `下载图片失败: ${response.status}` };
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:${contentType};base64,${base64}`;

    return { success: true, dataUrl };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 下载图片到本地文件
 * 返回本地文件路径
 */
export async function downloadImageToFile(
  imageUrl: string,
  downloadDir?: string
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");

    // 默认下载目录
    const dir = downloadDir || path.join(os.homedir(), ".openclaw", "data", "wemp", "images");

    // 确保目录存在
    await fs.mkdir(dir, { recursive: true });

    // 下载图片
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return { success: false, error: `下载图片失败: ${response.status}` };
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/jpeg";

    // 确定文件扩展名
    let ext = "jpg";
    if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("gif")) ext = "gif";
    else if (contentType.includes("webp")) ext = "webp";

    // 生成唯一文件名
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(dir, filename);

    // 写入文件
    await fs.writeFile(filePath, Buffer.from(buffer));

    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ============ 自定义菜单 API ============

/**
 * 菜单按钮类型
 */
export interface MenuButton {
  type?: "click" | "view" | "scancode_push" | "scancode_waitmsg" | "pic_sysphoto" | "pic_photo_or_album" | "pic_weixin" | "location_select" | "media_id" | "article_id" | "article_view_limited";
  name: string;
  key?: string;      // click 类型必填
  url?: string;      // view 类型必填
  media_id?: string; // media_id 类型必填
  article_id?: string; // article_id 类型必填
  sub_button?: MenuButton[]; // 子菜单
}

/**
 * 菜单结构
 */
export interface Menu {
  button: MenuButton[];
}

/**
 * 创建自定义菜单
 */
export async function createMenu(
  account: ResolvedWechatMpAccount,
  menu: Menu
): Promise<{ success: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${accessToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(menu),
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
 * 查询自定义菜单
 */
export async function getMenu(
  account: ResolvedWechatMpAccount
): Promise<{ success: boolean; menu?: any; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/menu/get?access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json() as { menu?: any; errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return { success: false, error: `${data.errcode} - ${data.errmsg}` };
    }

    return { success: true, menu: data.menu };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 删除自定义菜单
 */
export async function deleteMenu(
  account: ResolvedWechatMpAccount
): Promise<{ success: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/menu/delete?access_token=${accessToken}`;

    const response = await fetch(url);
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
 * 创建 OpenClaw 默认菜单
 * 包含常用的内置命令
 */
export function createOpenClawDefaultMenu(): Menu {
  return {
    button: [
      {
        name: "对话",
        sub_button: [
          {
            type: "click",
            name: "新对话",
            key: "CMD_NEW",
          },
          {
            type: "click",
            name: "清除上下文",
            key: "CMD_CLEAR",
          },
          {
            type: "click",
            name: "撤销上条",
            key: "CMD_UNDO",
          },
        ],
      },
      {
        name: "功能",
        sub_button: [
          {
            type: "click",
            name: "帮助",
            key: "CMD_HELP",
          },
          {
            type: "click",
            name: "查看状态",
            key: "CMD_STATUS",
          },
          {
            type: "click",
            name: "配对账号",
            key: "CMD_PAIR",
          },
        ],
      },
      {
        name: "更多",
        sub_button: [
          {
            type: "click",
            name: "模型信息",
            key: "CMD_MODEL",
          },
          {
            type: "click",
            name: "使用统计",
            key: "CMD_USAGE",
          },
        ],
      },
    ],
  };
}
