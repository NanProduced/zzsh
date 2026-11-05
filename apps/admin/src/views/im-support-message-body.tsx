import { useEffect, useRef, useState } from "react";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { MediaMessage, MessageImage, mediaMessageOf } from "@zzsh/ui/message-media";
import { MessageQuoted } from "@zzsh/ui/message-actions";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { orderReferenceSummary, parseOrderReference } from "@zzsh/im-client/nim-web-client";
import { OrderReferenceMessage } from "@zzsh/ui/order-card";

type LegacyReferenceResult = { contractVersion: string; subject: { status: string; kind?: string; origin?: string; displayNo?: string; party?: string; target?: { kind?: string; id?: string } } };

/** User-authored card fields are not trusted queue or reply metadata. */
export function supportMessageSummary(text: string): string {
  return parseOrderReference(text)?.order.id.startsWith("legacy_order_") ? "[旧订单]" : orderReferenceSummary(text);
}

function LegacyOrderReference({ id, scopeKey, resolve, onOpenOrder }: { id: string; scopeKey: string; resolve?: (id: string, signal: AbortSignal) => Promise<LegacyReferenceResult>; onOpenOrder?: (id: string) => void }) {
  const [state, setState] = useState<{ busy: boolean; error: string; order?: { displayNo: string; party: "RENTER" | "OWNER" } }>({ busy: false, error: "" });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, [id, scopeKey]);
  const inspect = async () => {
    if (!resolve || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setState({ busy: true, error: "" });
    try {
      const value = await resolve(id, controller.signal), subject = value.subject;
      if (controller.signal.aborted) return;
      if (value.contractVersion !== "im-legacy-order-reference.v1" || subject?.status !== "resolved" || subject.kind !== "ORDER" || subject.origin !== "LEGACY"
        || subject.target?.kind !== "ORDER" || subject.target.id !== id || typeof subject.displayNo !== "string" || !subject.displayNo.trim() || !["RENTER", "OWNER"].includes(subject.party ?? "")) throw new Error("Invalid order reference");
      setState({ busy: false, error: "", order: { displayNo: subject.displayNo, party: subject.party as "RENTER" | "OWNER" } });
    } catch {
      if (!controller.signal.aborted) setState({ busy: false, error: "暂时无法核对该订单。" });
    } finally { if (pending.current === controller) pending.current = null; }
  };
  return <article className="order-card order-reference-card" aria-label="关联旧订单卡片">
    <header className="order-card-head"><strong>旧订单</strong></header>
    {state.order ? <><div className="order-card-account"><strong>订单号 {state.order.displayNo}</strong><span> · {state.order.party === "OWNER" ? "号主" : "租客"}</span></div>
      {onOpenOrder ? <footer className="order-card-foot"><button type="button" className="order-card-action" onClick={() => onOpenOrder(id)}>查看订单</button></footer> : null}</>
      : <footer className="order-card-foot">{resolve ? <button type="button" className="order-card-action" disabled={state.busy} onClick={() => void inspect()}>{state.busy ? "正在核对…" : "核对订单"}</button> : <span>请在咨询中核对订单</span>}</footer>}
    {state.error ? <p role="alert">{state.error}</p> : null}
  </article>;
}

/** Display only: no client, receipt, membership or write capability enters this component. */
export function SupportMessageBody({ message, image, replySenderName, onJump, onOpenOrder, resolveLegacyOrder, legacyScopeKey, allowLegacyOrderOpen = false, align = "start" }: {
  message: Pick<NimMessageLike, "messageType" | "text" | "media" | "reply" | "revoked">;
  image?: { url: string | null; thumbnailUrl?: string | null; name: string } | null;
  replySenderName?: string | null;
  onJump?: (messageId: string) => void;
  onOpenOrder?: (id: string) => void;
  resolveLegacyOrder?: (id: string, signal: AbortSignal) => Promise<LegacyReferenceResult>;
  legacyScopeKey?: string;
  allowLegacyOrderOpen?: boolean;
  align?: "start" | "end";
}) {
  if (message.revoked) return <Bubble align={align} variant={align === "end" ? "default" : "secondary"}><BubbleContent className="im-wb-bub" data-revoked="true">消息已撤回</BubbleContent></Bubble>;
  const quoted = message.reply ? <MessageQuoted text={message.reply.text ?? "消息"} senderName={replySenderName} onJump={onJump ? () => onJump(message.reply!.messageId) : undefined} /> : null;
  const reference = !image && !message.media && (message.messageType === undefined || message.messageType === 0) ? parseOrderReference(message.text) : null;
  if (reference) return <>{reference.order.id.startsWith("legacy_order_")
    ? <LegacyOrderReference key={`${legacyScopeKey ?? ""}:${reference.order.id}`} id={reference.order.id} scopeKey={legacyScopeKey ?? ""} resolve={resolveLegacyOrder} onOpenOrder={allowLegacyOrderOpen ? onOpenOrder : undefined} />
    : <OrderReferenceMessage order={reference.order} onOpenOrder={onOpenOrder} />}{reference.caption ? <p className="message-media-caption-text">{reference.caption}</p> : null}{quoted}</>;
  const caption = message.text?.trim() ? <p className="message-media-caption-text">{message.text}</p> : null;
  const media = mediaMessageOf(message);
  if (media) return <><MediaMessage media={media} />{caption}{quoted}</>;
  if (image) return <><MessageImage url={image.url} thumbnailUrl={image.thumbnailUrl} name={image.name} className="im-wb-thumb" />{caption}{quoted}</>;
  const text = message.text?.trim() ? message.text : message.messageType === 0 ? "" : "这条消息暂无法显示";
  return <Bubble align={align} variant={align === "end" ? "default" : "secondary"}><BubbleContent className="im-wb-bub">{text}{quoted}</BubbleContent></Bubble>;
}
