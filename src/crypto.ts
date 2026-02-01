/**
 * 微信消息加解密工具
 */
import * as crypto from "crypto";
import type { ResolvedWechatMpAccount, WechatMpMessage } from "./types.js";

/**
 * 验证普通签名
 */
export function verifySignature(token: string, signature: string, timestamp: string, nonce: string): boolean {
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join("");
  const hash = crypto.createHash("sha1").update(str).digest("hex");
  return hash === signature;
}

/**
 * 验证加密消息签名
 */
export function verifyEncryptSignature(
  token: string,
  signature: string,
  timestamp: string,
  nonce: string,
  encrypt: string
): boolean {
  const arr = [token, timestamp, nonce, encrypt].sort();
  const str = arr.join("");
  const hash = crypto.createHash("sha1").update(str).digest("hex");
  return hash === signature;
}

/**
 * 解密微信消息
 */
export function decryptMessage(encodingAESKey: string, appId: string, encrypt: string): string {
  const aesKey = Buffer.from(encodingAESKey + "=", "base64");
  const iv = aesKey.slice(0, 16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypt, "base64")),
    decipher.final(),
  ]);

  // 去除 PKCS7 填充
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);

  // 解析消息：random(16) + msg_len(4) + msg + appid
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.slice(20, 20 + msgLen).toString("utf8");
  const extractedAppId = decrypted.slice(20 + msgLen).toString("utf8");

  // 验证 AppID
  if (extractedAppId !== appId) {
    console.warn(`[wechat-mp] AppID 不匹配: ${extractedAppId} !== ${appId}`);
  }

  return msg;
}

/**
 * 从加密 XML 中提取 Encrypt 字段
 */
export function extractEncrypt(xml: string): string | null {
  const match = xml.match(/<Encrypt><!\[CDATA\[(.+?)\]\]><\/Encrypt>/);
  return match ? match[1] : null;
}

/**
 * 解析微信 XML 消息
 */
export function parseXmlMessage(xml: string): WechatMpMessage {
  const getValue = (tag: string): string => {
    const cdataMatch = xml.match(new RegExp(`<${tag}><![CDATA[([\\s\\S]*?)]]></${tag}>`));
    if (cdataMatch) return cdataMatch[1];

    const plainMatch = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return plainMatch ? plainMatch[1] : "";
  };

  return {
    toUserName: getValue("ToUserName"),
    fromUserName: getValue("FromUserName"),
    createTime: getValue("CreateTime"),
    msgType: getValue("MsgType"),
    content: getValue("Content"),
    msgId: getValue("MsgId"),
    event: getValue("Event"),
    eventKey: getValue("EventKey"),
    picUrl: getValue("PicUrl"),
    mediaId: getValue("MediaId"),
    format: getValue("Format"),
    recognition: getValue("Recognition"),
    thumbMediaId: getValue("ThumbMediaId"),
    locationX: getValue("Location_X"),
    locationY: getValue("Location_Y"),
    scale: getValue("Scale"),
    label: getValue("Label"),
    title: getValue("Title"),
    description: getValue("Description"),
    url: getValue("Url"),
  };
}

/**
 * 处理微信消息（验证 + 解密 + 解析）
 */
export function processWechatMessage(
  account: ResolvedWechatMpAccount,
  rawBody: string,
  query: {
    signature?: string;
    timestamp?: string;
    nonce?: string;
    encrypt_type?: string;
    msg_signature?: string;
  }
): { success: boolean; message?: WechatMpMessage; error?: string } {
  const { signature, timestamp, nonce, encrypt_type, msg_signature } = query;
  const isEncrypted = encrypt_type === "aes";

  let xmlContent = rawBody;

  if (isEncrypted) {
    // 安全模式
    const encrypt = extractEncrypt(rawBody);
    if (!encrypt) {
      return { success: false, error: "无法提取加密内容" };
    }

    if (!verifyEncryptSignature(account.token, msg_signature ?? "", timestamp ?? "", nonce ?? "", encrypt)) {
      return { success: false, error: "加密消息签名验证失败" };
    }

    try {
      xmlContent = decryptMessage(account.encodingAESKey, account.appId, encrypt);
    } catch (err) {
      return { success: false, error: `消息解密失败: ${err}` };
    }
  } else {
    // 明文模式
    if (!verifySignature(account.token, signature ?? "", timestamp ?? "", nonce ?? "")) {
      return { success: false, error: "消息签名验证失败" };
    }
  }

  const message = parseXmlMessage(xmlContent);
  return { success: true, message };
}
