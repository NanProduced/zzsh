import {
  ImLifecycleSupersededError,
  type ImClientContext,
  type ImClientFactory,
  type ImClientHandle,
} from "./im-client-lifecycle.ts";
import { createNimReceiptReporter, type NimReceiptStatus } from "./message-receipts.ts";
import { orderReferenceSummary } from "./order-reference.ts";
export { encodeOrderReference, parseOrderReference, orderReferenceSummary, type OrderReference } from "./order-reference.ts";
export { NIM_RECEIPT_PENDING, NimReceiptActionError, type NimReceiptStatus } from "./message-receipts.ts";

export type NimWebConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "KICKED" | "AUTH_FAILED";
type NimListener = (...args: unknown[]) => void;

export type NimMessageReplySummary = { messageId: string; senderId: string; text?: string };

/**
 * Client-side mirror of the API media limits. Values must stay aligned with
 * `apps/api/src/im/im-contract.ts`; the server remains authoritative.
 */
export const NIM_MEDIA_LIMITS = {
  video: {
    maxBytes: 100 * 1024 * 1024,
    mimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  },
  file: {
    maxBytes: 50 * 1024 * 1024,
    mimeTypes: [
      "application/pdf",
      "application/zip",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  audio: {
    maxBytes: 20 * 1024 * 1024,
    mimeTypes: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav"],
  },
} as const satisfies Record<string, { maxBytes: number; mimeTypes: readonly string[] }>;

export type NimMediaKind = keyof typeof NIM_MEDIA_LIMITS;

/** V2 NIM message types of real media messages (verified against the SDK). */
const NIM_MEDIA_KIND_BY_MESSAGE_TYPE: Record<number, NimMediaKind> = { 2: "audio", 3: "video", 6: "file" };
/** Incoming NIM attachments carry a name/ext but no MIME type; derive it from the allowlist. */
const NIM_MEDIA_MIME_BY_EXTENSION: Record<NimMediaKind, Record<string, string>> = {
  video: { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" },
  file: {
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  audio: { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav" },
};
const NIM_MEDIA_URL_MAX_LENGTH = 2048;
const NIM_MEDIA_DIMENSION_MAX = 8192;
const NIM_MEDIA_DURATION_MS_MAX = 24 * 60 * 60 * 1000;

/** Safe server-owned media metadata; `url` is an authorized download path. */
export type NimMessageMedia = {
  mediaId: string;
  kind: NimMediaKind;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  url?: string;
};

export type NimMessageLike = {
  messageClientId: string;
  messageServerId?: string;
  conversationId: string;
  conversationType?: number;
  senderId: string;
  receiverId: string;
  createTime: number;
  text?: string;
  messageType?: number;
  attachment?: { raw?: string; url?: string; name?: string; [key: string]: unknown };
  media?: NimMessageMedia;
  sendingState?: number;
  reply?: NimMessageReplySummary;
  revoked?: boolean;
  card?: { kind: "ORDER_OPENING"|"ORDER_ENDING"|"ORDER_SETTLED"|"ORDER_PRICE_CHANGE"; orderId: string; cardId: string };
};

export const NIM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const NIM_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export type NimImageMimeType = (typeof NIM_IMAGE_MIME_TYPES)[number];
export type NimImageSendOptions = {
  authorize?: NimMessageAuthorization;
  onProgress?: (percentage: number) => void;
  width?: number;
  height?: number;
};
export type NimMessageRouteGrant = { appId: string; orderId: string; teamId: string; conversationId: string; routeEnvironment: string };
type NimV2SendMessageParams = { routeConfig: { routeEnabled: true; routeEnvironment: string } };
export type NimImageSendErrorKind = "FAILED" | "UNKNOWN";
export type NimMediaSendErrorKind = "FAILED" | "UNKNOWN" | "UNSUPPORTED";

export type NimMediaSendOptions = {
  authorize?: NimMessageAuthorization;
  onProgress?: (percentage: number) => void;
  width?: number;
  height?: number;
  durationMs?: number;
};

export class NimMediaSendError extends Error {
  readonly kind: NimMediaSendErrorKind;
  readonly messageClientId?: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(kind: NimMediaSendErrorKind, message: string, options: { messageClientId?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "NimMediaSendError";
    this.kind = kind;
    this.messageClientId = options.messageClientId;
    this.status = (options.cause as { status?: number } | undefined)?.status;
    this.cause = options.cause;
  }
}

export class NimImageSendError extends Error {
  readonly kind: NimImageSendErrorKind;
  readonly messageClientId?: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(kind: NimImageSendErrorKind, message: string, options: { messageClientId?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "NimImageSendError";
    this.kind = kind;
    this.messageClientId = options.messageClientId;
    this.status = (options.cause as { status?: number } | undefined)?.status;
    this.cause = options.cause;
  }
}

/**
 * Text sends keep the SDK-created message (and its messageClientId) so an
 * unknown result can be retried with the same message instead of a new one.
 */
export class NimTextSendError extends Error {
  readonly kind: NimImageSendErrorKind;
  readonly messageClientId?: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(kind: NimImageSendErrorKind, message: string, options: { messageClientId?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "NimTextSendError";
    this.kind = kind;
    this.messageClientId = options.messageClientId;
    this.status = (options.cause as { status?: number } | undefined)?.status;
    this.cause = options.cause;
  }
}

export function validateNimImageFile(file: File): NimImageMimeType {
  if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.type !== "string" || !Number.isInteger(file.size)) {
    throw new TypeError("图片文件无效");
  }
  const mimeType = file.type.toLowerCase() as NimImageMimeType;
  if (!NIM_IMAGE_MIME_TYPES.includes(mimeType)) throw new TypeError("仅支持 JPG 或 PNG 图片");
  if (file.size <= 0) throw new TypeError("图片不能为空");
  if (file.size > NIM_IMAGE_MAX_BYTES) throw new TypeError("图片不能超过 10 MiB");
  return mimeType;
}

function isNimMediaKind(value: unknown): value is NimMediaKind {
  return value === "video" || value === "file" || value === "audio";
}

function nimMediaLabel(kind: NimMediaKind): string {
  return kind === "video" ? "[视频]" : kind === "file" ? "[文件]" : "[语音]";
}

export function validateNimMediaFile(file: File, kind: NimMediaKind): string {
  if (!isNimMediaKind(kind)) throw new TypeError("媒体类型无效");
  if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.type !== "string" || !Number.isInteger(file.size)) {
    throw new TypeError("媒体文件无效");
  }
  const mimeType = file.type.toLowerCase();
  const limit = NIM_MEDIA_LIMITS[kind];
  if (!(limit.mimeTypes as readonly string[]).includes(mimeType)) throw new TypeError("不支持该媒体格式");
  if (file.size <= 0) throw new TypeError("媒体文件不能为空");
  if (file.size > limit.maxBytes) throw new TypeError(`媒体文件不能超过 ${Math.floor(limit.maxBytes / 1024 / 1024)} MiB`);
  if (!file.name || file.name.length > 255 || /[\u0000-\u001F\u007F]/.test(file.name)) throw new TypeError("媒体文件名无效");
  return mimeType;
}

/** Validate the optional send metadata before any SDK message is created. */
function validateNimMediaSendOptions(kind: NimMediaKind, options: NimMediaSendOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("媒体发送参数无效");
  const dimension = (value: unknown, label: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > NIM_MEDIA_DIMENSION_MAX) throw new TypeError(`${label}无效`);
    return value;
  };
  const width = dimension(options.width, "视频宽度");
  const height = dimension(options.height, "视频高度");
  if ((width === undefined) !== (height === undefined)) throw new TypeError("视频宽高必须同时提供");
  if (width !== undefined && kind !== "video") throw new TypeError("仅视频消息支持宽高");
  if (options.durationMs !== undefined) {
    if (kind === "file") throw new TypeError("文件消息不支持时长");
    if (!Number.isInteger(options.durationMs) || options.durationMs < 1 || options.durationMs > NIM_MEDIA_DURATION_MS_MAX) throw new TypeError("媒体时长无效");
  }
}

/**
 * A platform media URL is either this site's authorized relative download
 * path or an absolute https URL uploaded by NIM cloud storage. Everything
 * else (javascript:, data:, http:, relative non-API paths, whitespace) is
 * rejected and the URL is omitted from the envelope.
 */
function safeNimMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > NIM_MEDIA_URL_MAX_LENGTH || /[\u0000-\u0020\u007F]/.test(value)) return undefined;
  if (/^\/api\/(?:bff\/admin\/)?im\/media\/[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  if (!value.startsWith("https://")) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password ? value : undefined;
  } catch {
    return undefined;
  }
}

function nimMediaExtension(name: string, ext: unknown): string | undefined {
  // The SDK writes `ext` with a leading dot (".mp4"), other clients may omit it.
  const candidate = typeof ext === "string" && /^\.?[A-Za-z0-9]{1,10}$/.test(ext) ? ext.replace(/^\./, "") : /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1];
  return candidate?.toLowerCase();
}

function nimMediaMimeType(kind: NimMediaKind, name: string, ext: unknown): string | undefined {
  const extension = nimMediaExtension(name, ext);
  return extension ? NIM_MEDIA_MIME_BY_EXTENSION[kind][extension] : undefined;
}

/** Stable media ID from the attachment md5, upload URL, or message ID. */
function nimMediaId(...seeds: Array<string | undefined>): string {
  for (const seed of seeds) if (seed && /^[A-Za-z0-9._:-]{1,120}$/.test(seed)) return seed;
  const text = seeds.filter((seed): seed is string => Boolean(seed)).join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `nim-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function nimMediaAttachmentView(media: NimMessageMedia): NonNullable<NimMessageLike["attachment"]> {
  return { name: media.name, size: media.size, mimeType: media.mimeType, ...(media.url ? { url: media.url } : {}) };
}

/**
 * Map a real NIM audio/video/file attachment (messageType 2/3/6) into the
 * safe envelope. The NIM storage URL must be https; missing or malformed
 * metadata drops the whole attachment instead of rendering it.
 */
function nimMediaFromAttachment(kind: NimMediaKind, attachment: unknown, messageClientId: string): NimMessageMedia | undefined {
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return undefined;
  const raw = attachment as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : "";
  const mimeType = nimMediaMimeType(kind, name, raw.ext);
  if (!mimeType) return undefined;
  if (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 1) return undefined;
  const url = raw.url === undefined ? undefined : safeNimMediaUrl(raw.url);
  if (raw.url !== undefined && url === undefined) return undefined;
  const dimension = (value: unknown): number | null | undefined => {
    if (value === undefined || value === null || value === 0) return undefined;
    return kind === "video" && typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= NIM_MEDIA_DIMENSION_MAX ? value : null;
  };
  const width = dimension(raw.width);
  const height = dimension(raw.height);
  // V2 attachment.duration and V1 attachment.dur are milliseconds; 0 means unknown.
  const duration = raw.duration;
  const durationMs = kind === "file" || duration === undefined || duration === null || duration === 0
    ? undefined
    : typeof duration === "number" && Number.isFinite(duration) && duration > 0 && Math.round(duration) <= NIM_MEDIA_DURATION_MS_MAX ? Math.round(duration) : null;
  if (width === null || height === null || durationMs === null) return undefined;
  return parseNimMessageMedia({
    mediaId: nimMediaId(typeof raw.md5 === "string" ? `nim-${raw.md5}` : undefined, url, `nim-${messageClientId}`),
    kind,
    name,
    mimeType,
    size: raw.size,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(url === undefined ? {} : { url }),
  });
}

/**
 * Keep only the safe metadata envelope. A media URL is accepted only when it
 * is this platform's authorized relative download path or an https upload
 * URL; unknown or malformed metadata makes the whole media attachment
 * unsupported.
 */
export function parseNimMessageMedia(value: unknown): NimMessageMedia | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const media = value as Record<string, unknown>;
  if (typeof media.mediaId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(media.mediaId)) return undefined;
  if (!isNimMediaKind(media.kind)) return undefined;
  if (typeof media.name !== "string" || !media.name || media.name.length > 255 || /[\u0000-\u001F\u007F]/.test(media.name)) return undefined;
  if (typeof media.mimeType !== "string") return undefined;
  if (!(NIM_MEDIA_LIMITS[media.kind].mimeTypes as readonly string[]).includes(media.mimeType)) return undefined;
  if (typeof media.size !== "number" || !Number.isInteger(media.size) || media.size < 1 || media.size > NIM_MEDIA_LIMITS[media.kind].maxBytes) return undefined;
  const optional = (key: "width" | "height" | "durationMs", max: number): number | null | undefined => {
    const field = media[key];
    if (field === undefined) return undefined;
    return typeof field === "number" && Number.isInteger(field) && field >= 1 && field <= max ? field : null;
  };
  const width = optional("width", NIM_MEDIA_DIMENSION_MAX);
  const height = optional("height", NIM_MEDIA_DIMENSION_MAX);
  const durationMs = optional("durationMs", NIM_MEDIA_DURATION_MS_MAX);
  if (width === null || height === null || durationMs === null) return undefined;
  if ((width === undefined) !== (height === undefined)) return undefined;
  if (media.kind === "file" && (width !== undefined || durationMs !== undefined)) return undefined;
  if (media.kind === "audio" && width !== undefined) return undefined;
  const safeUrl = safeNimMediaUrl(media.url);
  return {
    mediaId: media.mediaId,
    kind: media.kind,
    name: media.name,
    mimeType: media.mimeType,
    size: media.size,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(safeUrl ? { url: safeUrl } : {}),
  };
}

export function oldestNimMessage(messages: readonly NimMessageLike[]): NimMessageLike | undefined {
  return messages.reduce<NimMessageLike | undefined>((oldest, item) => {
    if (!oldest) return item;
    if (item.createTime !== oldest.createTime) return item.createTime < oldest.createTime ? item : oldest;
    const nextId = item.messageServerId || item.messageClientId, oldId = oldest.messageServerId || oldest.messageClientId;
    const earlier = /^[0-9]{1,20}$/.test(nextId) && /^[0-9]{1,20}$/.test(oldId) ? BigInt(nextId) < BigInt(oldId) : nextId < oldId;
    return earlier ? item : oldest;
  }, undefined);
}

export type NimWebClientLike = {
  readonly accountId: string;
  readonly transport?: "nim" | "local-fake";
  getConnectionState(): NimWebConnectionState;
  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void;
  onMessages(listener: (messages: NimMessageLike[]) => void): () => void;
  getMessageHistory(conversationId: string, limit?: number, before?: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike[]>;
  sendText(conversationId: string, text: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike>;
  retryText(conversationId: string, messageClientId: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike>;
  sendImage(conversationId: string, file: File, options?: NimImageSendOptions): Promise<NimMessageLike>;
  retryImage(conversationId: string, messageClientId: string, options?: NimImageSendOptions): Promise<NimMessageLike>;
  sendMedia(conversationId: string, file: File, kind: NimMediaKind, options?: NimMediaSendOptions): Promise<NimMessageLike>;
  retryMedia(conversationId: string, messageClientId: string, options?: NimMediaSendOptions): Promise<NimMessageLike>;
  replyText(conversationId: string, text: string, replyTo: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike>;
  revokeMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike>;
  deleteMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<void>;
};

type NimMessageServiceLike = {
  on: (eventName: string, listener: NimListener) => void;
  off: (eventName: string, listener: NimListener) => void;
  sendMessage: (message: unknown, conversationId: string, params?: NimV2SendMessageParams, progress?: (percentage: number) => void) => Promise<{ message?: NimMessageLike }>;
  getMessageList?: (options: Record<string, unknown>) => Promise<NimMessageLike[]>;
  replyMessage?: (message: unknown, replyTo: unknown, params?: NimV2SendMessageParams) => Promise<{ message?: NimMessageLike }>;
  revokeMessage?: (message: unknown) => Promise<void>;
  deleteMessage?: (message: unknown) => Promise<void>;
};
type NimMessageCreatorLike = {
  createTextMessage: (text: string) => unknown;
  createImageMessage?: (image: File, name?: string, sceneName?: string, width?: number, height?: number) => unknown;
  createVideoMessage?: (video: File, name?: string, sceneName?: string, duration?: number, width?: number, height?: number) => unknown;
  createFileMessage?: (file: File, name?: string, sceneName?: string) => unknown;
  createAudioMessage?: (audio: File, name?: string, sceneName?: string, duration?: number) => unknown;
};
type NimConversationIdUtilLike = {
  p2pConversationId: (accountId: string) => string;
  teamConversationId?: (teamId: string) => string;
};
type NimLoginServiceLike = {
  on: (eventName: string, listener: NimListener) => void;
  off: (eventName: string, listener: NimListener) => void;
  login: (accountId: string, token: string, options?: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
};

export type NimInstanceLike = {
  V2NIMLoginService: NimLoginServiceLike;
  V2NIMMessageService?: NimMessageServiceLike;
  V2NIMMessageCreator?: NimMessageCreatorLike;
  V2NIMStorageService?: object;
  V2NIMConversationIdUtil?: NimConversationIdUtilLike;
  destroy: () => Promise<void>;
};
export type NimSdkLike = { getInstance: (options: { appkey: string; apiVersion: "v2"; debugLevel: "off" | "error" | "warn" | "log" | "debug"; enableV2CloudConversation: false }, otherOptions?: Record<string, unknown>) => NimInstanceLike };

function localTransportError(message: string, status: number): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
export type NimTokenProvider = (accountId: string) => Promise<string>;
export type NimMessageAuthorization = (input: { conversationId: string; operation: "read" | "send"; messageClientId?:string; messageType?:number }) => Promise<void | NimMessageRouteGrant>;
export type NimWebClientOptions = {
  appKey: string;
  accountId?: string;
  token?: string;
  tokenProvider?: NimTokenProvider;
  messageAuthorization?: NimMessageAuthorization;
  messageReceiptEndpoint?: string;
  onReceiptStatus?: (status:NimReceiptStatus)=>void;
  debugLevel?: "off" | "error" | "warn" | "log" | "debug";
  retryCount?: number;
  timeout?: number;
  forceMode?: boolean;
  lbsUrls?: readonly string[];
  linkUrl?: string;
};
export type NimSdkLoader = () => Promise<NimSdkLike>;

const DEFAULT_DEBUG_LEVEL = "off" as const;
function requireNonBlank(value: string, name: string): string { if (typeof value !== "string") throw new TypeError(`${name} must be a string`); const normalized = value.trim(); if (!normalized) throw new TypeError(`${name} must not be blank`); return normalized; }
function validateOptions(options: NimWebClientOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("NIM options are required");
  if (requireNonBlank(options.appKey, "NIM app key").length > 128) throw new TypeError("NIM app key must be at most 128 characters");
  if (options.accountId !== undefined && requireNonBlank(options.accountId, "NIM account ID").length > 128) throw new TypeError("NIM account ID must be at most 128 characters");
  if (options.tokenProvider && options.token !== undefined) throw new TypeError("NIM token and tokenProvider are mutually exclusive");
  if (options.tokenProvider !== undefined && typeof options.tokenProvider !== "function") throw new TypeError("NIM tokenProvider must be a function");
  if (options.messageAuthorization !== undefined && typeof options.messageAuthorization !== "function") throw new TypeError("NIM message authorization must be a function");
  if(options.messageReceiptEndpoint!==undefined&&!/^\/api\/(?:im\/messages|bff\/admin\/im\/messages)$/.test(options.messageReceiptEndpoint))throw new TypeError("NIM receipt endpoint must be same-origin");
  if (!options.tokenProvider) requireNonBlank(options.token ?? "", "NIM token");
  if (options.retryCount !== undefined && (!Number.isInteger(options.retryCount) || options.retryCount < 1)) throw new TypeError("NIM retryCount must be a positive integer");
  if (options.timeout !== undefined && (!Number.isInteger(options.timeout) || options.timeout < 1)) throw new TypeError("NIM timeout must be a positive integer");
  for (const url of options.lbsUrls ?? []) { const parsed = new URL(url); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("NIM lbsUrls must contain valid http(s) URLs"); }
  if (options.linkUrl) { const parsed = new URL(options.linkUrl); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("NIM linkUrl must be a valid http(s) URL"); }
}
function mapConnectStatus(status: unknown): NimWebConnectionState | undefined { return status === 0 ? "DISCONNECTED" : status === 1 ? "CONNECTED" : status === 2 ? "CONNECTING" : status === 3 ? "RECONNECTING" : undefined; }
function messageClientIdOf(message: unknown): string {
  const id = (message as { messageClientId?: unknown } | null)?.messageClientId;
  if (typeof id !== "string" || !id.trim()) throw new Error("NIM image message ID is unavailable");
  return id;
}
function imageProgress(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function localImageClientId(): string {
  return `local-image-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
function localTextClientId(): string {
  return `local-text-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
function localMediaClientId(): string {
  return `local-media-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function localMessageReference(message: NimMessageLike, conversationId: string): { messageServerId?: string; messageClientId: string } {
  if (!message || typeof message !== "object" || typeof message.messageClientId !== "string" || !message.messageClientId) {
    throw new TypeError("Local IM message is invalid");
  }
  if (message.conversationId && message.conversationId !== conversationId) throw new TypeError("Local IM message does not belong to the conversation");
  return {
    ...(typeof message.messageServerId === "string" && message.messageServerId ? { messageServerId: message.messageServerId } : {}),
    messageClientId: message.messageClientId,
  };
}

function localActionMessage(value: Record<string, unknown>): NimMessageLike {
  const message = value.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("IM message response is invalid");
  return message as NimMessageLike;
}

const REPLY_SUMMARY_MAX = 120;

function messageSummary(message: NimMessageLike): string | undefined {
  if (message.messageType === 1) return "[图片]";
  if (message.media) return nimMediaLabel(message.media.kind);
  const text = typeof message.text === "string" ? orderReferenceSummary(message.text).trim().slice(0, REPLY_SUMMARY_MAX) : "";
  return text || undefined;
}

function replySummary(value: unknown): NimMessageReplySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  const messageId = typeof reply.messageServerId === "string" && reply.messageServerId
    ? reply.messageServerId
    : typeof reply.messageClientId === "string" ? reply.messageClientId : "";
  if (!messageId || typeof reply.senderId !== "string" || !reply.senderId) return undefined;
  return {
    messageId,
    senderId: reply.senderId,
    ...(typeof reply.text === "string" && reply.text ? { text: reply.text.slice(0, REPLY_SUMMARY_MAX) } : {}),
  };
}

export function nimMessageView(value: unknown): NimMessageLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as NimMessageLike & Record<string, unknown>;
  if (typeof message.messageClientId !== "string" || !message.messageClientId) return null;
  const revoked = message.revoked === true || message.isRevoked === true;
  const reply = replySummary(message.reply) ?? replySummary(message.threadReply);
  // Real NIM audio/video/file messages (2/3/6) are mapped from their raw
  // attachment; the platform's own `media` envelope is always trusted only
  // after re-validation. Unsafe raw attachments are stripped from the view.
  const realKind = typeof message.messageType === "number" ? NIM_MEDIA_KIND_BY_MESSAGE_TYPE[message.messageType] : undefined;
  const hasEnvelope = message.media !== undefined;
  const envelope = hasEnvelope ? parseNimMessageMedia(message.media) : undefined;
  const media = envelope ?? (realKind === undefined ? undefined : nimMediaFromAttachment(realKind, message.attachment, message.messageClientId));
  const hasMedia = hasEnvelope || media !== undefined;
  const stripAttachment = realKind !== undefined && media === undefined;
  if (!revoked && !reply && !hasMedia && !stripAttachment) return message;
  // Keep the SDK message object intact for later SDK calls; only replace the
  // neutral summary fields and strip content from a revoked message.
  const view: NimMessageLike & Record<string, unknown> = { ...message };
  if (reply) view.reply = reply;
  if (media) {
    view.media = media;
    if (realKind !== undefined) view.attachment = nimMediaAttachmentView(media);
  } else if (hasMedia) delete view.media;
  if (stripAttachment) delete view.attachment;
  if (revoked) {
    view.text = "";
    view.revoked = true;
    delete view.attachment;
    delete view.media;
    delete view.reply;
    delete view.threadReply;
    delete view.isRevoked;
  }
  return view;
}

function revokedMessageView(message: NimMessageLike): NimMessageLike {
  return {
    messageClientId: message.messageClientId,
    ...(message.messageServerId ? { messageServerId: message.messageServerId } : {}),
    conversationId: message.conversationId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    createTime: message.createTime,
    ...(message.messageType === undefined ? {} : { messageType: message.messageType }),
    text: "",
    revoked: true,
  };
}

function revokedNotificationView(value: unknown): NimMessageLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const refer = (value as { messageRefer?: unknown }).messageRefer;
  if (!refer || typeof refer !== "object" || Array.isArray(refer)) return null;
  const ref = refer as Record<string, unknown>;
  const clientId = typeof ref.messageClientId === "string" ? ref.messageClientId : "";
  const serverId = typeof ref.messageServerId === "string" ? ref.messageServerId : "";
  if (!clientId && !serverId) return null;
  return {
    messageClientId: clientId || serverId,
    ...(serverId ? { messageServerId: serverId } : {}),
    conversationId: typeof ref.conversationId === "string" ? ref.conversationId : "",
    senderId: typeof ref.senderId === "string" ? ref.senderId : "",
    receiverId: typeof ref.receiverId === "string" ? ref.receiverId : "",
    createTime: typeof ref.createTime === "number" ? ref.createTime : 0,
    text: "",
    revoked: true,
  };
}
async function loadNimSdk(): Promise<NimSdkLike> {
  if (typeof window === "undefined") throw new Error("NIM Web SDK can only load in a browser");
  const module = (await import("nim-web-sdk-ng")) as unknown as { default?: NimSdkLike };
  const sdk = resolveNimSdkModule(module);
  if (!sdk) throw new Error("NIM Web SDK is unavailable");
  return sdk;
}

export function resolveNimSdkModule(module: { default?: unknown }): NimSdkLike | undefined {
  const hasGetInstance = (value: unknown): value is NimSdkLike => Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { getInstance?: unknown }).getInstance === "function");
  const candidate = module.default;
  if (hasGetInstance(candidate)) return candidate;
  const nested = candidate && typeof candidate === "object" ? (candidate as { default?: unknown }).default : undefined;
  return hasGetInstance(nested) ? nested : undefined;
}

type PendingNimMedia = {
  conversationId: string;
  message: unknown;
  media: Omit<NimMessageMedia, "mediaId" | "url">;
};

/** Build the sent-message view: local metadata plus the uploaded https URL. */
function nimSentMediaView(message: NimMessageLike, meta: PendingNimMedia["media"]): NimMessageLike {
  const attachment = message.attachment && typeof message.attachment === "object" && !Array.isArray(message.attachment) ? message.attachment : undefined;
  const url = safeNimMediaUrl(attachment?.url);
  const mediaId = nimMediaId(
    typeof attachment?.md5 === "string" ? `nim-${attachment.md5}` : undefined,
    url,
    `nim-${message.messageClientId}`,
  );
  const media = parseNimMessageMedia({ ...meta, mediaId, ...(url === undefined ? {} : { url }) });
  if (!media) return message;
  return { ...message, media, attachment: nimMediaAttachmentView(media) };
}

export class NimWebClient implements NimWebClientLike {
  private readonly receipts?:ReturnType<typeof createNimReceiptReporter>;
  readonly transport = "nim" as const;
  readonly accountId: string;
  readonly nim: NimInstanceLike;
  private readonly context: ImClientContext;
  private readonly messageService?: NimMessageServiceLike;
  private readonly messageAuthorization?: NimMessageAuthorization;
  private readonly messageEventHandler?: NimListener;
  private state: NimWebConnectionState = "DISCONNECTED";
  private loggedIn = false;
  private disposed = false;
  private readonly listeners = new Set<(state: NimWebConnectionState) => void>();
  private readonly messageListeners = new Set<(messages: NimMessageLike[]) => void>();
  private readonly eventHandlers: Array<[string, NimListener]> = [];
  private readonly messageEventHandlers: Array<[string, NimListener]> = [];
  private readonly pendingImages = new Map<string, { conversationId: string; message: unknown }>();
  private readonly pendingTexts = new Map<string, { conversationId: string; message: unknown }>();
  private readonly pendingMedia = new Map<string, PendingNimMedia>();

  constructor(context: ImClientContext, nim: NimInstanceLike, accountId: string, messageAuthorization?: NimMessageAuthorization, receiptOptions?:Pick<NimWebClientOptions,"appKey"|"messageReceiptEndpoint"|"onReceiptStatus">) {
    this.context = context; this.nim = nim; this.accountId = accountId; this.messageAuthorization = messageAuthorization;
    if(receiptOptions?.messageReceiptEndpoint)this.receipts=createNimReceiptReporter({endpoint:receiptOptions.messageReceiptEndpoint,scope:`${receiptOptions.appKey}:${accountId}`,status:context.onCurrent(receiptOptions.onReceiptStatus??(()=>{}))});
    const loginService = nim.V2NIMLoginService; this.messageService = nim.V2NIMMessageService;
    const bind = (eventName: string, handler: (...args: unknown[]) => void) => { const guarded = context.onCurrent(handler); loginService.on(eventName, guarded); this.eventHandlers.push([eventName, guarded]); };
    bind("onConnectStatus", (status) => { const next = mapConnectStatus(status); if (next) this.setState(next); });
    bind("onLoginStatus", (status) => { if (status === 2) this.setState("CONNECTING"); if (status === 0 && this.state !== "KICKED" && this.state !== "AUTH_FAILED") this.setState("DISCONNECTED"); });
    bind("onLoginFailed", () => this.setState("AUTH_FAILED")); bind("onKickedOffline", () => this.setState("KICKED")); bind("onDisconnected", () => this.setState("DISCONNECTED")); bind("onConnectFailed", () => this.setState("RECONNECTING"));
    if (this.messageService) {
      const bindMessage = (eventName: string, normalize: (value: unknown) => NimMessageLike | null) => {
        const guarded = context.onCurrent((values: unknown) => {
          if (!Array.isArray(values)) return;
          const views = values.map(normalize).filter((message): message is NimMessageLike => message !== null);
          if (views.length) for (const listener of this.messageListeners) listener(views);
        });
        try { this.messageService!.on(eventName, guarded); this.messageEventHandlers.push([eventName, guarded]); } catch { /* an older SDK build may not expose the event */ }
      };
      bindMessage("onReceiveMessages", nimMessageView);
      // Modified/revoked messages are merged by the consumer's message-state merge.
      bindMessage("onReceiveMessagesModified", nimMessageView);
      bindMessage("onMessageRevokeNotifications", revokedNotificationView);
    }
  }
  getConnectionState(): NimWebConnectionState { return this.state; }
  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onMessages(listener: (messages: NimMessageLike[]) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  conversationIdForPeer(peerAccountId: string): string { const peer = requireNonBlank(peerAccountId, "NIM peer account ID"); if (!this.nim.V2NIMConversationIdUtil) throw new Error("NIM conversation utility is unavailable"); return this.nim.V2NIMConversationIdUtil.p2pConversationId(peer); }
  conversationIdForTeam(teamId: string): string { const id = requireNonBlank(teamId, "NIM team ID"); if (!this.nim.V2NIMConversationIdUtil?.teamConversationId) throw new Error("NIM team conversation utility is unavailable"); return this.nim.V2NIMConversationIdUtil.teamConversationId(id); }
  async getMessageHistory(conversationId: string, limit = 50, before?: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike[]> { this.assertCurrent(); const id = requireNonBlank(conversationId, "NIM conversation ID"); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("NIM history limit must be between 1 and 100"); if (!this.messageService?.getMessageList) throw new Error("NIM message history is unavailable"); await this.authorizeMessage(id, "read", authorize); const messages = await this.messageService.getMessageList({ conversationId: id, limit, direction: 0, ...(before ? { anchorMessage: before } : {}) }); this.assertCurrent(); return Array.isArray(messages) ? messages.map(nimMessageView).filter((message): message is NimMessageLike => message !== null) : []; }
  async sendText(conversationId: string, text: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const body = requireNonBlank(text, "NIM message text");
    if (body.length > 4_000) throw new TypeError("NIM message text must be at most 4000 characters");
    if (!this.messageService || !this.nim.V2NIMMessageCreator) throw new Error("NIM message sending is unavailable");
    const message=this.nim.V2NIMMessageCreator.createTextMessage(body);
    const messageClientId = messageClientIdOf(message);
    const params=await this.authorizeMessage(id, "send", authorize,{messageClientId,messageType:0});
    this.pendingTexts.set(messageClientId, { conversationId: id, message });
    return this.sendTextMessage(id, messageClientId, message, params);
  }
  async retryText(conversationId: string, messageClientId: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const pending = this.pendingTexts.get(requireNonBlank(messageClientId, "NIM message ID"));
    if (!pending || pending.conversationId !== id) throw new NimTextSendError("FAILED", "待重试的文本消息已不可用", { messageClientId });
    const params=await this.authorizeMessage(id, "send", authorize,{messageClientId,messageType:0});
    this.assertCurrent();
    return this.sendTextMessage(id, messageClientId, pending.message, params);
  }
  async replyText(conversationId: string, text: string, replyTo: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const body = requireNonBlank(text, "NIM message text");
    if (body.length > 4_000) throw new TypeError("NIM message text must be at most 4000 characters");
    replyTo = this.assertMessageConversation(replyTo, id);
    const senderId = requireNonBlank(replyTo.senderId, "NIM replied message sender");
    if (!this.messageService?.replyMessage || !this.nim.V2NIMMessageCreator) throw new Error("NIM message reply is unavailable");
    const message = this.nim.V2NIMMessageCreator.createTextMessage(body);
    const messageClientId = messageClientIdOf(message);
    const params = await this.authorizeMessage(id, "send", authorize,{messageClientId,messageType:0});
    this.assertCurrent();
    let result: { message?: NimMessageLike };
    try {
      result = params ? await this.messageService.replyMessage(message, replyTo, params) : await this.messageService.replyMessage(message, replyTo);
    } catch (cause) {
      if (cause instanceof ImLifecycleSupersededError || (cause instanceof Error && /disposed/.test(cause.message))) throw cause;
      throw new NimTextSendError("UNKNOWN", "消息回复结果未确认", { messageClientId, cause });
    }
    if (!result?.message || typeof result.message !== "object") throw new Error("NIM message response is invalid");
    this.reportReceipt(result.message,"sent");
    this.assertCurrent();
    const summary = messageSummary(replyTo);
    return {
      ...result.message,
      reply: {
        messageId: replyTo.messageServerId || replyTo.messageClientId,
        senderId,
        ...(summary ? { text: summary } : {}),
      },
    };
  }
  async revokeMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    message = this.assertMessageConversation(message, id);
    if(this.receipts){
      await this.receipts.revoke({messageClientId:message.messageClientId,messageServerId:message.messageServerId??"",conversationId:id,senderId:message.senderId,createTime:message.createTime,messageType:message.messageType??0});
      this.assertCurrent();return revokedMessageView(message);
    }
    if (!this.messageService?.revokeMessage) throw new Error("NIM message revoke is unavailable");
    await this.authorizeMessage(id, "send", authorize);
    this.assertCurrent();
    await this.messageService.revokeMessage(message);
    this.assertCurrent();
    return revokedMessageView(message);
  }
  async deleteMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<void> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    message = this.assertMessageConversation(message, id);
    if (!this.messageService?.deleteMessage) throw new Error("NIM message deletion is unavailable");
    await this.authorizeMessage(id, "read", authorize);
    this.assertCurrent();
    await this.messageService.deleteMessage(message).catch((cause:unknown)=>{
      if((cause as {code?:unknown})?.code===107335)throw Object.assign(new Error("当前云信未开通“仅本人删除”，消息仍保留，请联系平台管理员。"),{code:"IM_DELETE_UNAVAILABLE",status:503});
      throw cause;
    });
    this.reportReceipt(message,"hidden");
    this.assertCurrent();
  }
  private assertMessageConversation(message: NimMessageLike, conversationId: string): NimMessageLike {
    if (!message || typeof message !== "object" || typeof message.messageClientId !== "string" || !message.messageClientId) throw new TypeError("NIM message is invalid");
    if (message.conversationId && message.conversationId !== conversationId) throw localTransportError("NIM message does not belong to the conversation", 404);
    const type = /^[^|]+\|([123])\|[^|]+$/.exec(conversationId)?.[1];
    if (type && message.conversationType !== undefined && message.conversationType !== Number(type)) throw localTransportError("NIM message conversation type is invalid", 404);
    return type ? { ...message, conversationType: Number(type) } : message;
  }
  private async sendTextMessage(conversationId: string, messageClientId: string, message: unknown, params?: NimV2SendMessageParams): Promise<NimMessageLike> {
    let started = false;
    try {
      started = true;
      const result=params?await this.messageService!.sendMessage(message,conversationId,params):await this.messageService!.sendMessage(message,conversationId);
      if (!result?.message || typeof result.message !== "object") throw new Error("NIM message response is invalid");
      this.reportReceipt(result.message,"sent");
      this.assertCurrent();
      this.pendingTexts.delete(messageClientId);
      return result.message;
    } catch (cause) {
      if (cause instanceof ImLifecycleSupersededError || (cause instanceof Error && /disposed/.test(cause.message))) throw cause;
      throw new NimTextSendError(started ? "UNKNOWN" : "FAILED", started ? "消息发送结果未确认" : "消息发送失败", { messageClientId, cause });
    }
  }
  async sendImage(conversationId: string, file: File, options: NimImageSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    validateNimImageFile(file);
    if (!this.messageService || !this.nim.V2NIMMessageCreator?.createImageMessage || !this.nim.V2NIMStorageService) throw new Error("NIM image sending is unavailable");
    const message = this.nim.V2NIMMessageCreator.createImageMessage(file, file.name, undefined, options.width, options.height);
    const messageClientId = messageClientIdOf(message);
    const params=await this.authorizeMessage(id, "send", options.authorize,{messageClientId,messageType:1});
    this.assertCurrent();
    this.pendingImages.set(messageClientId, { conversationId: id, message });
    return this.sendImageMessage(id, messageClientId, message, options, params);
  }
  async retryImage(conversationId: string, messageClientId: string, options: NimImageSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const pending = this.pendingImages.get(requireNonBlank(messageClientId, "NIM image message ID"));
    if (!pending || pending.conversationId !== id) throw new NimImageSendError("FAILED", "待重试的图片消息已不可用", { messageClientId });
    const params=await this.authorizeMessage(id, "send", options.authorize,{messageClientId,messageType:1});
    this.assertCurrent();
    return this.sendImageMessage(id, messageClientId, pending.message, options, params);
  }
  /**
   * Video/file/audio are uploaded by the NIM SDK storage service: the creator
   * builds the typed message and sendMessage streams the File and returns the
   * uploaded https URL. Bytes never pass through our Nest API.
   */
  async sendMedia(conversationId: string, file: File, kind: NimMediaKind, options: NimMediaSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const mimeType = validateNimMediaFile(file, kind);
    validateNimMediaSendOptions(kind, options);
    const creator = this.nim.V2NIMMessageCreator;
    if (!this.messageService || !creator || !this.nim.V2NIMStorageService) throw new Error("NIM media sending is unavailable");
    const duration = options.durationMs;
    const { createVideoMessage, createAudioMessage, createFileMessage } = creator;
    const message = kind === "video" && createVideoMessage
      ? createVideoMessage.call(creator, file, file.name, undefined, duration, options.width, options.height)
      : kind === "audio" && createAudioMessage
        ? createAudioMessage.call(creator, file, file.name, undefined, duration)
        : kind === "file" && createFileMessage ? createFileMessage.call(creator, file, file.name, undefined) : undefined;
    if (!message) throw new Error("NIM media sending is unavailable");
    const messageClientId = messageClientIdOf(message);
    const params = await this.authorizeMessage(id, "send", options.authorize,{messageClientId,messageType:kind==="video"?3:kind==="audio"?2:6});
    this.assertCurrent();
    this.pendingMedia.set(messageClientId, {
      conversationId: id,
      message,
      media: {
        kind,
        name: file.name,
        mimeType,
        size: file.size,
        ...(options.width === undefined ? {} : { width: options.width }),
        ...(options.height === undefined ? {} : { height: options.height }),
        ...(options.durationMs === undefined || kind === "file" ? {} : { durationMs: options.durationMs }),
      },
    });
    return this.sendMediaMessage(id, messageClientId, options, params);
  }
  async retryMedia(conversationId: string, messageClientId: string, options: NimMediaSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = requireNonBlank(conversationId, "NIM conversation ID");
    const pending = this.pendingMedia.get(requireNonBlank(messageClientId, "NIM media message ID"));
    if (!pending || pending.conversationId !== id) throw new NimMediaSendError("FAILED", "待重试的媒体消息已不可用", { messageClientId });
    const params = await this.authorizeMessage(id, "send", options.authorize,{messageClientId,messageType:pending.media.kind==="video"?3:pending.media.kind==="audio"?2:6});
    this.assertCurrent();
    return this.sendMediaMessage(id, messageClientId, options, params);
  }
  async login(options: NimWebClientOptions): Promise<void> { this.assertCurrent(); const loginOptions: Record<string, unknown> = { authType: options.tokenProvider ? 1 : 0, forceMode: options.forceMode ?? false }; if (options.retryCount !== undefined) loginOptions.retryCount = options.retryCount; if (options.timeout !== undefined) loginOptions.timeout = options.timeout; if (options.tokenProvider) loginOptions.tokenProvider = async () => { this.assertCurrent(); const token = await options.tokenProvider?.(this.accountId); this.assertCurrent(); return requireNonBlank(token ?? "", "NIM token provider result"); }; this.setState("CONNECTING"); await this.nim.V2NIMLoginService.login(this.accountId, options.token ?? "", loginOptions); this.assertCurrent(); this.loggedIn = true; this.setState(mapConnectStatus(this.getSdkConnectStatus()) ?? "CONNECTED"); }
  async logout(): Promise<void> { if (!this.loggedIn || this.disposed) return; await this.nim.V2NIMLoginService.logout(); this.loggedIn = false; this.setState("DISCONNECTED"); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.pendingImages.clear(); this.pendingTexts.clear(); this.pendingMedia.clear(); this.receipts?.close(); for (const [eventName, handler] of this.eventHandlers) { try { this.nim.V2NIMLoginService.off(eventName, handler); } catch { /* cleanup continues */ } } this.eventHandlers.length = 0; for (const [eventName, handler] of this.messageEventHandlers) { try { this.messageService?.off(eventName, handler); } catch { /* cleanup continues */ } } this.messageEventHandlers.length = 0; this.messageListeners.clear(); if (this.loggedIn) { try { await this.nim.V2NIMLoginService.logout(); } catch { /* destroy still runs */ } this.loggedIn = false; } try { await this.nim.destroy(); } finally { this.listeners.clear(); } }
  private assertCurrent(): void { if (this.disposed) throw new Error("NIM client is disposed"); if (!this.context.isCurrent()) throw new ImLifecycleSupersededError(); }
  private reportReceipt(message:NimMessageLike,action:"sent"|"hidden"):void {
    this.receipts?.record({kind:"receipt",action,message:{messageClientId:message.messageClientId,messageServerId:message.messageServerId??"",conversationId:message.conversationId,senderId:message.senderId,createTime:message.createTime,messageType:message.messageType??0}});
  }
  private async authorizeMessage(conversationId: string, operation: "read" | "send", override?: NimMessageAuthorization,intent?:{messageClientId:string;messageType:number}): Promise<NimV2SendMessageParams|undefined> {
    this.assertCurrent(); const authorize=typeof override==="function"?override:this.messageAuthorization;
    if (!authorize) throw localTransportError("NIM message authorization is unavailable", 403);
    const grant=await authorize({ conversationId, operation,...intent }); this.assertCurrent();
    if(grant===undefined||operation!=="send")return undefined;
    const teamConversation=/^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\|2\|([0-9]{1,19})$/.exec(grant.conversationId);
    if(!grant.appId||!grant.orderId||!teamConversation||teamConversation[1]!==grant.teamId||grant.conversationId!==conversationId
      ||!/^[A-Za-z0-9._-]{1,32}$/.test(grant.routeEnvironment))throw localTransportError("NIM message route scope is invalid",403);
    return {routeConfig:{routeEnabled:true,routeEnvironment:grant.routeEnvironment}};
  }
  private async sendImageMessage(conversationId: string, messageClientId: string, message: unknown, options: NimImageSendOptions, params?: NimV2SendMessageParams): Promise<NimMessageLike> {
    let started = false;
    try {
      options.onProgress?.(0);
      started = true;
      const progress=(percentage:number)=>options.onProgress?.(imageProgress(percentage));
      const result = params
        ? await this.messageService!.sendMessage(message, conversationId, params, progress)
        : await this.messageService!.sendMessage(message, conversationId, undefined, progress);
      if (!result?.message || typeof result.message !== "object") throw new Error("NIM image response is invalid");
      this.reportReceipt(result.message,"sent");
      this.assertCurrent();
      this.pendingImages.delete(messageClientId);
      options.onProgress?.(100);
      return result.message;
    } catch (cause) {
      if (cause instanceof ImLifecycleSupersededError || (cause instanceof Error && /disposed/.test(cause.message))) throw cause;
      throw new NimImageSendError(started ? "UNKNOWN" : "FAILED", started ? "图片发送结果未确认" : "图片发送失败", { messageClientId, cause });
    }
  }
  private async sendMediaMessage(conversationId: string, messageClientId: string, options: NimMediaSendOptions, params?: NimV2SendMessageParams): Promise<NimMessageLike> {
    const pending = this.pendingMedia.get(messageClientId);
    if (!pending) throw new NimMediaSendError("FAILED", "待重试的媒体消息已不可用", { messageClientId });
    let started = false;
    try {
      options.onProgress?.(0);
      started = true;
      const progress=(percentage:number)=>options.onProgress?.(imageProgress(percentage));
      const result = params
        ? await this.messageService!.sendMessage(pending.message, conversationId, params, progress)
        : await this.messageService!.sendMessage(pending.message, conversationId, undefined, progress);
      if (!result?.message || typeof result.message !== "object") throw new Error("NIM media response is invalid");
      this.reportReceipt(result.message,"sent");
      this.assertCurrent();
      this.pendingMedia.delete(messageClientId);
      options.onProgress?.(100);
      return nimSentMediaView(result.message, pending.media);
    } catch (cause) {
      if (cause instanceof ImLifecycleSupersededError || (cause instanceof Error && /disposed/.test(cause.message))) throw cause;
      throw new NimMediaSendError(started ? "UNKNOWN" : "FAILED", started ? "媒体发送结果未确认" : "媒体发送失败", { messageClientId, cause });
    }
  }
  private getSdkConnectStatus(): unknown { return (this.nim.V2NIMLoginService as NimLoginServiceLike & { getConnectStatus?: () => unknown }).getConnectStatus?.(); }
  private setState(next: NimWebConnectionState): void { if (this.disposed || this.state === next) return; this.state = next; for (const listener of this.listeners) listener(next); }
}

export function createNimWebClientFactory(options: NimWebClientOptions, sdkLoader: NimSdkLoader = loadNimSdk): ImClientFactory<NimWebClient> {
  validateOptions(options);
  return async (context): Promise<ImClientHandle<NimWebClient>> => {
    const sdk = await sdkLoader();
    const loginConfig: Record<string, unknown> = {};
    if (options.lbsUrls?.length || options.linkUrl) loginConfig.V2NIMLoginServiceConfig = { ...(options.lbsUrls?.length ? { lbsUrls: [...options.lbsUrls] } : {}), ...(options.linkUrl ? { linkUrl: options.linkUrl } : {}) };
    const nim = sdk.getInstance({ appkey: requireNonBlank(options.appKey, "NIM app key"), apiVersion: "v2", debugLevel: options.debugLevel ?? DEFAULT_DEBUG_LEVEL, enableV2CloudConversation: false }, Object.keys(loginConfig).length ? loginConfig : undefined);
    const accountId = options.accountId === undefined ? context.identity : requireNonBlank(options.accountId, "NIM account ID");
    const client = new NimWebClient(context, nim, accountId, options.messageAuthorization,options);
    try { await client.login(options); if (!context.isCurrent()) throw new ImLifecycleSupersededError(); return { client, dispose: () => client.dispose() }; } catch (error) { await client.dispose(); throw error; }
  };
}

export type LocalFakeNimWebClientOptions = { endpoint: string; accountId: string; pollMs?: number };

function validateLocalFakeOptions(options: LocalFakeNimWebClientOptions): void {
  if (!options || typeof options !== "object" || typeof options.endpoint !== "string" || !/^\/(?!\/)/.test(options.endpoint) || options.endpoint.length > 128) {
    throw new TypeError("Local IM test endpoint is invalid");
  }
  if (typeof options.accountId !== "string" || !options.accountId.trim() || options.accountId.length > 128) throw new TypeError("Local IM test account ID is invalid");
  if (options.pollMs !== undefined && (!Number.isInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 5_000)) throw new TypeError("Local IM test poll interval is invalid");
}

export class LocalFakeNimWebClient implements NimWebClientLike {
  readonly transport = "local-fake" as const;
  readonly accountId: string;
  private readonly context: ImClientContext;
  private readonly endpoint: string;
  private readonly pollMs: number;
  private state: NimWebConnectionState = "DISCONNECTED";
  private disposed = false;
  private loggedIn = false;
  private pollTimer: number | undefined;
  private polling = false;
  private readonly listeners = new Set<(state: NimWebConnectionState) => void>();
  private readonly messageListeners = new Set<(messages: NimMessageLike[]) => void>();
  private readonly known = new Map<string, Map<string, string>>();
  private readonly latestSeen = new Map<string, number>();
  private readonly pendingImages = new Map<string, { conversationId: string; body: Record<string, unknown> }>();
  private readonly pendingTexts = new Map<string, { conversationId: string; text: string }>();
  private readonly pendingMedia = new Map<string, { conversationId: string; body: Record<string, unknown> }>();

  constructor(context: ImClientContext, options: LocalFakeNimWebClientOptions) {
    validateLocalFakeOptions(options);
    this.context = context;
    this.endpoint = options.endpoint;
    this.accountId = options.accountId.trim();
    this.pollMs = options.pollMs ?? 350;
  }

  getConnectionState(): NimWebConnectionState { return this.state; }

  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMessages(listener: (messages: NimMessageLike[]) => void): () => void {
    this.messageListeners.add(listener);
    this.startPolling();
    return () => this.messageListeners.delete(listener);
  }

  async login(): Promise<void> {
    this.assertCurrent();
    this.setState("CONNECTING");
    this.loggedIn = true;
    this.assertCurrent();
    this.setState("CONNECTED");
  }

  async getMessageHistory(conversationId: string, limit = 50, before?: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike[]> {
    this.assertCurrent();
    if(typeof authorize==="function")await authorize({conversationId,operation:"read"});this.assertCurrent();
    const messages = await this.readHistory(conversationId, limit, before);
    this.assertCurrent();
    this.remember(conversationId, messages);
    return messages;
  }

  async sendText(conversationId: string, text: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const body = text.trim();
    if (!id || id.length > 160 || !body || body.length > 4_000) throw new TypeError("Local IM message is invalid");
    if(typeof authorize==="function")await authorize({conversationId:id,operation:"send"});this.assertCurrent();
    const messageClientId = localTextClientId();
    this.pendingTexts.set(messageClientId, { conversationId: id, text: body });
    return this.postText(id, messageClientId, body);
  }

  async retryText(conversationId: string, messageClientId: string, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const pending = this.pendingTexts.get(messageClientId);
    if (!pending || pending.conversationId !== id) throw new NimTextSendError("FAILED", "待重试的文本消息已不可用", { messageClientId });
    if(typeof authorize==="function")await authorize({conversationId:id,operation:"send"});this.assertCurrent();
    return this.postText(id, messageClientId, pending.text);
  }

  async replyText(conversationId: string, text: string, replyTo: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const body = text.trim();
    if (!id || id.length > 160 || !body || body.length > 4_000) throw new TypeError("Local IM message is invalid");
    const reference = localMessageReference(replyTo, id);
    if(typeof authorize==="function")await authorize({conversationId:id,operation:"send"});this.assertCurrent();
    const value = await this.postAction({ action: "reply", conversationId: id, text: body, replyTo: reference });
    const message = localActionMessage(value);
    this.remember(id, [message]);
    return message;
  }

  async revokeMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    if (!id || id.length > 160) throw new TypeError("Local IM conversation is invalid");
    const reference = localMessageReference(message, id);
    if(typeof authorize==="function")await authorize({conversationId:id,operation:"send"});this.assertCurrent();
    const value = await this.postAction({ action: "revoke", conversationId: id, message: reference });
    const updated = localActionMessage(value);
    this.remember(id, [updated]);
    return updated;
  }

  async deleteMessage(conversationId: string, message: NimMessageLike, authorize?: NimMessageAuthorization): Promise<void> {
    this.assertCurrent();
    const id = conversationId.trim();
    if (!id || id.length > 160) throw new TypeError("Local IM conversation is invalid");
    const reference = localMessageReference(message, id);
    if(typeof authorize==="function")await authorize({conversationId:id,operation:"read"});this.assertCurrent();
    await this.postAction({ action: "delete", conversationId: id, message: reference });
    this.forget(id, reference.messageServerId || reference.messageClientId || "");
  }

  private async postAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error("IM message request failed", { cause });
    }
    if (!response.ok) throw localTransportError("IM message request failed", response.status);
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("IM message response is invalid");
    return value;
  }

  private async postText(id: string, messageClientId: string, body: string): Promise<NimMessageLike> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: id, text: body }),
      });
    } catch (cause) {
      throw new NimTextSendError("UNKNOWN", "IM message request failed", { messageClientId, cause });
    }
    if (!response.ok) {
      const status = response.status;
      throw new NimTextSendError(status >= 500 ? "UNKNOWN" : "FAILED", "IM message request failed", { messageClientId, cause: localTransportError("IM message request failed", status) });
    }
    const value = await response.json().catch(() => null) as { message?: NimMessageLike } | null;
    if (!value?.message || typeof value.message !== "object") throw new NimTextSendError("UNKNOWN", "IM message response is invalid", { messageClientId });
    this.assertCurrent();
    this.pendingTexts.delete(messageClientId);
    this.remember(id, [value.message]);
    return value.message;
  }

  async sendImage(conversationId: string, file: File, options: NimImageSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const mimeType = validateNimImageFile(file);
    if (!id || id.length > 160) throw new TypeError("Local IM conversation is invalid");
    const body = {
      conversationId: id,
      image: {
        messageClientId: localImageClientId(),
        name: file.name,
        mimeType,
        size: file.size,
        data: await fileBase64(file),
        ...(options.width === undefined ? {} : { width: options.width }),
        ...(options.height === undefined ? {} : { height: options.height }),
      },
    } satisfies Record<string, unknown>;
    this.assertCurrent();
    if (typeof options.authorize === "function") await options.authorize({ conversationId: id, operation: "send" });
    this.assertCurrent();
    const messageClientId = (body.image as { messageClientId: string }).messageClientId;
    this.pendingImages.set(messageClientId, { conversationId: id, body });
    return this.postImage(id, messageClientId, body, options);
  }

  async retryImage(conversationId: string, messageClientId: string, options: NimImageSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const pending = this.pendingImages.get(messageClientId);
    if (!pending || pending.conversationId !== id) throw new NimImageSendError("FAILED", "待重试的图片消息已不可用", { messageClientId });
    if (typeof options.authorize === "function") await options.authorize({ conversationId: id, operation: "send" });
    this.assertCurrent();
    return this.postImage(id, messageClientId, pending.body, options);
  }

  async sendMedia(conversationId: string, file: File, kind: NimMediaKind, options: NimMediaSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    if (!id || id.length > 160) throw new TypeError("Local IM conversation is invalid");
    const mimeType = validateNimMediaFile(file, kind);
    const body = {
      conversationId: id,
      media: {
        kind,
        messageClientId: localMediaClientId(),
        name: file.name,
        mimeType,
        size: file.size,
        data: await fileBase64(file),
        ...(options.width === undefined ? {} : { width: options.width }),
        ...(options.height === undefined ? {} : { height: options.height }),
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
      },
    } satisfies Record<string, unknown>;
    this.assertCurrent();
    if (typeof options.authorize === "function") await options.authorize({ conversationId: id, operation: "send" });
    this.assertCurrent();
    const messageClientId = (body.media as { messageClientId: string }).messageClientId;
    this.pendingMedia.set(messageClientId, { conversationId: id, body });
    return this.postMedia(id, messageClientId, body, options);
  }

  async retryMedia(conversationId: string, messageClientId: string, options: NimMediaSendOptions = {}): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const pending = this.pendingMedia.get(messageClientId);
    if (!pending || pending.conversationId !== id) throw new NimMediaSendError("FAILED", "待重试的媒体消息已不可用", { messageClientId });
    if (typeof options.authorize === "function") await options.authorize({ conversationId: id, operation: "send" });
    this.assertCurrent();
    return this.postMedia(id, messageClientId, pending.body, options);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.loggedIn = false;
    this.setState("DISCONNECTED");
    this.listeners.clear();
    this.messageListeners.clear();
    this.known.clear();
    this.latestSeen.clear();
    this.pendingImages.clear();
    this.pendingTexts.clear();
    this.pendingMedia.clear();
  }

  private async readHistory(conversationId: string, limit: number, before?: NimMessageLike): Promise<NimMessageLike[]> {
    const id = conversationId.trim();
    if (!id || id.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Local IM history request is invalid");
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}?conversationId=${encodeURIComponent(id)}&limit=${limit}${before?`&before=${encodeURIComponent(before.messageServerId||before.messageClientId)}`:""}`, { credentials: "same-origin", cache: "no-store" });
    } catch {
      this.setState("RECONNECTING");
      throw new Error("IM history request failed");
    }
    if (!response.ok) throw localTransportError("IM history request failed", response.status);
    const value = await response.json().catch(() => null) as { messages?: unknown } | null;
    if (!Array.isArray(value?.messages)) throw new Error("IM history response is invalid");
    this.setState("CONNECTED");
    return value.messages.map(nimMessageView).filter((message): message is NimMessageLike => message !== null);
  }

  private async postImage(conversationId: string, messageClientId: string, body: Record<string, unknown>, options: NimImageSendOptions): Promise<NimMessageLike> {
    let response: Response;
    try {
      options.onProgress?.(0);
      response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new NimImageSendError("UNKNOWN", "图片发送结果未确认", { messageClientId, cause });
    }
    if (!response.ok) {
      const cause = localTransportError("IM image request failed", response.status);
      throw new NimImageSendError(response.status >= 500 ? "UNKNOWN" : "FAILED", response.status >= 500 ? "图片发送结果未确认" : "图片发送失败", { messageClientId, cause });
    }
    const value = await response.json().catch(() => null) as { message?: NimMessageLike } | null;
    if (!value?.message || typeof value.message !== "object") throw new NimImageSendError("UNKNOWN", "图片发送结果未确认", { messageClientId });
    this.assertCurrent();
    this.pendingImages.delete(messageClientId);
    options.onProgress?.(100);
    this.remember(conversationId, [value.message]);
    return value.message;
  }

  private async postMedia(conversationId: string, messageClientId: string, body: Record<string, unknown>, options: NimMediaSendOptions): Promise<NimMessageLike> {
    let response: Response;
    try {
      options.onProgress?.(0);
      response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new NimMediaSendError("UNKNOWN", "媒体发送结果未确认", { messageClientId, cause });
    }
    if (!response.ok) {
      const cause = localTransportError("IM media request failed", response.status);
      throw new NimMediaSendError(response.status >= 500 ? "UNKNOWN" : "FAILED", response.status >= 500 ? "媒体发送结果未确认" : "媒体发送失败", { messageClientId, cause });
    }
    const value = await response.json().catch(() => null) as { message?: NimMessageLike } | null;
    if (!value?.message || typeof value.message !== "object") throw new NimMediaSendError("UNKNOWN", "媒体发送结果未确认", { messageClientId });
    const message = nimMessageView(value.message);
    if (!message) throw new NimMediaSendError("UNKNOWN", "媒体发送结果无效", { messageClientId });
    this.assertCurrent();
    this.pendingMedia.delete(messageClientId);
    options.onProgress?.(100);
    this.remember(conversationId, [message]);
    return message;
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.disposed) return;
    this.pollTimer = window.setInterval(() => { void this.poll(); }, this.pollMs);
  }

  private async poll(): Promise<void> {
    if (this.disposed || !this.loggedIn || this.polling || this.known.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this.polling = true;
    try {
      for (const [conversationId, known] of this.known) {
        const messages = await this.readHistory(conversationId, 100);
        const latest=this.latestSeen.get(conversationId)??-Infinity;
        const incoming = messages.filter((message) => {
          const previous = known.get(this.messageKey(message));
          // Unknown ids keep the old "newer than everything seen" guard; a
          // known id with changed content (revoked/reply) must still be pushed.
          return previous === undefined ? message.createTime >= latest : previous !== this.messageSignature(message);
        });
        this.remember(conversationId, messages);
        if (incoming.length > 0 && !this.disposed && this.context.isCurrent()) {
          for (const listener of this.messageListeners) listener(incoming);
        }
      }
    } catch {
      // Polling is best-effort; the next history/send operation surfaces auth and network errors.
    } finally {
      this.polling = false;
    }
  }

  private remember(conversationId: string, messages: NimMessageLike[]): void {
    const known = this.known.get(conversationId) ?? new Map<string, string>();
    for (const message of messages) known.set(this.messageKey(message), this.messageSignature(message));
    this.known.set(conversationId, known);
    this.latestSeen.set(conversationId,Math.max(this.latestSeen.get(conversationId)??-Infinity,...messages.map(message=>message.createTime)));
  }

  private forget(conversationId: string, messageId: string): void {
    if (!messageId) return;
    this.known.get(conversationId)?.delete(messageId);
  }

  private messageSignature(message: NimMessageLike): string {
    return JSON.stringify([
      message.messageServerId ?? "",
      message.createTime,
      message.revoked === true,
      message.text ?? "",
      message.reply ?? null,
      message.card ?? null,
      message.attachment?.imageId ?? message.attachment?.url ?? "",
      message.media ? [message.media.mediaId, message.media.url ?? ""] : null,
    ]);
  }

  private messageKey(message: NimMessageLike): string {
    return message.messageServerId || message.messageClientId || `${message.senderId}-${message.createTime}`;
  }

  private assertCurrent(): void {
    if (this.disposed) throw new Error("IM client is disposed");
    if (!this.context.isCurrent()) throw new ImLifecycleSupersededError();
  }

  private setState(next: NimWebConnectionState): void {
    if (this.disposed || this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

export function createLocalFakeNimWebClientFactory(options: LocalFakeNimWebClientOptions): ImClientFactory<LocalFakeNimWebClient> {
  validateLocalFakeOptions(options);
  return async (context) => {
    const client = new LocalFakeNimWebClient(context, options);
    try {
      await client.login();
      return { client, dispose: () => client.dispose() };
    } catch (error) {
      await client.dispose();
      throw error;
    }
  };
}
