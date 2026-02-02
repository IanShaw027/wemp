/**
 * 微信公众号 API 封装
 */
import type { ResolvedWechatMpAccount } from "./types.js";
import { makeMenuPayloadId, upsertMenuPayload, type MenuPayload } from "./menu-payload.js";
import { type Result, ok, err } from "./result.js";
import * as crypto from "node:crypto";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_DATA_URL_BYTES,
  ACCESS_TOKEN_REFRESH_ADVANCE_MS,
  DEFAULT_ACCESS_TOKEN_EXPIRY_SECONDS,
  MEDIA_CACHE_EXPIRY_MS,
  MEDIA_CACHE_ADVANCE_EXPIRY_MS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  PERMANENT_MEDIA_UPLOAD_TIMEOUT_MS,
  MAX_MEDIA_DOWNLOAD_BYTES,
} from "./constants.js";
import { logError, logInfo } from "./log.js";

// Access Token 缓存
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Media ID 缓存 (临时素材有效期 3 天)
const mediaCache = new Map<string, { mediaId: string; expiresAt: number }>();

export type SafeFetchOptions = {
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

export async function safeFetch(url: string, init?: RequestInit, opts?: SafeFetchOptions): Promise<Response> {
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

  // 提前刷新（使用常量）
  if (cached && Date.now() < cached.expiresAt - ACCESS_TOKEN_REFRESH_ADVANCE_MS) {
    return cached.token;
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${account.appId}&secret=${account.appSecret}`;

  const response = await safeFetch(url, undefined, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS });
  const data = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };

  if (data.errcode) {
    throw new Error(`获取 access_token 失败: ${data.errcode} - ${data.errmsg}`);
  }

  const token = data.access_token!;
  const expiresAt = Date.now() + (data.expires_in ?? DEFAULT_ACCESS_TOKEN_EXPIRY_SECONDS) * 1000;

  tokenCache.set(cacheKey, { token, expiresAt });
  logInfo(`[wemp:${account.accountId}] Access Token 已刷新`);

  return token;
}

/**
 * 发送客服消息（文本）
 */
export async function sendCustomMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  content: string
): Promise<Result<void>> {
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
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(undefined);
  } catch (error) {
    return err(String(error));
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
): Promise<Result<string>> {
  try {
    // 检查缓存（对于 data URL 使用前 100 字符作为 key）
    const cacheKey = `${account.accountId}:${type}:${imageSource.slice(0, 100)}`;
    const cached = mediaCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return ok(cached.mediaId);
    }

    let imageBytes: Uint8Array;
    let contentType = "image/jpeg";

    // 处理不同类型的图片来源
    if (imageSource.startsWith("data:")) {
      // data URL 格式: data:image/png;base64,xxxxx
      const matches = imageSource.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return err("无效的 data URL 格式");
      }
      contentType = matches[1];
      const base64Data = matches[2];
      const buf = Buffer.from(base64Data, "base64");
      if (buf.byteLength > MAX_DATA_URL_BYTES) {
        return err(`data URL 图片过大 (limit=${MAX_DATA_URL_BYTES} bytes)`);
      }
      imageBytes = new Uint8Array(buf);
    } else if (isProbablyFilePath(imageSource)) {
      // 本地文件路径（强安全：只允许受控目录）
      const fs = await import("node:fs/promises");
      try {
        const safePath = await resolveSafeLocalImagePath(imageSource);
        const fileBuffer = await fs.readFile(safePath);
        if (fileBuffer.byteLength > MAX_IMAGE_BYTES) {
          return err(`本地图片过大 (limit=${MAX_IMAGE_BYTES} bytes)`);
        }
        imageBytes = new Uint8Array(fileBuffer);
        // 根据扩展名推断 content type
        const ext = path.extname(safePath).toLowerCase();
        if (ext === ".png") contentType = "image/png";
        else if (ext === ".gif") contentType = "image/gif";
        else if (ext === ".webp") contentType = "image/webp";
        else contentType = "image/jpeg";
      } catch (error) {
        return err(`读取本地文件失败: ${error}`);
      }
    } else {
      // HTTP/HTTPS URL
      let url: URL;
      try {
        url = await validateExternalUrl(imageSource);
      } catch (e) {
        return err(`禁止的图片 URL: ${String(e)}`);
      }

      const imageResponse = await safeFetch(url.toString(), undefined, {
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        redirect: "follow",
      });
      if (!imageResponse.ok) return err(`下载图片失败: ${imageResponse.status}`);

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
      return err(`上传失败: ${data.errcode} - ${data.errmsg}`);
    }

    const mediaId = data.media_id!;

    // 缓存 media_id (有效期 3 天，提前 1 小时过期)
    mediaCache.set(cacheKey, {
      mediaId,
      expiresAt: Date.now() + MEDIA_CACHE_EXPIRY_MS - MEDIA_CACHE_ADVANCE_EXPIRY_MS,
    });

    return ok(mediaId);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 发送客服消息（图片）
 */
export async function sendImageMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  mediaId: string
): Promise<Result<void>> {
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
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(undefined);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 发送客服消息（语音）
 * 需要先上传语音素材获取 media_id
 */
export async function sendVoiceMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  mediaId: string
): Promise<Result<void>> {
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
        msgtype: "voice",
        voice: { media_id: mediaId },
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

    const data = await response.json() as { errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(undefined);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 发送客服消息（视频）
 * 需要先上传视频素材获取 media_id
 */
export async function sendVideoMessage(
  account: ResolvedWechatMpAccount,
  openId: string,
  mediaId: string,
  options?: {
    thumbMediaId?: string;
    title?: string;
    description?: string;
  }
): Promise<Result<void>> {
  try {
    // 微信客服消息的视频通常需要 thumb_media_id，否则会报参数错误
    if (!options?.thumbMediaId) {
      return err("缺少 thumbMediaId（微信视频客服消息通常需要缩略图）");
    }

    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

    const videoPayload: any = { media_id: mediaId };
    videoPayload.thumb_media_id = options.thumbMediaId;
    if (options?.title) videoPayload.title = options.title;
    if (options?.description) videoPayload.description = options.description;

    const response = await safeFetch(
      url,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openId,
        msgtype: "video",
        video: videoPayload,
      }),
      },
      { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }
    );

    const data = await response.json() as { errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(undefined);
  } catch (error) {
    return err(String(error));
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
): Promise<Result<void>> {
  // 先上传获取 media_id
  const uploadResult = await uploadTempMedia(account, imageUrl, "image");
  if (!uploadResult.success) {
    return err(uploadResult.error);
  }

  // 发送图片消息
  return sendImageMessage(account, openId, uploadResult.data);
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
): Promise<Result<void>> {
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
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(undefined);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 发送「正在输入」状态
 */
export async function sendTypingStatus(
  account: ResolvedWechatMpAccount,
  openId: string
): Promise<Result<void>> {
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

    const data = await response.json() as { errcode?: number; errmsg?: string };
    if (data.errcode === 0) {
      return ok(undefined);
    }
    return err(`${data.errcode} - ${data.errmsg || "Unknown error"}`);
  } catch (error) {
    return err(String(error));
  }
}

// ============ 素材管理 API ============

/**
 * 下载临时素材
 * 用于获取后台设置的临时素材内容
 */
export async function getTempMedia(
  account: ResolvedWechatMpAccount,
  mediaId: string
): Promise<Result<{ data: Buffer; contentType: string }>> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${mediaId}`;

    const response = await safeFetch(url, undefined, { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });

    const contentType = response.headers.get("content-type") || "";
    const normalizedType = contentType.split(";")[0].trim() || "application/octet-stream";

    // 注意：response body 只能读取一次。这里按 content-type 决定读取 text 还是 bytes。
    const isTextLike = contentType.includes("application/json") || contentType.startsWith("text/");
    if (isTextLike) {
      const text = await response.text();
      try {
        const data = JSON.parse(text) as { errcode?: number; errmsg?: string };
        if (data.errcode) return err(`${data.errcode} - ${data.errmsg}`);
      } catch {
        // ignore
      }
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return err(`获取素材失败：意外返回文本响应 (${normalizedType}): ${snippet}`);
    }

    const bytes = await readResponseBytesWithLimit(response, MAX_MEDIA_DOWNLOAD_BYTES);
    return ok({ data: Buffer.from(bytes), contentType: normalizedType });
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 下载永久素材
 * 用于获取后台设置的永久素材内容（语音、视频等）
 */
export async function getPermanentMedia(
  account: ResolvedWechatMpAccount,
  mediaId: string
): Promise<Result<{ data: Buffer; contentType: string }>> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/material/get_material?access_token=${accessToken}`;

    const response = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId }),
    }, { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });

    const contentType = response.headers.get("content-type") || "";
    const normalizedType = contentType.split(";")[0].trim() || "application/octet-stream";

    // 注意：response body 只能读取一次。对 get_material 来说，JSON 既可能是错误也可能是图文结构。
    const isTextLike = contentType.includes("application/json") || contentType.startsWith("text/");
    if (isTextLike) {
      const text = await response.text();
      try {
        const data = JSON.parse(text) as { errcode?: number; errmsg?: string };
        if (data.errcode) return err(`${data.errcode} - ${data.errmsg}`);
      } catch {
        // ignore
      }
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return err(`获取永久素材失败：该素材可能为图文或接口返回了非二进制响应 (${normalizedType}): ${snippet}`);
    }

    const bytes = await readResponseBytesWithLimit(response, MAX_MEDIA_DOWNLOAD_BYTES);
    return ok({ data: Buffer.from(bytes), contentType: normalizedType });
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 智能下载素材（先尝试临时素材，失败后尝试永久素材）
 */
export async function getMedia(
  account: ResolvedWechatMpAccount,
  mediaId: string
): Promise<Result<{ data: Buffer; contentType: string }>> {
  // 先尝试临时素材 API
  const tempResult = await getTempMedia(account, mediaId);
  if (tempResult.success) {
    logInfo(`[wemp] 通过临时素材 API 下载成功: ${mediaId.substring(0, 20)}...`);
    return tempResult;
  }

  // 临时素材失败，尝试永久素材 API
  logInfo(`[wemp] 临时素材 API 失败 (${tempResult.error})，尝试永久素材 API...`);
  const permResult = await getPermanentMedia(account, mediaId);
  if (permResult.success) {
    logInfo(`[wemp] 通过永久素材 API 下载成功: ${mediaId.substring(0, 20)}...`);
    return permResult;
  }

  return err(`临时素材: ${tempResult.error}; 永久素材: ${permResult.error}`);
}

/**
 * 上传永久素材
 * 返回永久 media_id，不会过期
 */
export async function uploadPermanentMedia(
  account: ResolvedWechatMpAccount,
  mediaData: Buffer,
  type: "image" | "voice" | "video" | "thumb",
  options?: {
    filename?: string;
    contentType?: string;
    title?: string;       // video 类型必填
    introduction?: string; // video 类型必填
  }
): Promise<Result<{ mediaId: string; url?: string }>> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=${type}`;

    // 确定文件名和 content type
    const filename = options?.filename || `media.${type === "image" ? "jpg" : type === "voice" ? "mp3" : type === "video" ? "mp4" : "jpg"}`;
    const contentType = options?.contentType || (type === "image" ? "image/jpeg" : type === "voice" ? "audio/mp3" : type === "video" ? "video/mp4" : "image/jpeg");

    // 构建 multipart/form-data
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).slice(2);
    const bodyParts: Uint8Array[] = [];

    // 添加媒体文件字段
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    bodyParts.push(new TextEncoder().encode(header));
    bodyParts.push(new Uint8Array(mediaData));
    bodyParts.push(new TextEncoder().encode("\r\n"));

    // 视频类型需要额外的描述字段
    if (type === "video" && (options?.title || options?.introduction)) {
      const description = JSON.stringify({
        title: options.title || "视频",
        introduction: options.introduction || "",
      });
      const descHeader = `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n`;
      bodyParts.push(new TextEncoder().encode(descHeader));
      bodyParts.push(new TextEncoder().encode(description));
      bodyParts.push(new TextEncoder().encode("\r\n"));
    }

    bodyParts.push(new TextEncoder().encode(`--${boundary}--\r\n`));

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
      { timeoutMs: PERMANENT_MEDIA_UPLOAD_TIMEOUT_MS }
    );

    const data = await response.json() as {
      media_id?: string;
      url?: string;
      errcode?: number;
      errmsg?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      return err(`上传失败: ${data.errcode} - ${data.errmsg}`);
    }

    return ok({
      mediaId: data.media_id!,
      url: data.url, // 图片类型会返回 URL
    });
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 将素材转换为永久素材
 * 智能下载素材（先尝试临时素材API，失败后尝试永久素材API）并重新上传为永久素材
 */
export async function convertToPermanentMedia(
  account: ResolvedWechatMpAccount,
  mediaId: string,
  type: "image" | "voice" | "video" | "thumb",
  options?: {
    title?: string;
    introduction?: string;
  }
): Promise<Result<string>> {
  // 1. 智能下载素材（先尝试临时素材，失败后尝试永久素材）
  const downloadResult = await getMedia(account, mediaId);
  if (!downloadResult.success) {
    return err(`下载素材失败: ${downloadResult.error}`);
  }

  // 2. 上传为永久素材
  const uploadResult = await uploadPermanentMedia(account, downloadResult.data.data, type, {
    contentType: downloadResult.data.contentType,
    title: options?.title,
    introduction: options?.introduction,
  });

  if (!uploadResult.success) {
    return err(`上传永久素材失败: ${uploadResult.error}`);
  }

  return ok(uploadResult.data.mediaId);
}

/**
 * 将临时素材转换为永久素材（兼容旧接口）
 * @deprecated 请使用 convertToPermanentMedia
 */
export async function convertTempToPermanentMedia(
  account: ResolvedWechatMpAccount,
  tempMediaId: string,
  type: "image" | "voice" | "video" | "thumb",
  options?: {
    title?: string;
    introduction?: string;
  }
): Promise<{ success: boolean; mediaId?: string; error?: string }> {
  return convertToPermanentMedia(account, tempMediaId, type, options);
}

// 永久素材 ID 缓存（临时素材 ID -> 永久素材 ID）
const permanentMediaCache = new Map<string, { mediaId: string; createdAt: number }>();

/**
 * 获取或创建永久素材
 * 如果已缓存则返回缓存的永久素材 ID，否则转换并缓存
 */
export async function getOrCreatePermanentMedia(
  account: ResolvedWechatMpAccount,
  tempMediaId: string,
  type: "image" | "voice" | "video" | "thumb",
  options?: {
    title?: string;
    introduction?: string;
  }
): Promise<{ success: boolean; mediaId?: string; error?: string }> {
  const cacheKey = `${account.accountId}:${type}:${tempMediaId}`;

  // 检查缓存
  const cached = permanentMediaCache.get(cacheKey);
  if (cached) {
    return { success: true, mediaId: cached.mediaId };
  }

  // 转换素材
  const result = await convertTempToPermanentMedia(account, tempMediaId, type, options);
  if (result.success && result.mediaId) {
    // 缓存结果（永久素材不会过期）
    permanentMediaCache.set(cacheKey, {
      mediaId: result.mediaId,
      createdAt: Date.now(),
    });
  }

  return result;
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
): Promise<Result<string>> {
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
    if (!response.ok) return err(`下载图片失败: ${response.status}`);

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const bytes = await readResponseBytesWithLimit(response, MAX_IMAGE_BYTES);

    // 确定文件扩展名
    const ext = inferImageExtFromContentType(contentType);

    // 生成唯一文件名
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    const filePath = path.join(dir, filename);

    // 写入文件
    await fs.writeFile(filePath, Buffer.from(bytes));

    return ok(filePath);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 上传图文消息内的图片
 * 返回微信内部 URL，用于正文中的图片
 * 注意：此接口返回的 URL 只能用于图文消息正文中的图片
 */
export async function uploadArticleImage(
  account: ResolvedWechatMpAccount,
  imageSource: string
): Promise<Result<string>> {
  try {
    let imageBytes: Uint8Array;
    let contentType = "image/jpeg";

    // 处理不同类型的图片来源
    if (imageSource.startsWith("data:")) {
      // data URL 格式
      const matches = imageSource.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return err("无效的 data URL 格式");
      }
      contentType = matches[1];
      const base64Data = matches[2];
      const buf = Buffer.from(base64Data, "base64");
      if (buf.byteLength > MAX_DATA_URL_BYTES) {
        return err(`data URL 图片过大 (limit=${MAX_DATA_URL_BYTES} bytes)`);
      }
      imageBytes = new Uint8Array(buf);
    } else if (isProbablyFilePath(imageSource)) {
      // 本地文件路径
      const fs = await import("node:fs/promises");
      try {
        const safePath = await resolveSafeLocalImagePath(imageSource);
        const fileBuffer = await fs.readFile(safePath);
        if (fileBuffer.byteLength > MAX_IMAGE_BYTES) {
          return err(`本地图片过大 (limit=${MAX_IMAGE_BYTES} bytes)`);
        }
        imageBytes = new Uint8Array(fileBuffer);
        const ext = path.extname(safePath).toLowerCase();
        if (ext === ".png") contentType = "image/png";
        else if (ext === ".gif") contentType = "image/gif";
        else if (ext === ".webp") contentType = "image/webp";
        else contentType = "image/jpeg";
      } catch (error) {
        return err(`读取本地文件失败: ${error}`);
      }
    } else {
      // HTTP/HTTPS URL
      let url: URL;
      try {
        url = await validateExternalUrl(imageSource);
      } catch (e) {
        return err(`禁止的图片 URL: ${String(e)}`);
      }

      const imageResponse = await safeFetch(url.toString(), undefined, {
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        redirect: "follow",
      });
      if (!imageResponse.ok) return err(`下载图片失败: ${imageResponse.status}`);

      contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      imageBytes = await readResponseBytesWithLimit(imageResponse, MAX_IMAGE_BYTES);
    }

    // 确定文件扩展名
    const ext = inferImageExtFromContentType(contentType);

    // 上传到微信
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;

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
      { timeoutMs: PERMANENT_MEDIA_UPLOAD_TIMEOUT_MS }
    );

    const data = await response.json() as { url?: string; errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      return err(`上传失败: ${data.errcode} - ${data.errmsg}`);
    }

    if (!data.url) {
      return err("上传成功但未返回 URL");
    }

    return ok(data.url);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 从 URL 上传图片到微信（用于图文消息正文）
 * 便捷方法，自动处理图片下载和上传
 */
export async function uploadArticleImageFromUrl(
  account: ResolvedWechatMpAccount,
  imageUrl: string
): Promise<Result<string>> {
  return uploadArticleImage(account, imageUrl);
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
  type?: "click" | "view" | "miniprogram" | "scancode_push" | "scancode_waitmsg" | "pic_sysphoto" | "pic_photo_or_album" | "pic_weixin" | "location_select" | "media_id" | "article_id" | "article_view_limited";
  name: string;
  key?: string;      // click 类型必填
  url?: string;      // view 类型必填
  appid?: string;    // miniprogram 类型必填
  pagepath?: string; // miniprogram 类型必填
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
    // 菜单二：AI 助手（包含开关）
    createAiAssistantMenu(),
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

// ============ 菜单同步功能 ============

/**
 * 后台菜单按钮格式（get_current_selfmenu_info 返回的格式）
 *
 * 官网设置的菜单类型：
 * - text: 发送消息（文字），value 保存文字内容
 * - img: 发送消息（图片），value 保存 mediaID
 * - voice: 发送消息（语音），value 保存 mediaID
 * - video: 发送消息（视频），value 保存视频下载链接
 * - news: 发送消息（已发表内容/图文消息），value 保存 mediaID，news_info 保存图文详情
 * - view: 跳转网页，url 保存链接
 *
 * API 设置的菜单类型：
 * - click: 点击事件，key 保存事件 key
 * - view: 跳转网页，url 保存链接
 */
interface BackendMenuButton {
  type?: string;
  name: string;
  value?: string;      // text/img/voice/video/news 类型的值
  url?: string;        // view 类型的 URL
  appid?: string;      // miniprogram 类型的 appid
  pagepath?: string;   // miniprogram 类型的页面路径
  key?: string;        // click 类型的 key
  news_info?: {        // news 类型的图文消息详情
    list: Array<{
      title: string;
      author?: string;
      digest?: string;
      show_cover?: number;
      cover_url?: string;
      content_url?: string;
      source_url?: string;
    }>;
  };
  sub_button?: {
    list: BackendMenuButton[];
  };
}

/**
 * 获取当前自定义菜单配置（包括后台创建的菜单）
 */
export async function getCurrentSelfMenuInfo(
  account: ResolvedWechatMpAccount
): Promise<{ success: boolean; isOpen?: boolean; buttons?: BackendMenuButton[]; error?: string }> {
  try {
    const accessToken = await getAccessToken(account);
    const url = `https://api.weixin.qq.com/cgi-bin/get_current_selfmenu_info?access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json() as {
      is_menu_open?: number;
      selfmenu_info?: { button: BackendMenuButton[] };
      errcode?: number;
      errmsg?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      return { success: false, error: `${data.errcode} - ${data.errmsg}` };
    }

    return {
      success: true,
      isOpen: data.is_menu_open === 1,
      buttons: data.selfmenu_info?.button || [],
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * 将后台菜单格式转换为 API 格式
 * 支持素材转换：img → media_id, news → view, voice → click（尝试发送语音）
 */
async function convertBackendButtonToApiFormat(
  btn: BackendMenuButton,
  account: ResolvedWechatMpAccount
): Promise<MenuButton | null> {
  const result: MenuButton = { name: btn.name };
  const accountId = account.accountId;

  // 处理子菜单
  if (btn.sub_button?.list && btn.sub_button.list.length > 0) {
    const subResults = await Promise.all(
      btn.sub_button.list.map((sub) => convertBackendButtonToApiFormat(sub, account))
    );
    const subButtons = subResults.filter((b): b is MenuButton => b !== null);
    if (subButtons.length === 0) return null;
    result.sub_button = subButtons;
    return result;
  }

  // 辅助函数：创建 click 类型菜单
  const createClickButton = (payload: MenuPayload, prefix: string): MenuButton => {
    const id = makeMenuPayloadId(accountId, payload);
    upsertMenuPayload(accountId, id, payload);
    return { ...result, type: "click", key: `${prefix}_${id}` };
  };

  switch (btn.type) {
    case "text":
      return createClickButton({ kind: "text", text: btn.value || "" }, "BACKEND_TEXT");

    case "news": {
      const contentUrl = btn.news_info?.list?.[0]?.content_url;
      if (contentUrl) {
        return { ...result, type: "view", url: contentUrl };
      }
      const title = btn.news_info?.list?.[0]?.title || btn.name;
      return createClickButton({ kind: "news", title, contentUrl: "" }, "BACKEND_NEWS");
    }

    case "img":
    case "photo":
      if (btn.value) {
        try {
          const convertResult = await getOrCreatePermanentMedia(account, btn.value, "image");
          if (convertResult.success && convertResult.mediaId) {
            return { ...result, type: "media_id", media_id: convertResult.mediaId };
          }
        } catch {}
      }
      return createClickButton({ kind: "image", mediaId: btn.value || "" }, "BACKEND_IMG");

    case "voice":
    case "audio":
      return createClickButton({ kind: "voice", mediaId: btn.value || "" }, "BACKEND_VOICE");

    case "video":
      if (btn.value && !btn.value.startsWith("http")) {
        try {
          const convertResult = await getOrCreatePermanentMedia(account, btn.value, "video", {
            title: btn.name,
            introduction: btn.name,
          });
          if (convertResult.success && convertResult.mediaId) {
            return { ...result, type: "media_id", media_id: convertResult.mediaId };
          }
        } catch {}
      }
      return createClickButton({ kind: "video", value: btn.value || "" }, "BACKEND_VIDEO");

    case "video_snap":
    case "finder":
      return createClickButton({ kind: "finder", value: btn.value || "" }, "BACKEND_FINDER");

    case "view":
      return { ...result, type: "view", url: btn.url };

    case "miniprogram":
      if (btn.appid && btn.pagepath) {
        return {
          ...result,
          type: "miniprogram",
          url: btn.url || "https://mp.weixin.qq.com",
          appid: btn.appid,
          pagepath: btn.pagepath,
        };
      }
      if (btn.url) {
        return { ...result, type: "view", url: btn.url };
      }
      return createClickButton(
        { kind: "unknown", originalType: "miniprogram", key: btn.key, value: btn.value, url: btn.url },
        "BACKEND_UNKNOWN"
      );

    case "click":
      return { ...result, type: "click", key: btn.key || btn.value };

    case "media_id":
      return { ...result, type: "media_id", media_id: btn.value };

    case "article_id":
      return { ...result, type: "article_id", article_id: btn.value };

    case "article_view_limited":
      return { ...result, type: "article_view_limited", article_id: btn.value };

    default:
      if (btn.url) {
        return { ...result, type: "view", url: btn.url };
      }
      if (btn.value || btn.key) {
        return createClickButton(
          { kind: "unknown", originalType: btn.type, key: btn.key, value: btn.value, url: btn.url },
          "BACKEND_UNKNOWN"
        );
      }
      return createClickButton(
        { kind: "unknown", originalType: btn.type, key: btn.key, value: btn.value, url: btn.url },
        "BACKEND_EMPTY"
      );
  }
}

/**
 * AI 助手菜单配置
 * 包含开启/关闭 AI 助手的按钮
 */
export function createAiAssistantMenu(): MenuButton {
  return {
    name: "AI助手",
    sub_button: [
      { type: "click", name: "开启AI助手", key: "CMD_AI_ENABLE" },
      { type: "click", name: "关闭AI助手", key: "CMD_AI_DISABLE" },
      { type: "click", name: "新对话", key: "CMD_NEW" },
      { type: "click", name: "清除上下文", key: "CMD_CLEAR" },
      { type: "click", name: "使用统计", key: "CMD_USAGE" },
    ],
  };
}

function hasAiAssistantMenu(buttons: MenuButton[]): boolean {
  return buttons.some(btn => btn.name === "AI助手");
}

function compareMenus(menu1: MenuButton[], menu2: MenuButton[]): boolean {
  const filter = (btns: MenuButton[]) => btns.filter(btn => btn.name !== "AI助手");
  return JSON.stringify(filter(menu1)) === JSON.stringify(filter(menu2));
}

/**
 * 同步菜单：读取后台菜单，添加 AI 助手，创建新菜单
 */
export async function syncMenuWithAiAssistant(
  account: ResolvedWechatMpAccount,
  _cfg?: any
): Promise<{ success: boolean; action: "created" | "updated" | "unchanged" | "error"; message: string }> {
  try {
    // 获取当前后台菜单
    const currentMenuResult = await getCurrentSelfMenuInfo(account);
    if (!currentMenuResult.success) {
      return { success: false, action: "error", message: `获取当前菜单失败: ${currentMenuResult.error}` };
    }

    const currentButtons = currentMenuResult.buttons || [];
    logInfo(`[wemp:${account.accountId}] 当前菜单: ${currentButtons.map(b => b.name).join(", ") || "无"}`);

    // 获取 API 菜单（检查是否已有 AI 助手）
    const apiMenuResult = await getMenu(account);
    const hasApiMenu = apiMenuResult.success && apiMenuResult.menu?.button;

    // 转换后台菜单为 API 格式
    const filteredButtons = currentButtons.filter(btn => btn.name !== "AI助手");
    const buttonResults = await Promise.all(
      filteredButtons.map((btn) => convertBackendButtonToApiFormat(btn, account))
    );
    const businessButtons = buttonResults.filter((b): b is MenuButton => b !== null);

    // 检查是否需要更新
    if (hasApiMenu) {
      const apiButtons = apiMenuResult.menu.button as MenuButton[];
      if (hasAiAssistantMenu(apiButtons) && compareMenus(apiButtons, businessButtons)) {
        return { success: true, action: "unchanged", message: "菜单无变化" };
      }
    }

    // 构建新菜单：业务菜单 + AI 助手（微信最多支持 3 个一级菜单）
    const aiAssistantMenu = createAiAssistantMenu();
    const hasTruncation = businessButtons.length >= 3;
    const newButtons = hasTruncation
      ? [...businessButtons.slice(0, 2), aiAssistantMenu]
      : [...businessButtons, aiAssistantMenu];

    // 创建新菜单
    const createResult = await createMenu(account, { button: newButtons });
    if (!createResult.success) {
      return { success: false, action: "error", message: `创建菜单失败: ${createResult.error}` };
    }

    const action = hasApiMenu ? "updated" : "created";
    const menuNames = newButtons.map(b => b.name).join(", ");
    const truncationNote = hasTruncation
      ? `（注意：原一级菜单 ${businessButtons.length} 个，已保留前 2 个并追加 AI助手）`
      : "";
    logInfo(`[wemp:${account.accountId}] 菜单${action === "created" ? "创建" : "更新"}成功: ${menuNames}`);

    return { success: true, action, message: `菜单${action === "created" ? "创建" : "更新"}成功: ${menuNames}${truncationNote}` };
  } catch (error) {
    logError(`[wemp:${account.accountId}] 同步菜单失败:`, error);
    return { success: false, action: "error", message: `同步菜单失败: ${String(error)}` };
  }
}
