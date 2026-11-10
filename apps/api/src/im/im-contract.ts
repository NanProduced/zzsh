export type ImConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "KICKED"
  | "AUTH_FAILED";

export type ImPlatformAccountState = "ACTIVE" | "PENDING" | "FROZEN" | "DEACTIVATED";

export type ImServiceAvailability = "OFF_DUTY" | "AVAILABLE" | "PAUSED";

export type ImTransportReply = {
  messageId: string;
  senderId: string;
  text?: string;
};

export type ImTransportCard = {
  kind: "ORDER_OPENING"|"ORDER_ENDING"|"ORDER_SETTLED"|"ORDER_CANCELLED"|"ORDER_PRICE_CHANGE";
  orderId: string;
  cardId: string;
};

export type ImTransportMediaKind = "video" | "file" | "audio";

/**
 * Local-fake limits. Real NIM/cloud-storage upload is a separate provider
 * seam; these bounds only describe what this API surface accepts today.
 */
export const IM_TRANSPORT_MEDIA_LIMITS = {
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
} as const satisfies Record<ImTransportMediaKind, { maxBytes: number; mimeTypes: readonly string[] }>;

export const IM_TRANSPORT_MEDIA_MESSAGE_TYPES: Record<ImTransportMediaKind, 2 | 3 | 6> = {
  audio: 2,
  video: 3,
  file: 6,
};

export function isImTransportMediaKind(value: unknown): value is ImTransportMediaKind {
  return value === "video" || value === "file" || value === "audio";
}

export function isImTransportMediaMimeType(kind: ImTransportMediaKind, mimeType: unknown): mimeType is string {
  return typeof mimeType === "string"
    && (IM_TRANSPORT_MEDIA_LIMITS[kind].mimeTypes as readonly string[]).includes(mimeType);
}

/**
 * Safe, server-owned media metadata. `url` is only filled by the authorized
 * API response; clients never supply it in a send body.
 */
export type ImTransportMedia = {
  mediaId: string;
  kind: ImTransportMediaKind;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  url?: string;
};

export type ImTransportMessage = {
  messageClientId: string;
  messageServerId: string;
  /** Provider-issued server ID only; locally generated/client IDs never belong here. */
  serverMessageId?: string | null;
  conversationId: string;
  senderId: string;
  receiverId: string;
  createTime: number;
  text?: string;
  messageType: 0 | 1 | 2 | 3 | 6 | 100;
  reply?: ImTransportReply;
  revoked?: boolean;
  card?: ImTransportCard;
  attachment?: {
    imageId: string;
    url?: string;
    name: string;
    mimeType: "image/jpeg" | "image/png";
    size: number;
    width?: number;
    height?: number;
  };
  media?: ImTransportMedia;
};

export type ImTransportMessageReference = {
  messageServerId?: string;
  messageClientId?: string;
};

/**
 * A transport may reject a reply/revoke/hide with an HTTP-like status. The
 * route maps it to the existing API error envelope instead of a generic 500.
 */
export class ImTransportRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ImTransportRequestError";
  }
}

export type ImOrderImageScope = {
  appId: string;
  orderId: string;
  teamId: string;
};

/** Same order/conversation grant as images; named for the media seam. */
export type ImOrderMediaScope = {
  appId: string;
  orderId: string;
  teamId: string;
};

export type ImTransportImage = {
  imageId: string;
  scope: ImOrderImageScope;
  mimeType: "image/jpeg" | "image/png";
  body: Uint8Array;
};

export type ImTransportMediaFile = {
  mediaId: string;
  scope: ImOrderMediaScope;
  kind: ImTransportMediaKind;
  name: string;
  mimeType: string;
  body: Uint8Array;
};

/** Server-authorized seam for the explicit local IM substitute. */
export type ImMessageTransport = {
  history(input: { conversationId: string; viewerAccountId: string; limit: number; before?: string }): Promise<ImTransportMessage[]>;
  sendText(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; messageClientId?: string }): Promise<ImTransportMessage>;
  sendImage?(input: { conversationId: string; scope: ImOrderImageScope; senderAccountId: string; receiverAccountId: string; messageClientId: string; name: string; mimeType: "image/jpeg" | "image/png"; size: number; body: Uint8Array; width?: number; height?: number }): Promise<ImTransportMessage>;
  sendMedia?(input: { conversationId: string; scope: ImOrderMediaScope; senderAccountId: string; receiverAccountId: string; messageClientId: string; kind: ImTransportMediaKind; name: string; mimeType: string; size: number; body: Uint8Array; width?: number; height?: number; durationMs?: number }): Promise<ImTransportMessage>;
  card?(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; card: ImTransportCard }): Promise<ImTransportMessage>;
  replyText?(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; replyTo: ImTransportMessageReference }): Promise<ImTransportMessage>;
  revoke?(input: { conversationId: string; viewerAccountId: string; message: ImTransportMessageReference }): Promise<ImTransportMessage>;
  hideForViewer?(input: { conversationId: string; viewerAccountId: string; message: ImTransportMessageReference }): Promise<void>;
  getImageScope?(imageId: string): Promise<{ imageId: string; scope: ImOrderImageScope } | null>;
  readImage?(input: { imageId: string; scope: ImOrderImageScope; viewerAccountId: string }): Promise<ImTransportImage | null>;
  getMediaScope?(mediaId: string): Promise<{ mediaId: string; scope: ImOrderMediaScope } | null>;
  readMedia?(input: { mediaId: string; scope: ImOrderMediaScope; viewerAccountId: string }): Promise<ImTransportMediaFile | null>;
};

export type ImRoutingBlocker =
  | "PLATFORM_ACCOUNT_UNAVAILABLE"
  | "IM_IDENTITY_UNAVAILABLE"
  | "NOT_ACCEPTING"
  | "IM_CONNECTION_UNAVAILABLE"
  | "IM_CONNECTION_STALE"
  | "SERVICE_SCOPE_MISSING";

export type ImRoutingInput = {
  platformAccountState: ImPlatformAccountState;
  identityActive: boolean;
  availability: ImServiceAvailability;
  connection: ImConnectionState;
  lastConnectedAt: string | null;
  now: string;
  staleAfterMs: number;
  hasServiceScope: boolean;
};

export type ImRoutingDecision = {
  eligible: boolean;
  blockers: readonly ImRoutingBlocker[];
};

function parsedTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * IM presence is only one input to dispatch. The platform still owns account,
 * availability and scope decisions. Workload is a statistic, never a gate.
 */
export function evaluateImRouting(input: ImRoutingInput): ImRoutingDecision {
  const blockers: ImRoutingBlocker[] = [];
  if (input.platformAccountState !== "ACTIVE") blockers.push("PLATFORM_ACCOUNT_UNAVAILABLE");
  if (!input.identityActive) blockers.push("IM_IDENTITY_UNAVAILABLE");
  if (input.availability !== "AVAILABLE") blockers.push("NOT_ACCEPTING");
  if (input.connection !== "CONNECTED") blockers.push("IM_CONNECTION_UNAVAILABLE");

  if (input.connection === "CONNECTED") {
    const now = parsedTime(input.now);
    const lastConnectedAt = input.lastConnectedAt ? parsedTime(input.lastConnectedAt) : null;
    if (now === null || lastConnectedAt === null || now - lastConnectedAt > input.staleAfterMs) {
      blockers.push("IM_CONNECTION_STALE");
    }
  }

  if (!input.hasServiceScope) blockers.push("SERVICE_SCOPE_MISSING");
  return { eligible: blockers.length === 0, blockers };
}

export type ImProductCard = {
  schema: "zzsh.im-card";
  type: "PRODUCT";
  version: 1;
  objectId: string;
  snapshot: {
    title: string;
    summary: string;
    priceText?: string;
    statusText?: string;
    mediaId?: string;
  };
};

const CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CARD_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isSafeCardText(value: unknown, maxLength: number, required = false): value is string {
  return typeof value === "string" &&
    value.length <= maxLength &&
    (!required || value.trim().length > 0) &&
    !CARD_CONTROL_PATTERN.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse only the platform-owned product-card shape. Unknown or forged card
 * payloads are rendered as ordinary unsupported messages by the caller.
 */
export function parseImProductCard(value: unknown): ImProductCard | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schema", "type", "version", "objectId", "snapshot"])) return null;
  if (value.schema !== "zzsh.im-card" || value.type !== "PRODUCT" || value.version !== 1) return null;
  if (typeof value.objectId !== "string" || !CARD_ID_PATTERN.test(value.objectId)) return null;
  if (!isRecord(value.snapshot) || !hasOnlyKeys(value.snapshot, ["title", "summary", "priceText", "statusText", "mediaId"])) return null;
  if (!isSafeCardText(value.snapshot.title, 120, true) || !isSafeCardText(value.snapshot.summary, 500, true)) return null;
  if (value.snapshot.priceText !== undefined && !isSafeCardText(value.snapshot.priceText, 80)) return null;
  if (value.snapshot.statusText !== undefined && !isSafeCardText(value.snapshot.statusText, 80)) return null;
  if (value.snapshot.mediaId !== undefined && (typeof value.snapshot.mediaId !== "string" || !CARD_ID_PATTERN.test(value.snapshot.mediaId))) return null;

  return {
    schema: "zzsh.im-card",
    type: "PRODUCT",
    version: 1,
    objectId: value.objectId,
    snapshot: {
      title: value.snapshot.title,
      summary: value.snapshot.summary,
      ...(value.snapshot.priceText === undefined ? {} : { priceText: value.snapshot.priceText }),
      ...(value.snapshot.statusText === undefined ? {} : { statusText: value.snapshot.statusText }),
      ...(value.snapshot.mediaId === undefined ? {} : { mediaId: value.snapshot.mediaId }),
    },
  };
}
