export type ImMessageStateItem = {
  id: string;
  createTime?: number;
};

/** Object fields where a later record must not erase values it does not carry
 *  (a sender echo may omit the uploaded URL while history carries it). */
const MERGED_OBJECT_FIELDS = ["attachment", "image", "media", "reply"] as const;

function mergeRecord<T extends ImMessageStateItem>(existing: T, message: T): T {
  const existingRecord = existing as Record<string, unknown>;
  const incomingRecord = message as Record<string, unknown>;
  if (incomingRecord.revoked === true) {
    // A revoked message must clear content both ways: the peer-facing revoke
    // notification only carries a reference, while the sender still has text.
    const cleared: Record<string, unknown> = { ...existingRecord };
    for (const [field, value] of Object.entries(incomingRecord)) {
      if (value !== undefined) cleared[field] = value;
    }
    cleared.text = "";
    cleared.revoked = true;
    delete cleared.attachment;
    delete cleared.image;
    delete cleared.media;
    delete cleared.reply;
    return cleared as T;
  }
  // A stale history page must never resurrect a message revoked live.
  if (existingRecord.revoked === true) return existing;
  let merged: T | undefined;
  for (const key of MERGED_OBJECT_FIELDS) {
    const existingValue = (existing as Record<string, unknown>)[key];
    const incomingValue = (message as Record<string, unknown>)[key];
    const existingObject = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue) ? existingValue as Record<string, unknown> : undefined;
    if (!existingObject) continue;
    if (!incomingValue || typeof incomingValue !== "object" || Array.isArray(incomingValue)) {
      merged ??= { ...message };
      (merged as Record<string, unknown>)[key] = existingObject;
      continue;
    }
    const incomingObject = incomingValue as Record<string, unknown>;
    const union: Record<string, unknown> = { ...existingObject };
    for (const [field, value] of Object.entries(incomingObject)) {
      if (value !== undefined) union[field] = value;
    }
    merged ??= { ...message };
    (merged as Record<string, unknown>)[key] = union;
  }
  return merged ?? message;
}

/** Merge history and live delivery without letting an older response erase newer messages. */
export function mergeImMessages<T extends ImMessageStateItem>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? mergeRecord(existing, message) : message);
  }
  return [...byId.values()].sort((left, right) => {
    const time = (left.createTime ?? 0) - (right.createTime ?? 0);
    return time || left.id.localeCompare(right.id);
  });
}

export type ImSystemNoticeKind =
  | "TEAM_CREATED"
  | "MEMBER_JOINED"
  | "MEMBER_LEFT"
  | "TEAM_UPDATED"
  | "TEAM_DISMISSED"
  | "UNKNOWN";

export type ImSystemNotice = { kind: ImSystemNoticeKind; text: string };

const IM_SYSTEM_NOTICE_TEXT: Record<ImSystemNoticeKind, string> = {
  TEAM_CREATED: "群聊已创建",
  MEMBER_JOINED: "成员已加入会话",
  MEMBER_LEFT: "成员已离开会话",
  TEAM_UPDATED: "会话信息已更新",
  TEAM_DISMISSED: "会话已解散",
  UNKNOWN: "会话信息有变化",
};

const IM_SYSTEM_NOTICE_TEXTS = new Set(Object.values(IM_SYSTEM_NOTICE_TEXT));

/**
 * V2 NIM 通知类型（V2NIMMessageNotificationType）；4xx 是超级群的同名镜像。
 * 成员与群变更必须按 type 归类，不能因为附件同时带 ope 就当成建群。
 */
const IM_SYSTEM_NOTICE_KIND_BY_TYPE: Record<number, ImSystemNoticeKind> = {
  0: "MEMBER_JOINED",
  1: "MEMBER_LEFT",
  2: "MEMBER_LEFT",
  3: "TEAM_UPDATED",
  4: "TEAM_DISMISSED",
  5: "MEMBER_JOINED",
  6: "TEAM_UPDATED",
  7: "TEAM_UPDATED",
  8: "TEAM_UPDATED",
  9: "MEMBER_JOINED",
  10: "TEAM_UPDATED",
  401: "MEMBER_JOINED",
  402: "MEMBER_LEFT",
  403: "MEMBER_LEFT",
  404: "TEAM_UPDATED",
  405: "TEAM_DISMISSED",
  406: "TEAM_UPDATED",
  407: "TEAM_UPDATED",
  408: "TEAM_UPDATED",
  409: "TEAM_UPDATED",
  410: "MEMBER_JOINED",
  411: "MEMBER_JOINED",
};

function systemNoticeOf(kind: ImSystemNoticeKind): ImSystemNotice {
  return { kind, text: IM_SYSTEM_NOTICE_TEXT[kind] };
}

/**
 * 云信 V2 通知消息（messageType 5）按 attachment.type 解码为中性系统行。
 * 旧版/服务端建群通知可能只带 ope:0；它仅在 type 缺失（或 -1 未定义）时作为
 * “群聊已创建”的线索，绝不覆盖已明确的成员或群变更。
 * 非通知消息返回 null，交由调用方按普通消息渲染。
 */
export function decodeImSystemNotice(message: { messageType?: number; attachment?: unknown }): ImSystemNotice | null {
  if (message.messageType !== 5) return null;
  const attachment = message.attachment && typeof message.attachment === "object" && !Array.isArray(message.attachment)
    ? message.attachment as { type?: unknown; ope?: unknown }
    : undefined;
  const type = attachment?.type;
  if (typeof type === "number" && Number.isInteger(type) && type !== -1) {
    const kind = IM_SYSTEM_NOTICE_KIND_BY_TYPE[type];
    if (kind) return systemNoticeOf(kind);
  }
  if ((type === undefined || type === -1) && attachment?.ope === 0) return systemNoticeOf("TEAM_CREATED");
  return systemNoticeOf("UNKNOWN");
}

/** Server-written previews can still contain a notice until the server normalizes them. */
export function isImSystemNoticeText(text: string): boolean {
  return IM_SYSTEM_NOTICE_TEXTS.has(text.trim());
}

/**
 * Display-only: drop team lifecycle notices already covered by Bot business
 * messages, keep one fallback when there is no Bot coverage, and merge repeated
 * same-kind notices that are still consecutive within the time window.
 */
export function collapseImSystemNotices<T extends { createTime?: number }>(
  messages: readonly T[],
  options: {
    noticeOf: (message: T) => ImSystemNotice | null;
    hasBotMessage: boolean;
    windowMs?: number;
  },
): T[] {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const visible: T[] = [];
  let fallbackShown = false;
  let previousNotice: { kind: ImSystemNoticeKind; at: number } | null = null;
  for (const message of messages) {
    const notice = options.noticeOf(message);
    if (!notice) {
      previousNotice = null;
      visible.push(message);
      continue;
    }
    const at = message.createTime ?? 0;
    if (notice.kind === "TEAM_CREATED" || notice.kind === "MEMBER_JOINED") {
      if (options.hasBotMessage || fallbackShown) continue;
      fallbackShown = true;
      previousNotice = { kind: notice.kind, at };
      visible.push(message);
      continue;
    }
    if (previousNotice?.kind === notice.kind && Math.abs(at - previousNotice.at) <= windowMs) {
      previousNotice = { kind: notice.kind, at };
      continue;
    }
    previousNotice = { kind: notice.kind, at };
    visible.push(message);
  }
  return visible;
}
