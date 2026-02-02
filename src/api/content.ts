/**
 * 文章内容处理工具
 * 用于处理图文消息中的图片和内容转换
 */
import { uploadArticleImage } from "../api.js";
import type { ResolvedWechatMpAccount } from "../types.js";
import { type Result, ok, err } from "../result.js";
import { logWarn } from "../log.js";

/**
 * 处理文章内容中的图片
 * 将外部图片上传到微信并替换 URL
 */
export async function processArticleImages(
  account: ResolvedWechatMpAccount,
  content: string
): Promise<Result<string>> {
  try {
    // 匹配所有图片标签
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const matches = [...content.matchAll(imgRegex)];

    if (matches.length === 0) {
      return ok(content);
    }

    let processedContent = content;
    const uploadedUrls = new Map<string, string>();

    for (const match of matches) {
      const originalUrl = match[1];

      // 跳过已经是微信 URL 的图片
      if (originalUrl.includes("mmbiz.qpic.cn")) {
        continue;
      }

      // 检查是否已上传过相同的图片
      if (uploadedUrls.has(originalUrl)) {
        processedContent = processedContent.split(originalUrl).join(uploadedUrls.get(originalUrl)!);
        continue;
      }

      // 上传图片到微信
      const result = await uploadArticleImage(account, originalUrl);

      if (result.success) {
        uploadedUrls.set(originalUrl, result.data);
        processedContent = processedContent.split(originalUrl).join(result.data);
      } else {
        logWarn(`[wemp] 上传图片失败: ${originalUrl} - ${result.error}`);
      }
    }

    return ok(processedContent);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 提取内容中的所有图片 URL
 */
export function extractImageUrls(content: string): string[] {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const matches = [...content.matchAll(imgRegex)];
  return matches.map(m => m[1]);
}

/**
 * 校验文章内容长度
 */
export interface ContentValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateArticleContent(
  title: string,
  author?: string,
  digest?: string,
  content?: string
): ContentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 标题校验
  if (!title) {
    errors.push("标题不能为空");
  } else if (title.length > 64) {
    errors.push(`标题过长: ${title.length}/64 字符`);
  } else if (title.length > 32) {
    warnings.push(`标题较长: ${title.length}/64 字符，建议不超过 32 字符`);
  }

  // 作者校验
  if (author && author.length > 16) {
    errors.push(`作者名过长: ${author.length}/16 字符`);
  }

  // 摘要校验
  if (digest && digest.length > 128) {
    errors.push(`摘要过长: ${digest.length}/128 字符`);
  }

  // 正文校验
  if (content) {
    const contentLength = content.length;
    const contentBytes = Buffer.byteLength(content, "utf8");

    if (contentLength > 20000) {
      errors.push(`正文过长: ${contentLength}/20000 字符`);
    }

    if (contentBytes > 1024 * 1024) {
      errors.push(`正文过大: ${(contentBytes / 1024 / 1024).toFixed(2)}MB/1MB`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 转义 HTML 特殊字符，防止 XSS 攻击
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 验证 URL 是否安全（防止 javascript: 等协议）
 */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
    return false;
  }
  return true;
}

/**
 * 简单的 Markdown 转 HTML
 * 仅支持基本语法，复杂内容建议使用专业库
 * 注意：此函数会转义 HTML 特殊字符以防止 XSS 攻击
 */
export function markdownToHtml(markdown: string): string {
  // 先转义 HTML 特殊字符，防止 XSS
  let html = escapeHtml(markdown);

  // 标题
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // 粗体和斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 行内代码
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 链接（验证 URL 安全性）
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    if (isSafeUrl(url)) {
      return `<a href="${url}">${text}</a>`;
    }
    return text;
  });

  // 图片（验证 URL 安全性）
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    if (isSafeUrl(url)) {
      return `<img src="${url}" alt="${alt}">`;
    }
    return alt || "";
  });

  // 无序列表
  html = html.replace(/^- (.+)$/gm, "<li class=\"ul-item\">$1</li>");
  html = html.replace(/(<li class="ul-item">.*<\/li>\n?)+/g, (match) => `<ul>${match.replace(/ class="ul-item"/g, "")}</ul>`);

  // 有序列表
  html = html.replace(/^\d+\. (.+)$/gm, "<li class=\"ol-item\">$1</li>");
  html = html.replace(/(<li class="ol-item">.*<\/li>\n?)+/g, (match) => `<ol>${match.replace(/ class="ol-item"/g, "")}</ol>`);

  // 引用
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // 水平线
  html = html.replace(/^---$/gm, "<hr>");

  // 段落（连续的非空行）
  html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");

  // 清理多余的空行
  html = html.replace(/\n{3,}/g, "\n\n");

  return html;
}

/**
 * 生成文章摘要
 * 从正文中提取前 N 个字符作为摘要
 */
export function generateDigest(content: string, maxLength = 120): string {
  // 移除 HTML 标签
  let text = content.replace(/<[^>]+>/g, "");

  // 移除多余空白
  text = text.replace(/\s+/g, " ").trim();

  // 截取指定长度
  if (text.length <= maxLength) {
    return text;
  }

  // 尝试在标点处截断
  const truncated = text.slice(0, maxLength);
  const lastPunctuation = Math.max(
    truncated.lastIndexOf("。"),
    truncated.lastIndexOf("！"),
    truncated.lastIndexOf("？"),
    truncated.lastIndexOf("；"),
    truncated.lastIndexOf("，")
  );

  if (lastPunctuation > maxLength * 0.6) {
    return truncated.slice(0, lastPunctuation + 1);
  }

  return truncated + "...";
}
