/**
 * 微信公众号 API 封装
 */
import type { ResolvedWechatMpAccount } from "./types.js";
import * as crypto from "node:crypto";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// Access Token 缓存
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Media ID 缓存 (临时素材有效期 3 天)
const mediaCache = new Map<string, { mediaId: string; expiresAt: number }>();

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB hard limit (防止内存/带宽滥用)
const MAX_DATA_URL_BYTES = 3 * 1024 * 1024; // data URL 解码后最大 3MB

type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  redirect?: RequestRedirect;
};

function isProbablyFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\\/.test(value);
}

function isPrivateIp(ip: string): boolean {
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    const [a, b] = ip.split(".").map((x) => parseInt(x, 10));
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (ipVersion === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fe80:")) return true; // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped?.[1]) return isPrivateIp(v4Mapped[1]);
    return false;
  }
  return true;
}

async function validateExternalUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("无效的 URL");
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("仅支持 http/https URL");
  }

  const hostname = url.hostname;
  if (!hostname) throw new Error("无效的 URL 主机名");

  // 明确拒绝 localhost 类
  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost.endsWith(".local")) {
    throw new Error("禁止访问本地域名");
  }

  const ipLiteral = net.isIP(hostname) ? hostname : null;
  if (ipLiteral) {
    if (isPrivateIp(ipLiteral)) throw new Error("禁止访问内网/本地 IP");
    return url;
  }

  // 对域名做 DNS 解析，拒绝解析到内网/本地地址（SSRF 防护）
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error("DNS 解析失败");
  for (const addr of addrs) {
    if (isPrivateIp(addr.address)) {
      throw new Error("禁止访问解析到内网/本地地址的域名");
    }
  }

  return url;
}

async function safeFetch(url: string, init?: RequestInit, opts?: SafeFetchOptions): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      redirect: opts?.redirect ?? "follow",
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`响应体过大: ${n} bytes (limit=${maxBytes})`);
    }
  }

  if (!response.body) {
    // node-fetch/web fetch 可能在某些情况没有 body
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`响应体过大 (limit=${maxBytes})`);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`响应体过大 (limit=${maxBytes})`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function inferImageExtFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  return "jpg";
}

function getDefaultWempImageDir(): string {
  return path.join(os.homedir(), ".openclaw", "data", "wemp", "images");
}

async function resolveSafeLocalImagePath(inputPath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const real = await fs.realpath(inputPath);
  const allowedBase = await fs.realpath(getDefaultWempImageDir()).catch(() => getDefaultWempImageDir());

  const normalizedBase = allowedBase.endsWith(path.sep) ? allowedBase : allowedBase + path.sep;
  if (!(real === allowedBase || real.startsWith(normalizedBase))) {
    throw new Error("禁止读取非受控目录下的本地文件");
  }
  return real;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

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

  const response = await safeFetch(url, undefined, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS });
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

    const response = await safeFetch(
      url,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "text",
        text: { content },
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

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

    let imageBytes: Uint8Array;
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
      const buf = Buffer.from(base64Data, "base64");
      if (buf.byteLength > MAX_DATA_URL_BYTES) {
        return { success: false, error: `data URL 图片过大 (limit=${MAX_DATA_URL_BYTES} bytes)` };
      }
      imageBytes = new Uint8Array(buf);
    } else if (isProbablyFilePath(imageSource)) {
      // 本地文件路径（强安全：只允许受控目录）
      const fs = await import("node:fs/promises");
      try {
        const safePath = await resolveSafeLocalImagePath(imageSource);
        const fileBuffer = await fs.readFile(safePath);
        if (fileBuffer.byteLength > MAX_IMAGE_BYTES) {
          return { success: false, error: `本地图片过大 (limit=${MAX_IMAGE_BYTES} bytes)` };
        }
        imageBytes = new Uint8Array(fileBuffer);
        // 根据扩展名推断 content type
        const ext = path.extname(safePath).toLowerCase();
        if (ext === ".png") contentType = "image/png";
        else if (ext === ".gif") contentType = "image/gif";
        else if (ext === ".webp") contentType = "image/webp";
        else contentType = "image/jpeg";
      } catch (err) {
        return { success: false, error: `读取本地文件失败: ${err}` };
      }
    } else {
      // HTTP/HTTPS URL
      let url: URL;
      try {
        url = await validateExternalUrl(imageSource);
      } catch (e) {
        return { success: false, error: `禁止的图片 URL: ${String(e)}` };
      }

      const imageResponse = await safeFetch(url.toString(), undefined, {
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        redirect: "follow",
      });
      if (!imageResponse.ok) return { success: false, error: `下载图片失败: ${imageResponse.status}` };

      contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      imageBytes = await readResponseBytesWithLimit(imageResponse, MAX_IMAGE_BYTES);
    }

    // 确定文件扩展名
    const ext = inferImageExtFromContentType(contentType);

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
    bodyParts.push(imageBytes);
    bodyParts.push(new TextEncoder().encode(`\r\n--${boundary}--\r\n`));

    // 合并所有部分
    const totalLength = bodyParts.reduce((sum, part) => sum + part.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of bodyParts) {
      body.set(part, offset);
      offset += part.length;
    }

    const response = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

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

    const response = await safeFetch(
      url,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "image",
        image: { media_id: mediaId },
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

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

    const response = await safeFetch(
      url,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "news",
        news: { articles },
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

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

    const response = await safeFetch(
      url,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        command: "Typing",
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

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
    const url = await validateExternalUrl(imageUrl);
    const response = await safeFetch(url.toString(), undefined, {
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      redirect: "follow",
    });
    if (!response.ok) return { success: false, error: `下载图片失败: ${response.status}` };

    const bytes = await readResponseBytesWithLimit(response, MAX_IMAGE_BYTES);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const base64 = Buffer.from(bytes).toString("base64");
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

    // 默认下载目录
    const dir = downloadDir || getDefaultWempImageDir();

    // 确保目录存在
    await fs.mkdir(dir, { recursive: true });

    // 下载图片
    const url = await validateExternalUrl(imageUrl);
    const response = await safeFetch(url.toString(), undefined, {
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      redirect: "follow",
    });
    if (!response.ok) return { success: false, error: `下载图片失败: ${response.status}` };

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const bytes = await readResponseBytesWithLimit(response, MAX_IMAGE_BYTES);

    // 确定文件扩展名
    const ext = inferImageExtFromContentType(contentType);

    // 生成唯一文件名
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    const filePath = path.join(dir, filename);

    // 写入文件
    await fs.writeFile(filePath, Buffer.from(bytes));

    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export const __internal = {
  timingSafeEqualString,
  validateExternalUrl,
  readResponseBytesWithLimit,
  isPrivateIp,
};

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
 * 包含常用的内置命令，支持自定义第三个菜单
 *
 * @param customMenu 可选的自定义菜单配置（用于第三个菜单位置）
 */
export function createOpenClawDefaultMenu(customMenu?: MenuButton): Menu {
  const buttons: MenuButton[] = [
    // 菜单一：内容（公众号核心功能）
    {
      name: "内容",
      sub_button: [
        { type: "click", name: "历史文章", key: "CMD_ARTICLES" },
        { type: "click", name: "访问官网", key: "CMD_WEBSITE" },
      ],
    },
    // 菜单二：AI 助手（核心对话功能）
    {
      name: "AI助手",
      sub_button: [
        { type: "click", name: "新对话", key: "CMD_NEW" },
        { type: "click", name: "清除上下文", key: "CMD_CLEAR" },
        { type: "click", name: "帮助", key: "CMD_HELP" },
        { type: "click", name: "配对账号", key: "CMD_PAIR" },
        { type: "click", name: "查看状态", key: "CMD_STATUS" },
      ],
    },
  ];

  // 菜单三：更多（用户自定义或默认）
  if (customMenu) {
    buttons.push(customMenu);
  } else {
    // 默认的第三个菜单
    buttons.push({
      name: "更多",
      sub_button: [
        { type: "click", name: "撤销上条", key: "CMD_UNDO" },
        { type: "click", name: "模型信息", key: "CMD_MODEL" },
        { type: "click", name: "使用统计", key: "CMD_USAGE" },
      ],
    });
  }

  return { button: buttons };
}

/**
 * 从配置创建完整菜单
 * 支持从配置文件读取自定义菜单
 *
 * 配置示例 (openclaw.json):
 * {
 *   "channels": {
 *     "wemp": {
 *       "articlesUrl": "https://mp.weixin.qq.com/...",  // 历史文章链接
 *       "websiteUrl": "https://example.com",           // 官网链接
 *       "contactInfo": "联系方式...",                   // 联系信息
 *       "menu": {                                       // 完全自定义菜单（可选）
 *         "button": [...]
 *       }
 *     }
 *   }
 * }
 */
export function createMenuFromConfig(cfg: any): Menu {
  const wempCfg = cfg?.channels?.wemp;

  // 如果配置了完整菜单，直接使用
  if (wempCfg?.menu?.button) {
    return wempCfg.menu as Menu;
  }

  // 否则使用默认菜单 + 可选的自定义第三菜单
  const customMenuConfig = wempCfg?.customMenu as MenuButton | undefined;
  return createOpenClawDefaultMenu(customMenuConfig);
}
