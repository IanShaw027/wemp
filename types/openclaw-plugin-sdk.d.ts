/**
 * Type declarations for openclaw/plugin-sdk
 * Since openclaw doesn't ship .d.ts files, we declare the module here
 */
declare module "openclaw/plugin-sdk" {
  import type { Static, TSchema } from "@sinclair/typebox";

  // Core types
  export interface OpenclawPluginApi {
    runtime: OpenclawRuntime;
    registerChannel(opts: { plugin: ChannelPlugin<any> }): void;
    registerHttpHandler(handler: HttpHandler): void;
  }

  export interface OpenclawRuntime {
    config: any;
    logger: any;
    handleInbound(event: InboundEvent): Promise<void>;
    emitInbound?(event: InboundEvent): Promise<void>;
  }

  // HTTP Handler - 使用 Node.js 原生 http 模块的 (req, res) 接口
  import type { IncomingMessage, ServerResponse } from "node:http";
  export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

  export interface InboundEvent {
    channel: string;
    accountId?: string;
    chatType: "direct" | "group";
    chatId: string;
    senderId?: string;
    authorId?: string;
    senderName?: string;
    authorName?: string;
    text?: string;
    messageId?: string;
    replyToId?: string;
    media?: MediaAttachment[];
    location?: LocationContext;
    timestamp?: number;
    raw?: any;
  }

  export interface MediaAttachment {
    type: "image" | "audio" | "video" | "file";
    url?: string;
    path?: string;
    mimeType?: string;
    filename?: string;
  }

  export interface LocationContext {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  }

  // Channel Plugin types
  export interface ChannelPlugin<TAccount = any> {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[] };
    onboarding?: ChannelOnboardingAdapter;
    config: ChannelConfigHandlers<TAccount>;
    setup?: ChannelSetupHandlers;
    outbound?: ChannelOutboundHandlers;
    gateway?: ChannelGatewayHandlers;
    status?: ChannelStatusHandlers<TAccount>;
    sendText?: (ctx: SendTextContext) => Promise<SendResult>;
    sendMedia?: (ctx: SendMediaContext) => Promise<SendResult>;
    startAccount?: (ctx: AccountStartContext) => Promise<void>;
    stopAccount?: (ctx: AccountStopContext) => Promise<void>;
    buildAccountSnapshot?: (ctx: AccountSnapshotContext<TAccount>) => AccountSnapshot;
  }

  export interface ChannelMeta {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    blurb?: string;
    order?: number;
  }

  export interface ChannelCapabilities {
    chatTypes: ("direct" | "group")[];
    media?: boolean;
    reactions?: boolean;
    threads?: boolean;
  }

  export interface ChannelConfigHandlers<TAccount> {
    listAccountIds: (cfg: any) => string[];
    resolveAccount: (cfg: any, accountId: string) => TAccount | undefined;
    defaultAccountId: () => string;
    isConfigured: (account: TAccount | undefined) => boolean;
    describeAccount: (account: TAccount | undefined) => AccountDescription;
  }

  export interface AccountDescription {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    tokenSource?: string;
  }

  export interface ChannelSetupHandlers {
    validateInput?: (ctx: { input: any }) => string | null | undefined;
    applyAccountConfig?: (ctx: { cfg: any; accountId: string; input: any }) => any;
  }

  export interface ChannelOutboundHandlers {
    deliveryMode?: "direct" | "queued";
    textChunkLimit?: number;
    sendText?: (ctx: OutboundSendTextContext) => Promise<OutboundSendResult>;
    sendMedia?: (ctx: OutboundSendMediaContext) => Promise<OutboundSendResult>;
  }

  export interface OutboundSendTextContext {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    cfg: any;
  }

  export interface OutboundSendMediaContext extends OutboundSendTextContext {
    media: MediaAttachment[];
  }

  export interface OutboundSendResult {
    channel: string;
    messageId?: string;
    error?: Error;
  }

  export interface ChannelGatewayHandlers {
    startAccount?: (ctx: GatewayStartContext) => Promise<void>;
    stopAccount?: (ctx: GatewayStopContext) => Promise<void>;
  }

  export interface GatewayStartContext {
    accountId: string;
    account: any;
    cfg: any;
    runtime: OpenclawRuntime;
    abortSignal: AbortSignal;
    log?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    getStatus: () => AccountRuntimeStatus;
    setStatus: (status: AccountRuntimeStatus) => void;
  }

  export interface GatewayStopContext {
    accountId: string;
  }

  export interface AccountRuntimeStatus {
    running: boolean;
    connected: boolean;
    lastConnectedAt: number | null;
    lastError: string | null;
  }

  export interface ChannelStatusHandlers<TAccount> {
    defaultRuntime?: AccountRuntimeStatus & { accountId: string };
    buildAccountSnapshot?: (ctx: StatusSnapshotContext<TAccount>) => any;
  }

  export interface StatusSnapshotContext<TAccount> {
    account: TAccount | undefined;
    runtime: AccountRuntimeStatus | undefined;
  }

  export interface SendTextContext {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    cfg: any;
  }

  export interface SendMediaContext extends SendTextContext {
    media: MediaAttachment[];
  }

  export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: string;
  }

  export interface AccountStartContext {
    accountId: string;
    account: any;
    cfg: any;
    runtime: OpenclawRuntime;
  }

  export interface AccountStopContext {
    accountId: string;
  }

  export interface AccountSnapshotContext<TAccount> {
    account: TAccount;
    runtime: { healthy: boolean };
  }

  export interface AccountSnapshot {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    healthy: boolean;
  }

  // HTTP Handler types
  export interface HttpHandlerContext {
    req: {
      method: string;
      headers: Record<string, string | string[] | undefined>;
      body?: any;
      rawBody?: Buffer;
    };
    url: URL;
    params?: Record<string, string>;
  }

  export interface HttpHandlerResult {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer | object;
  }

  // Onboarding types
  export interface ChannelOnboardingAdapter {
    channel: string;
    getStatus: (ctx: ChannelOnboardingStatusContext) => Promise<ChannelOnboardingStatus>;
    configure: (ctx: ChannelOnboardingConfigureContext) => Promise<ChannelOnboardingResult>;
    disable?: (cfg: any) => any;
  }

  export interface ChannelOnboardingStatusContext {
    cfg: any;
  }

  export interface ChannelOnboardingStatus {
    channel: string;
    configured: boolean;
    statusLines: string[];
    selectionHint?: string;
    quickstartScore?: number;
  }

  export interface ChannelOnboardingConfigureContext {
    cfg: any;
    prompter: OnboardingPrompter;
    accountOverrides?: Record<string, string>;
    shouldPromptAccountIds?: boolean;
  }

  export interface OnboardingPrompter {
    text(opts: {
      message: string;
      default?: string;
      placeholder?: string;
      initialValue?: string;
      validate?: (v: string) => string | undefined | true;
    }): Promise<string>;
    password(opts: { message: string }): Promise<string>;
    confirm(opts: { message: string; default?: boolean; initialValue?: boolean }): Promise<boolean>;
    select<T>(opts: {
      message: string;
      choices?: { name: string; value: T }[];
      options?: { value: T; label: string }[];
      initialValue?: T;
    }): Promise<T>;
    note(content: string, title?: string): Promise<void>;
  }

  export interface ChannelOnboardingResult {
    success?: boolean;
    cfg?: any;
    accountId?: string;
    message?: string;
    error?: string;
  }

  // Legacy aliases
  export type OnboardingAdapter = ChannelOnboardingAdapter;

  // Utility exports
  export function normalizePluginHttpPath(path: string): string;
  export function registerPluginHttpRoute(route: any): void;
  export function emptyPluginConfigSchema(): TSchema;
  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(id: string | undefined): string;
}
