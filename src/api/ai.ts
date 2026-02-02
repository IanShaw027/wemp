/**
 * 微信公众号 AI 能力 API
 * 用于翻译、语音识别等
 */
import { wechatApiGet, wechatApiPost, type WechatApiResponse } from "../api-utils.js";
import type { ResolvedWechatMpAccount } from "../types.js";
import { type Result, map } from "../result.js";

/**
 * 微信翻译
 */
export async function translate(
  account: ResolvedWechatMpAccount,
  content: string,
  fromLang: string,
  toLang: string
): Promise<Result<{ fromContent: string; toContent: string }>> {
  type TranslateResponse = WechatApiResponse & {
    from_content?: string;
    to_content?: string;
  };

  const result = await wechatApiPost<TranslateResponse>(
    account,
    "/cgi-bin/media/voice/translatecontent",
    { content },
    { query: { lfrom: fromLang, lto: toLang } }
  );

  return map(result, (data) => ({
    fromContent: data.from_content || content,
    toContent: data.to_content || "",
  }));
}

/**
 * 图片智能裁剪
 */
export async function aiCrop(
  account: ResolvedWechatMpAccount,
  imageUrl: string,
  ratios?: string[]
): Promise<Result<Array<{ cropLeft: number; cropTop: number; cropRight: number; cropBottom: number }>>> {
  type AiCropResponse = WechatApiResponse & {
    results?: Array<{
      crop_left: number;
      crop_top: number;
      crop_right: number;
      crop_bottom: number;
    }>;
  };

  const result = await wechatApiGet<AiCropResponse>(account, "/cv/img/aicrop", {
    query: { img_url: imageUrl, ratios: ratios?.length ? ratios.join(",") : undefined },
  });

  return map(result, (data) => (
    data.results?.map((r: { crop_left: number; crop_top: number; crop_right: number; crop_bottom: number }) => ({
      cropLeft: r.crop_left,
      cropTop: r.crop_top,
      cropRight: r.crop_right,
      cropBottom: r.crop_bottom,
    })) || []
  ));
}

/**
 * 图片超分辨率
 */
export async function superResolution(
  account: ResolvedWechatMpAccount,
  imageUrl: string
): Promise<Result<string>> {
  type SuperResolutionResponse = WechatApiResponse & { media_id?: string };

  const result = await wechatApiGet<SuperResolutionResponse>(account, "/cv/img/superresolution", {
    query: { img_url: imageUrl },
  });

  return map(result, (data) => {
    if (!data.media_id) {
      throw new Error("API 返回成功但缺少 media_id");
    }
    return data.media_id;
  });
}
