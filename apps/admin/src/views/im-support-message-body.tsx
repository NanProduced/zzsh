import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { MediaMessage, MessageImage, mediaMessageOf } from "@zzsh/ui/message-media";
import { MessageQuoted } from "@zzsh/ui/message-actions";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { parseOrderReference } from "@zzsh/im-client/nim-web-client";
import { OrderReferenceMessage } from "@zzsh/ui/order-card";

/** Display only: no client, receipt, membership or write capability enters this component. */
export function SupportMessageBody({ message, image, replySenderName, onJump, onOpenOrder, align = "start" }: {
  message: Pick<NimMessageLike, "messageType" | "text" | "media" | "reply" | "revoked">;
  image?: { url: string | null; thumbnailUrl?: string | null; name: string } | null;
  replySenderName?: string | null;
  onJump?: (messageId: string) => void;
  onOpenOrder?: (id: string) => void;
  align?: "start" | "end";
}) {
  if (message.revoked) return <Bubble align={align} variant={align === "end" ? "default" : "secondary"}><BubbleContent className="im-wb-bub" data-revoked="true">消息已撤回</BubbleContent></Bubble>;
  const quoted = message.reply ? <MessageQuoted text={message.reply.text ?? "消息"} senderName={replySenderName} onJump={onJump ? () => onJump(message.reply!.messageId) : undefined} /> : null;
  const reference = !image && !message.media && (message.messageType === undefined || message.messageType === 0) ? parseOrderReference(message.text) : null;
  if (reference) return <><OrderReferenceMessage order={reference.order} onOpenOrder={onOpenOrder} />{reference.caption ? <p className="message-media-caption-text">{reference.caption}</p> : null}{quoted}</>;
  const caption = message.text?.trim() ? <p className="message-media-caption-text">{message.text}</p> : null;
  const media = mediaMessageOf(message);
  if (media) return <><MediaMessage media={media} />{caption}{quoted}</>;
  if (image) return <><MessageImage url={image.url} thumbnailUrl={image.thumbnailUrl} name={image.name} className="im-wb-thumb" />{caption}{quoted}</>;
  const text = message.text?.trim() ? message.text : message.messageType === 0 ? "" : "这条消息暂无法显示";
  return <Bubble align={align} variant={align === "end" ? "default" : "secondary"}><BubbleContent className="im-wb-bub">{text}{quoted}</BubbleContent></Bubble>;
}
