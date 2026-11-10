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

export type ImSystemNotice = { text: string };

/**
 * 云信 V2 通知消息（messageType 5）按 attachment.type 解码为中性系统行。
 * type 0 = TEAM_INVITE（群拉人）；每次拉人不等于首次接待，所以文案只说成员变化。
 * 非通知消息返回 null，交由调用方按普通消息渲染。
 */
export function decodeImSystemNotice(message: { messageType?: number; attachment?: unknown }): ImSystemNotice | null {
  if (message.messageType !== 5) return null;
  const attachment = message.attachment && typeof message.attachment === "object" && !Array.isArray(message.attachment)
    ? message.attachment as { type?: unknown; ope?: unknown }
    : undefined;
  const type = attachment?.type;
  const ope = attachment?.ope;
  if (ope === 0) return { text: "群聊已创建" };
  return { text: type === 0 ? "成员已加入会话" : "会话信息已更新" };
}
