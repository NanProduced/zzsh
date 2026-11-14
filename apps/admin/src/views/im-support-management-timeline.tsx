"use client";

import { type ReactElement, type ReactNode } from "react";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { SupportMessageBody } from "./im-support-message-body";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import "@zzsh/ui/message-media.css";
import { collapseImSystemNotices, decodeImSystemNotice, imSystemNoticeLabel, type ImSystemNoticeScope } from "@zzsh/im-client/message-state";
import { OrderCardMessage } from "@zzsh/ui/order-card";
import type { OrderTeamAccess } from "@zzsh/ui/order-team-panel";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { EntityPreviewTrigger, UserPreviewCard, UserProfilePreview } from "../components/admin-preview";
import { AdminMemberPreviewCard } from "./im-support-group-settings";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatTime, initialOf } from "./im-support-format";
import type { AuditMessage } from "./im-support-management-model";
import type { SupportManagementRequest } from "./im-support-management";
import { CARD_LABELS, roleLabel, safeIdentityName } from "./im-support-management-identity";

const GROUP_WINDOW_MS = 300_000;

function imageOf(message: NimMessageLike): { url: string | null; thumbnailUrl: string | null; name: string } | null {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return null;
  const attachment = message.attachment as { url?: unknown; thumbUrl?: unknown; name?: unknown };
  const url = supportedImageUrl(attachment.url) ?? supportedImageUrl(attachment.thumbUrl);
  return {
    url,
    thumbnailUrl: supportedImageUrl(attachment.thumbUrl) ?? url,
    name: typeof attachment.name === "string" ? attachment.name : "会话图片",
  };
}

function SenderPreview({ sender, name, request, onOpenProfile, children, avatar = false }: {
  sender: AuditMessage["sender"]; name: string; request: SupportManagementRequest;
  onOpenProfile?: (userId: string) => void; children: ReactElement; avatar?: boolean;
}) {
  if (!sender?.platformId || (sender.role !== "USER" && sender.role !== "ADMIN")) return children;
  return <EntityPreviewTrigger
    className={avatar ? "im-wb-patrol-sender-avatar" : "min-w-0"}
    touchLabel={`预览${sender.role === "ADMIN" ? "客服" : "用户"}信息 ${name}`}
    enableTouchButton={avatar}
    trigger={<button type="button" className="im-wb-patrol-sender-trigger" aria-label={`预览${sender.role === "ADMIN" ? "客服" : "用户"} ${name}`}>{children}</button>}
    content={sender.role === "USER"
      ? onOpenProfile
        ? <UserProfilePreview userId={sender.platformId} name={name} request={request} onOpenProfile={onOpenProfile} />
        : <UserPreviewCard name={name} image={sender.avatar} canOpen={false} deniedReason="无查看用户资料权限" />
      : <AdminMemberPreviewCard member={{ avatar: sender.avatar }} name={name} displayUsername={sender.displayUsername} orderContext={false} />}
  />;
}

export function AuditTimeline({ messages, orderInfo, scope, request, onOpenProfile }: { messages: AuditMessage[]; orderInfo: OrderTeamAccess | null; scope: ImSystemNoticeScope; request: SupportManagementRequest; onOpenProfile?: (userId: string) => void }) {
  let timelineDay = "";
  const nodes: ReactNode[] = [];
  let previous: AuditMessage | undefined;
  const messageKey = (message: AuditMessage) => message.messageServerId || message.messageClientId;
  const noticeOf = (message: AuditMessage) => message.revoked ? null : decodeImSystemNotice(message);
  // Same display rules as the workbench: Bot coverage hides lifecycle notices, identical consecutive ones merge.
  const timeline = collapseImSystemNotices(messages, {
    hasBotMessage: messages.some((message) => !message.revoked && message.sender?.role === "SYSTEM" && !noticeOf(message)),
    noticeOf,
  });
  for (const message of timeline) {
    const notice = noticeOf(message);
    const label = notice ? imSystemNoticeLabel(notice.kind, scope) : null;
    if (notice && label === null) { previous = undefined; continue; }
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      previous = undefined; timelineDay = dayKey;
      nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
    }
    if (notice) {
      previous = undefined;
      const key = messageKey(message);
      nodes.push(<MessageScrollerPrimitive.Item key={key} messageId={key}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{label}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      continue;
    }
    const sender = message.sender;
    const platform = sender?.role === "ADMIN", assistant = sender?.role === "SYSTEM";
    const name = safeIdentityName(sender?.displayName, message.senderId) ?? "会话成员";
    const grouped = Boolean(!assistant && previous && previous.senderId === message.senderId && message.createTime - previous.createTime < GROUP_WINDOW_MS);

    const role = roleLabel(sender?.role);
    const cardText = message.card ? CARD_LABELS[message.card.kind] ?? "订单动态" : message.text;
    const richCard = Boolean(message.card && orderInfo
      && message.card.orderId === orderInfo.orderId
      && (!orderInfo.botAccountId || message.senderId === orderInfo.botAccountId));
    const key = messageKey(message);
    nodes.push(<MessageScrollerPrimitive.Item key={key} messageId={key}>
      <Message align={platform ? "end" : "start"} className="im-wb-msg" data-self={platform} data-grouped={grouped} data-message-id={key}>
        <SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile} avatar><MessageAvatar className="im-wb-av" aria-hidden="true">{assistant ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : <ProfileImage src={sender?.avatar} fallback={initialOf(name)} />}</MessageAvatar></SenderPreview>
        <MessageContent className="im-wb-msg-body" data-card={message.card ? "true" : undefined}>
          {grouped ? null : <MessageHeader className="im-wb-msg-meta"><SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile}><b>{name}</b></SenderPreview>{role ? <span className="im-wb-role-tag" data-role={role}>{role}</span> : null}<time>{formatTime(message.createTime)}</time></MessageHeader>}
          {richCard && orderInfo
            ? <OrderCardMessage message={message} info={orderInfo} />
            : <SupportMessageBody message={{...message,text:cardText}} image={imageOf(message)} replySenderName={safeIdentityName(messages.find(item => item.messageClientId === message.reply?.messageId || item.messageServerId === message.reply?.messageId)?.sender?.displayName)} align={platform ? "end" : "start"} />}
        </MessageContent>
      </Message>
    </MessageScrollerPrimitive.Item>);
    previous = message;
  }
  return <>{nodes}</>;
}
