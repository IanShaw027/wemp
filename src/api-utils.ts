/**
 * 微信公众号 API 通用工具函数
 * 用于减少 API 调用中的重复代码
 */
import { getAccessToken, safeFetch } from "./api.js";
import type { ResolvedWechatMpAccount } from "./types.js";
import { type Result, ok, err } from "./result.js";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./constants.js";

const API_BASE = "https://api.weixin.qq.com";

/**
 * 微信 API 响应的基础结构
 */
export interface WechatApiResponse {
  errcode?: number;
  errmsg?: string;
}

/**
 * 微信 API 列表响应的基础结构
 */
export interface WechatListResponse<T = unknown> extends WechatApiResponse {
  list?: T[];
}

/**
 * API 请求选项
 */
export interface ApiRequestOptions {
  /** 请求超时时间（毫秒） */
  timeoutMs?: number;
  /** 是否使用 POST 方法（默认 true） */
  usePost?: boolean;
  /** URL 查询参数 */
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * 通用的微信 API 请求函数
 * 封装了获取 token、发送请求、解析响应、检查错误码的逻辑
 *
 * @param account 微信公众号账号配置
 * @param endpoint API 端点路径（不含 access_token 参数）
 * @param body 请求体（可选）
 * @param options 请求选项
 * @returns API 响应结果
 */
export async function wechatApiRequest<T extends WechatApiResponse>(
  account: ResolvedWechatMpAccount,
  endpoint: string,
  body?: Record<string, unknown>,
  options?: ApiRequestOptions
): Promise<Result<T>> {
  try {
    const accessToken = await getAccessToken(account);
    const queryParams = new URLSearchParams({ access_token: accessToken });

    // 添加额外的查询参数
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          queryParams.set(key, String(value));
        }
      }
    }

    const url = `${API_BASE}${endpoint}?${queryParams.toString()}`;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const usePost = options?.usePost ?? true;

    const response = await safeFetch(
      url,
      usePost
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
          }
        : undefined,
      { timeoutMs }
    );

    const data = (await response.json()) as T;

    if (data.errcode && data.errcode !== 0) {
      return err(`${data.errcode} - ${data.errmsg}`);
    }

    return ok(data);
  } catch (error) {
    return err(String(error));
  }
}

/**
 * 通用的微信 API GET 请求函数
 */
export async function wechatApiGet<T extends WechatApiResponse>(
  account: ResolvedWechatMpAccount,
  endpoint: string,
  options?: Omit<ApiRequestOptions, "usePost">
): Promise<Result<T>> {
  return wechatApiRequest<T>(account, endpoint, undefined, {
    ...options,
    usePost: false,
  });
}

/**
 * 通用的微信 API POST 请求函数
 */
export async function wechatApiPost<T extends WechatApiResponse>(
  account: ResolvedWechatMpAccount,
  endpoint: string,
  body?: Record<string, unknown>,
  options?: Omit<ApiRequestOptions, "usePost">
): Promise<Result<T>> {
  return wechatApiRequest<T>(account, endpoint, body, {
    ...options,
    usePost: true,
  });
}

/**
 * 解析微信 API 响应中的列表数据
 * 用于处理 { list: [...], errcode, errmsg } 格式的响应
 */
export function extractList<T, R>(
  data: WechatListResponse<T>,
  mapper: (item: T) => R
): R[] {
  return data.list?.map(mapper) || [];
}

/**
 * 解析微信 API 响应中的分页列表数据
 * 用于处理 { total_count, item: [...], errcode, errmsg } 格式的响应
 */
export function extractPaginatedList<T, R>(
  data: { total_count?: number; item?: T[] } & WechatApiResponse,
  mapper: (item: T) => R
): { totalCount: number; items: R[] } {
  return {
    totalCount: data.total_count || 0,
    items: data.item?.map(mapper) || [],
  };
}
