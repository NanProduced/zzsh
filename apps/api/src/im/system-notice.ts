export type YunxinSystemNoticeKind =
  | "TEAM_CREATED"
  | "MEMBER_JOINED"
  | "MEMBER_LEFT"
  | "TEAM_UPDATED"
  | "TEAM_DISMISSED"
  | "UNKNOWN";

export type YunxinSystemNotice = { kind: YunxinSystemNoticeKind; text: string };

// 与 packages/im-client/src/message-state.ts 的客户端解码保持同一套文案和 kind。
const SYSTEM_NOTICE_TEXT: Record<YunxinSystemNoticeKind, string> = {
  TEAM_CREATED: "群聊已创建",
  MEMBER_JOINED: "成员已加入会话",
  MEMBER_LEFT: "成员已离开会话",
  TEAM_UPDATED: "会话信息已更新",
  TEAM_DISMISSED: "会话已解散",
  UNKNOWN: "会话信息有变化",
};

/** V2 NIM 通知类型；4xx 是超级群的同名镜像。 */
const SYSTEM_NOTICE_KIND_BY_TYPE: Record<number, YunxinSystemNoticeKind> = {
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

function noticeOf(kind: YunxinSystemNoticeKind): YunxinSystemNotice {
  return { kind, text: SYSTEM_NOTICE_TEXT[kind] };
}

/**
 * 云信 V2 通知消息（messageType 5）的服务端归一化结果。
 * 成员/群变更按 attachment.type 归类；ope:0 仅在 type 缺失或 -1 时兜底为建群，
 * 绝不覆盖已明确的类型。非通知消息返回 null。
 */
export function decodeYunxinSystemNotice(message: { messageType?: number; attachment?: unknown }): YunxinSystemNotice | null {
  if (message.messageType !== 5) return null;
  const attachment = message.attachment && typeof message.attachment === "object" && !Array.isArray(message.attachment)
    ? message.attachment as { type?: unknown; ope?: unknown }
    : undefined;
  const type = attachment?.type;
  if (typeof type === "number" && Number.isInteger(type) && type !== -1) {
    const kind = SYSTEM_NOTICE_KIND_BY_TYPE[type];
    if (kind) return noticeOf(kind);
  }
  if ((type === undefined || type === -1) && attachment?.ope === 0) return noticeOf("TEAM_CREATED");
  return noticeOf("UNKNOWN");
}
