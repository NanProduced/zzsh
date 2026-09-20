export type ImConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "KICKED"
  | "AUTH_FAILED";

export type ImPlatformAccountState = "ACTIVE" | "PENDING" | "FROZEN" | "DEACTIVATED";

export type ImServiceAvailability = "OFF_DUTY" | "AVAILABLE" | "PAUSED";

export type ImTransportMessage = {
  messageClientId: string;
  messageServerId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  createTime: number;
  text?: string;
  messageType: 0 | 1;
  attachment?: {
    imageId: string;
    url?: string;
    name: string;
    mimeType: "image/jpeg" | "image/png";
    size: number;
    width?: number;
    height?: number;
  };
};

export type ImOrderImageScope = {
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

/** Server-authorized seam for the explicit local IM substitute. */
export type ImMessageTransport = {
  history(input: { conversationId: string; viewerAccountId: string; limit: number; before?: string }): Promise<ImTransportMessage[]>;
  sendText(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string }): Promise<ImTransportMessage>;
  sendImage?(input: { conversationId: string; scope: ImOrderImageScope; senderAccountId: string; receiverAccountId: string; messageClientId: string; name: string; mimeType: "image/jpeg" | "image/png"; size: number; body: Uint8Array; width?: number; height?: number }): Promise<ImTransportMessage>;
  getImageScope?(imageId: string): Promise<{ imageId: string; scope: ImOrderImageScope } | null>;
  readImage?(input: { imageId: string; scope: ImOrderImageScope; viewerAccountId: string }): Promise<ImTransportImage | null>;
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
