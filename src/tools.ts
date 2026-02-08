/**
 * wemp Agent 工具注册
 * 让 Agent 能直接操作公众号功能
 */
import type { OpenclawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { resolveWechatMpAccount } from "./config.js";
import {
  listDrafts,
  getDraft,
  addDraft,
  updateDraft,
  deleteDraft,
  publishDraft,
  getPublishStatus,
  listPublished,
  listComments,
  replyComment,
  deleteComment,
  markCommentElect,
  getUserSummary,
  getArticleSummary,
  getUserInfo,
  getFollowers,
  createQRCode,
  getQRCodeImageUrl,
  sendTemplateMessage,
  getTemplates,
} from "./api/index.js";

const DEFAULT_ACCOUNT_ID = "default";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function error(message: string) {
  return {
    content: [{ type: "text" as const, text: `❌ ${message}` }],
    isError: true,
  };
}

function resolveConfiguredAccount(cfg: any) {
  const account = resolveWechatMpAccount(cfg, DEFAULT_ACCOUNT_ID);
  if (!account?.appId || !account?.appSecret || !account?.token) {
    return null;
  }
  return account;
}

/**
 * 注册草稿管理工具
 */
export function registerWempDraftTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_draft",
      description: "微信公众号草稿管理：列表、查看、创建、更新、删除草稿",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ], { description: "操作类型" }),
        media_id: Type.Optional(Type.String({ description: "草稿 media_id（get/update/delete 时必填）" })),
        title: Type.Optional(Type.String({ description: "文章标题（create/update 时使用）" })),
        content: Type.Optional(Type.String({ description: "文章内容 HTML（create/update 时使用）" })),
        thumb_media_id: Type.Optional(Type.String({ description: "封面图 media_id（create 时必填）" })),
        author: Type.Optional(Type.String({ description: "作者（create/update 时使用）" })),
        digest: Type.Optional(Type.String({ description: "摘要（create/update 时使用）" })),
        offset: Type.Optional(Type.Number({ description: "分页偏移（list 时使用）", default: 0 })),
        count: Type.Optional(Type.Number({ description: "每页数量（list 时使用）", default: 20 })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "list": {
              const result = await listDrafts(account, params.offset ?? 0, params.count ?? 20);
              if (!result.success) return error((result as any).error || "获取草稿列表失败");
              return json({
                total: result.data.totalCount,
                items: result.data.items?.map((item: any) => ({
                  media_id: item.mediaId,
                  title: item.articles?.[0]?.title,
                  update_time: item.updateTime,
                })),
              });
            }

            case "get": {
              if (!params.media_id) return error("media_id 必填");
              const result = await getDraft(account, params.media_id);
              if (!result.success) return error((result as any).error || "获取草稿失败");
              return json(result.data);
            }

            case "create": {
              if (!params.title || !params.content || !params.thumb_media_id) {
                return error("title、content 和 thumb_media_id 必填");
              }
              const result = await addDraft(account, [{
                title: params.title,
                content: params.content,
                thumbMediaId: params.thumb_media_id,
                author: params.author,
                digest: params.digest,
              }]);
              if (!result.success) return error((result as any).error || "创建草稿失败");
              return json({ media_id: result.data, message: "草稿创建成功" });
            }

            case "update": {
              if (!params.media_id) return error("media_id 必填");
              const result = await updateDraft(account, params.media_id, 0, {
                title: params.title,
                content: params.content,
                author: params.author,
                digest: params.digest,
              });
              if (!result.success) return error((result as any).error || "更新草稿失败");
              return json({ message: "草稿更新成功" });
            }

            case "delete": {
              if (!params.media_id) return error("media_id 必填");
              const result = await deleteDraft(account, params.media_id);
              if (!result.success) return error((result as any).error || "删除草稿失败");
              return json({ message: "草稿删除成功" });
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册发布管理工具
 */
export function registerWempPublishTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_publish",
      description: "微信公众号发布管理：发布草稿、查询发布状态、列出已发布文章",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("publish"),
          Type.Literal("status"),
          Type.Literal("list"),
        ], { description: "操作类型" }),
        media_id: Type.Optional(Type.String({ description: "草稿 media_id（publish 时必填）" })),
        publish_id: Type.Optional(Type.String({ description: "发布任务 ID（status 时必填）" })),
        offset: Type.Optional(Type.Number({ description: "分页偏移", default: 0 })),
        count: Type.Optional(Type.Number({ description: "每页数量", default: 20 })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "publish": {
              if (!params.media_id) return error("media_id 必填");
              const result = await publishDraft(account, params.media_id);
              if (!result.success) return error((result as any).error || "发布失败");
              return json({
                publish_id: result.data,
                message: "发布任务已提交，请稍后查询状态",
              });
            }

            case "status": {
              if (!params.publish_id) return error("publish_id 必填");
              const result = await getPublishStatus(account, params.publish_id);
              if (!result.success) return error((result as any).error || "查询状态失败");
              return json(result.data);
            }

            case "list": {
              const result = await listPublished(account, params.offset ?? 0, params.count ?? 20);
              if (!result.success) return error((result as any).error || "获取已发布列表失败");
              return json({
                total: result.data.totalCount,
                items: result.data.items,
              });
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册评论管理工具
 */
export function registerWempCommentTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_comment",
      description: "微信公众号评论管理：列出评论、回复评论、删除评论、精选评论",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("reply"),
          Type.Literal("delete"),
          Type.Literal("elect"),
        ], { description: "操作类型" }),
        msg_data_id: Type.String({ description: "文章 msg_data_id" }),
        index: Type.Optional(Type.Number({ description: "多图文时的文章索引", default: 0 })),
        user_comment_id: Type.Optional(Type.Number({ description: "评论 ID（reply/delete/elect 时必填）" })),
        content: Type.Optional(Type.String({ description: "回复内容（reply 时必填）" })),
        begin: Type.Optional(Type.Number({ description: "起始位置（list 时使用）", default: 0 })),
        count: Type.Optional(Type.Number({ description: "获取数量（list 时使用）", default: 50 })),
        type: Type.Optional(Type.Number({ description: "评论类型：0-全部 1-普通 2-精选", default: 0 })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "list": {
              const result = await listComments(
                account,
                params.msg_data_id,
                params.index ?? 0,
                params.begin ?? 0,
                params.count ?? 50,
                params.type ?? 0
              );
              if (!result.success) return error((result as any).error || "获取评论失败");
              return json({
                total: result.data.total,
                comments: result.data.comments,
              });
            }

            case "reply": {
              if (!params.user_comment_id || !params.content) {
                return error("user_comment_id 和 content 必填");
              }
              const result = await replyComment(
                account,
                params.msg_data_id,
                params.index ?? 0,
                params.user_comment_id,
                params.content
              );
              if (!result.success) return error((result as any).error || "回复失败");
              return json({ message: "回复成功" });
            }

            case "delete": {
              if (!params.user_comment_id) return error("user_comment_id 必填");
              const result = await deleteComment(
                account,
                params.msg_data_id,
                params.index ?? 0,
                params.user_comment_id
              );
              if (!result.success) return error((result as any).error || "删除失败");
              return json({ message: "评论已删除" });
            }

            case "elect": {
              if (!params.user_comment_id) return error("user_comment_id 必填");
              const result = await markCommentElect(
                account,
                params.msg_data_id,
                params.index ?? 0,
                params.user_comment_id
              );
              if (!result.success) return error((result as any).error || "精选失败");
              return json({ message: "评论已精选" });
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册数据统计工具
 */
export function registerWempStatsTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_stats",
      description: "微信公众号数据统计：用户增长、文章阅读等数据",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("user_summary"),
          Type.Literal("article_summary"),
        ], { description: "统计类型" }),
        begin_date: Type.String({ description: "开始日期 YYYY-MM-DD" }),
        end_date: Type.String({ description: "结束日期 YYYY-MM-DD（最多跨度 7 天）" }),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "user_summary": {
              const result = await getUserSummary(account, params.begin_date, params.end_date);
              if (!result.success) return error((result as any).error || "获取用户统计失败");
              return json(result.data);
            }

            case "article_summary": {
              const result = await getArticleSummary(account, params.begin_date, params.end_date);
              if (!result.success) return error((result as any).error || "获取文章统计失败");
              return json(result.data);
            }

            default:
              return error(`未知统计类型: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册用户管理工具
 */
export function registerWempUserTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_user",
      description: "微信公众号用户管理：获取用户信息、关注者列表",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("info"),
          Type.Literal("followers"),
        ], { description: "操作类型" }),
        openid: Type.Optional(Type.String({ description: "用户 OpenID（info 时必填）" })),
        next_openid: Type.Optional(Type.String({ description: "分页起始 OpenID（followers 时使用）" })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "info": {
              if (!params.openid) return error("openid 必填");
              const result = await getUserInfo(account, params.openid);
              if (!result.success) return error((result as any).error || "获取用户信息失败");
              return json(result.data);
            }

            case "followers": {
              const result = await getFollowers(account, params.next_openid);
              if (!result.success) return error((result as any).error || "获取关注者列表失败");
              return json({
                total: result.data.total,
                count: result.data.count,
                openids: result.data.openIds,
                next_openid: result.data.nextOpenId,
              });
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册二维码工具
 */
export function registerWempQRCodeTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_qrcode",
      description: "微信公众号二维码：创建带参二维码用于渠道追踪",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("get_url"),
        ], { description: "操作类型" }),
        type: Type.Optional(Type.Union([
          Type.Literal("QR_SCENE"),
          Type.Literal("QR_STR_SCENE"),
          Type.Literal("QR_LIMIT_SCENE"),
          Type.Literal("QR_LIMIT_STR_SCENE"),
        ], { description: "二维码类型：LIMIT 为永久码，否则为临时码" })),
        scene_id: Type.Optional(Type.Number({ description: "场景值 ID（数字型场景）" })),
        scene_str: Type.Optional(Type.String({ description: "场景值字符串（字符串型场景）" })),
        expire_seconds: Type.Optional(Type.Number({ description: "临时码有效期（秒），最大 2592000（30天）" })),
        ticket: Type.Optional(Type.String({ description: "二维码 ticket（get_url 时必填）" })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "create": {
              if (!params.type) return error("type 必填");
              const result = await createQRCode(account, {
                type: params.type,
                sceneId: params.scene_id,
                sceneStr: params.scene_str,
                expireSeconds: params.expire_seconds,
              });
              if (!result.success) return error((result as any).error || "创建二维码失败");
              return json({
                ticket: result.data.ticket,
                expire_seconds: result.data.expireSeconds,
                url: result.data.url,
                image_url: getQRCodeImageUrl(result.data.ticket),
              });
            }

            case "get_url": {
              if (!params.ticket) return error("ticket 必填");
              return json({
                image_url: getQRCodeImageUrl(params.ticket),
              });
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册模板消息工具
 */
export function registerWempTemplateTools(api: OpenclawPluginApi) {
  const cfg = api.runtime.config;

  api.registerTool(
    {
      name: "wemp_template",
      description: "微信公众号模板消息：发送模板消息、管理模板",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("send"),
          Type.Literal("list"),
        ], { description: "操作类型" }),
        openid: Type.Optional(Type.String({ description: "接收用户 OpenID（send 时必填）" })),
        template_id: Type.Optional(Type.String({ description: "模板 ID（send 时必填）" })),
        data: Type.Optional(Type.Record(Type.String(), Type.Object({
          value: Type.String(),
          color: Type.Optional(Type.String()),
        }), { description: "模板数据（send 时必填）" })),
        url: Type.Optional(Type.String({ description: "点击跳转 URL" })),
        miniprogram: Type.Optional(Type.Object({
          appid: Type.String(),
          pagepath: Type.String(),
        }, { description: "跳转小程序" })),
      }),
      async execute(_id: string, params: any) {
        const account = resolveConfiguredAccount(cfg);
        if (!account) {
          return error("微信公众号未完整配置（需 appId、appSecret、token）");
        }

        try {
          switch (params.action) {
            case "send": {
              if (!params.openid || !params.template_id || !params.data) {
                return error("openid、template_id 和 data 必填");
              }
              const result = await sendTemplateMessage(
                account,
                params.openid,
                params.template_id,
                params.data,
                {
                  url: params.url,
                  miniprogram: params.miniprogram,
                }
              );
              if (!result.success) return error((result as any).error || "发送模板消息失败");
              return json({ msgid: result.data, message: "模板消息发送成功" });
            }

            case "list": {
              const result = await getTemplates(account);
              if (!result.success) return error((result as any).error || "获取模板列表失败");
              return json(result.data);
            }

            default:
              return error(`未知操作: ${params.action}`);
          }
        } catch (err) {
          return error(String(err));
        }
      },
    },
    { optional: true }
  );
}

/**
 * 注册所有 wemp 工具
 */
export function registerWempTools(api: OpenclawPluginApi) {
  registerWempDraftTools(api);
  registerWempPublishTools(api);
  registerWempCommentTools(api);
  registerWempStatsTools(api);
  registerWempUserTools(api);
  registerWempQRCodeTools(api);
  registerWempTemplateTools(api);
}
