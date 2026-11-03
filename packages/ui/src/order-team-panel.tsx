"use client";
import { ProfileImage } from "./profile-image";
import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ImLifecycleSupersededError } from "@zzsh/im-client/lifecycle";
import { mergeImMessages } from "@zzsh/im-client/message-state";
import { NimImageSendError, NimMediaSendError, NimTextSendError, validateNimImageFile, validateNimMediaFile, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState, type NimMessageAuthorization } from "@zzsh/im-client/nim-web-client";
import { CHAT_EMOJIS, MessageActionMenu, MessageQuoted, MessageReplyQuote, useMessageLongPress, type MessageActionId, type MessageActionItem, type MessageLongPressHandlers } from "./message-actions";
import { MediaDraftBar, MediaMessage, MediaPreview, MessageImage, mediaMessageOf, mediaSummaryOf, type MessageMediaDraft } from "./message-media";
import { OrderCardMessage } from "./order-card";

/** Composer icons live in this package (no icon dependency); tooltips are CSS-only. */
function ComposerIcon({ id }: { id: "emoji" | "image" | "video" | "file" | "info" }) {
  const paths: Record<typeof id, ReactNode> = {
    emoji: <><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
    video: <><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></>,
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id]}</svg>;
}

type Member={platformId:string;accountId:string;party:string;name:string|null;avatar:string|null;responsible?:boolean;membershipStatus?:string;identityStatus?:string};
export type OrderTeamMember=Member;
export type OrderTeamListItem=OrderItem;
export type OrderTeamImageDraft=ImageDraft;
export type OrderTeamConversationMessage=NimMessageLike&{id:string};
type SupportEscalation={firstResponseAt:string|null;remindDueAt:string|null;addRound:number;state:string;needsManualReview:boolean;noEligibleStaff:boolean};
type MessageRouteGrant={appId:string;orderId:string;teamId:string;conversationId:string;routeEnvironment:string};
export type OrderTeamFulfillmentStage="PENDING_PAYMENT"|"WAITING_STAFF"|"TEAM_PENDING"|"OPENING_CONFIRM"|"RENTING"|"ENDING"|"SETTLED"|"CANCELLED";
/** Role-projected frozen-quote amounts in CNY cents. Users only ever receive their own side. */
export type OrderTeamTermsViewerParty="RENTER"|"OWNER"|"STAFF";
export type OrderTeamTermsLine={itemId:string;name:string|null;quantity:string;unitPrice:string|null;amount:string|null;
  buyerUnitPrice?:string|null;ownerUnitPrice?:string|null;buyerAmount?:string|null;ownerAmount?:string|null;platformContribution?:string|null};
export type OrderTeamTermsStaff={buyerRentalAmount:string|null;ownerRentalAmount:string|null;buyerTotal:string|null;ownerTotal:string|null;platformContribution:string|null};
export type OrderTeamTerms={viewerParty:OrderTeamTermsViewerParty;basis:"QUOTE"|"UNKNOWN";currency:"CNY";scale:2;version:string|null;
  rentalAmount:string|null;depositAmount:string|null;paidTotal:string|null;lines:OrderTeamTermsLine[];staff?:OrderTeamTermsStaff};
export type OrderTeamAccess={orderId:string;displayNo:string;orderStatus:string;
  cancelReason?:string|null;refundPending?:boolean;refundCompletedAt?:string|null;
  stage?:OrderTeamFulfillmentStage;rentalStartedAt?:string|null;dueAt?:string|null;
  openingState?:"NONE"|"DRAFT"|"PARTIAL"|"CONFIRMED";endState?:"NONE"|"REQUESTED"|"POSTED";
  openingAcks?:{renter:boolean;owner:boolean};
  openingAckSources?:{renter:"PARTY"|"ON_BEHALF"|"AUTO"|null;owner:"PARTY"|"ON_BEHALF"|"AUTO"|null};
  openingId?:string|null;openingVersion?:number|null;
  openingConfirmDueAt?:string|null;openingConfirmSource?:"PARTY"|"ON_BEHALF"|"AUTO"|null;
  orderEndedAt?:string|null;sendUntil?:string|null;assignmentState:string|null;teamState:string|null;
  appId?:string;teamId?:string;name?:string;gameName:string;account:{id:string;title:string};viewerAccountId?:string;botAccountId?:string|null;conversationId?:string;messageRoute?:MessageRouteGrant;canRead:boolean;canSend:boolean;members:Member[];supportEscalation:SupportEscalation;
  terms?:OrderTeamTerms;terminalSendAllowed?:boolean;serverNow?:string;
  frozenInventory?:Array<{itemId:string;quantity:string;unit:string;pricingKind:string;name:string|null}>};
type OrderItem={id:string;displayNo:string;title:string;status:string;stage?:OrderTeamFulfillmentStage;dueAt?:string|null;todo?:string|null;firstResponseOverdue?:boolean;teamState?:string|null;firstResponseAt?:string|null;remindDueAt?:string|null;lastMessageAt?:string|null;lastMessagePreview?:string|null;createdAt?:string|null;unreadCount?:number;addRound?:number;escalationState?:string;fulfillmentAssignment?:{state:string;teamState:string|null}|null};
type OrderPage={items:OrderItem[];nextCursor:string|null};
type ListRefresh={scope:string;targetPages:number;pagesRead:number;cursor:string|null|undefined;items:OrderItem[]};
const REFRESH_PAGE_BUDGET=2;
type Requester=<T>(path:string)=>Promise<T>;
type FulfillmentSlotContext={orderId:string;displayNo:string;teamState:string|null;canSend:boolean;frozenInventory?:OrderTeamAccess["frozenInventory"]};
type Props={identity:string;realm:"user"|"admin";client:NimWebClientLike|null;connection:NimWebConnectionState|"idle"|"error";active:boolean;visible?:boolean;polling?:boolean;selectedOrderId?:string;compact?:boolean;initialParty?:"renter"|"owner";sendAllowed?:boolean;layout?:"inline"|"aside";
  request:Requester;onAuthError:(status:number)=>void;renderFulfillment?:(context:FulfillmentSlotContext)=>ReactNode;
  renderList?:(view:OrderTeamListView)=>ReactNode;renderAside?:(view:OrderTeamAsideView)=>ReactNode;renderConversation?:(view:OrderTeamConversationView)=>ReactNode;
  /** Group-level actions appended to the message menu (pin/mute/hide/settings). */
  extraMenuItems?:MessageActionItem[];onExtraMenuAction?:(id:MessageActionId)=>void;
  /** Inline opening confirmation. The callback performs the authorized write; the panel re-reads server truth. */
  onConfirmOpening?:(info:OrderTeamAccess)=>Promise<void>;
  /** Ended/read-only groups: open the ordinary SERVICE support thread with this order as context. */
  onRequestAfterSales?:(info:OrderTeamAccess)=>void;
  /** Suppress the browser menu on blank panel space; rows/messages own their own menus. */
  onBlankContextMenu?:(event:ReactMouseEvent<HTMLElement>)=>void;
  onSelectedOrderChange?:(id:string|null)=>void;
  gridPane?:"list"|"chat"|"details";gridDetailsOpen?:boolean};
/** Presentation-only seams. Every read, authorization, draft and send decision stays in this module. */
export type OrderTeamListView={items:OrderItem[];selectedId:string|null;onSelect:(id:string|null)=>void;loading:boolean;refreshing:boolean;nextCursor:string|null;onLoadMore:()=>void};
export type OrderTeamAsideView={info:OrderTeamAccess;fulfillment:ReactNode;escalation:ReactNode;members:ReactNode};
export type OrderTeamConversationView={
  info:OrderTeamAccess;messages:OrderTeamConversationMessage[];connection:Props["connection"];accountId:string;
  draft:string;setDraft:(value:string)=>void;stagedImages:ImageDraft[];pendingImage:ImageDraft|null;
  mediaDraft:MessageMediaDraft|null;isMediaSending:boolean;
  onStageMedia:(file:File,kind:"video"|"file")=>void;onRemoveMedia:()=>void;onRetryMedia:()=>void;
  error:string;reading:boolean;sending:boolean;hasMore:boolean;textRetry:{messageClientId?:string;text:string}|null;
  viewer:{url:string;name:string}|null;openImage:(url:string,name:string,trigger:HTMLButtonElement)=>void;closeImage:()=>void;
  canSend:boolean;isImageSending:boolean;imageBlocked:boolean;
  onRefresh:()=>void;onLoadEarlier:()=>void;onSubmit:(event:FormEvent)=>void;onStageFiles:(files:File[])=>void;
  onRemoveStaged:(previewUrl:string)=>void;onRemovePending:()=>void;onRetryText:()=>void;onRetryPendingImage:()=>void;
  menuHandlers:{onContextMenu:(event:ReactMouseEvent<HTMLElement>)=>void;longPress:MessageLongPressHandlers};
  replyLabel:string|null;onCancelReply:()=>void;
  /** Re-reads the role-projected access after a server-side action (acks/stage). */
  refreshAccess:()=>Promise<void>;
};
const statusOf=(e:unknown)=>(e as {status?:number}|null)?.status;
const superseded=(e:unknown)=>e instanceof ImLifecycleSupersededError;
const rejected=()=>Object.assign(new Error("当前订单未获授权"),{status:403});
const REPLY_UNCERTAIN="回复结果未确认，请刷新确认后再发送；取消引用后可按普通消息发送。";
const replySummaryOf=(message:NimMessageLike):string=>message.messageType===1?"[图片]":mediaSummaryOf(message)??(typeof message.text==="string"&&message.text.trim()?message.text.trim().slice(0,120):"消息");
const unconfirmedReply=(cause:unknown):boolean=>cause instanceof NimTextSendError?cause.kind==="UNKNOWN":statusOf(cause)===undefined||(statusOf(cause)??0)>=500;
const copyableText=(message:NimMessageLike):string|null=>(message.messageType===undefined||message.messageType===0)&&typeof message.text==="string"&&message.text.trim()?message.text:null;
function messageRowOf(target:EventTarget|null):HTMLElement|null{
  const element=target as {closest?:(selector:string)=>HTMLElement|null}|null;
  if(!element||typeof element.closest!=="function")return null;
  return element.closest("[data-message-id]");
}
function orderEndLabel(order:{orderStatus?:string;status?:string}):string|null{
  const status=order.orderStatus??order.status;
  return status==="COMPLETED"?"订单已完成":status==="CANCELLED"?"已取消":null;
}
function orderEndNotice(order:{orderStatus?:string;status?:string;sendUntil?:string|null;terminalSendAllowed?:boolean;serverNow?:string}):string|null{
  const status=order.orderStatus??order.status;
  if(status!=="COMPLETED"&&status!=="CANCELLED")return null;
  const ended=status==="COMPLETED"?"已完成":"已取消";
  const until=order.sendUntil?new Date(order.sendUntil).getTime():Number.NaN;
  const now=typeof order.serverNow==="string"?new Date(order.serverNow).getTime():Date.now();
  const allowed=typeof order.terminalSendAllowed==="boolean"
    ? order.terminalSendAllowed
    : (Number.isFinite(until)&&Number.isFinite(now)&&now<until);
  if(allowed){
    return order.sendUntil
      ? `本单${ended}，可在 ${serverTimeLabel(order.sendUntil)} 前继续沟通。`
      : `本单${ended}，可在沟通窗口内继续沟通。`;
  }
  if(order.sendUntil||typeof order.terminalSendAllowed==="boolean"){
    return `本单${ended}已超过 72 小时，消息仅可查看。`;
  }
  return `本单${ended}，消息仅可查看。`;
}
export type OrderStageTone="attention"|"live"|"done"|"danger";
/** 列表状态色只编码下一步：要处理、进行中、已结束、需核查。 */
export function orderStageTone(order:{orderStatus?:string;status?:string;stage?:OrderTeamFulfillmentStage|null;teamState?:string|null;fulfillmentAssignment?:OrderItem["fulfillmentAssignment"]}):OrderStageTone{
  const status=order.orderStatus??order.status;
  if(status==="COMPLETED"||status==="CANCELLED"||order.stage==="SETTLED"||order.stage==="CANCELLED")return "done";
  if(order.stage==="RENTING")return "live";
  const team=order.teamState??order.fulfillmentAssignment?.teamState;
  if(team==="NEEDS_REVIEW")return "danger";
  return "attention";
}
export function orderTeamLabel(order:{orderStatus?:string;status?:string;stage?:OrderTeamFulfillmentStage|null;assignmentState?:string|null;teamState?:string|null;fulfillmentAssignment?:OrderItem["fulfillmentAssignment"]}):string{
  const status=order.orderStatus??order.status;
  if(status==="PENDING_PAYMENT")return "未付款";
  const ended=orderEndLabel(order);if(ended)return ended;
  const team=order.teamState??order.fulfillmentAssignment?.teamState;
  if(team==="NEEDS_REVIEW")return "建群待人工核查";
  // The list only carries a stage once the server projects it; older rows fall back to provisioning facts.
  if(order.stage)return fulfillmentStageLabel(order.stage);
  if(team==="READY")return "订单群已就绪";
  return (order.assignmentState??order.fulfillmentAssignment?.state)==="ASSIGNED"?"已分配 · 正在准备订单群":"已付款 · 等待匹配客服";
}
const FULFILLMENT_STEPS=[{key:"PAID",label:"已付款"},{key:"TEAM",label:"客服与群"},{key:"OPENING",label:"账号与开租"},{key:"RENTING",label:"租用中"},{key:"ENDING",label:"结束确认"},{key:"SETTLED",label:"结算完成"}] as const;
export function fulfillmentStageLabel(stage:OrderTeamFulfillmentStage|undefined):string{
  switch(stage){
    case "PENDING_PAYMENT":return "待付款";case "WAITING_STAFF":return "等待客服";case "TEAM_PENDING":return "组建订单群";
    case "OPENING_CONFIRM":return "账号与开租确认";case "RENTING":return "租用中";case "ENDING":return "结束确认";
    case "SETTLED":return "结算完成";case "CANCELLED":return "已取消";default:return "进行中";
  }
}
function stageStepIndex(stage:OrderTeamFulfillmentStage|undefined):number{
  switch(stage){case "PENDING_PAYMENT":return -1;case "WAITING_STAFF":case "TEAM_PENDING":return 1;case "OPENING_CONFIRM":return 2;case "RENTING":return 3;case "ENDING":return 4;case "SETTLED":return 5;default:return -1;}
}
type FulfillmentStepState="done"|"current"|"pending"|"cancelled";
/** One rule for both the collapsed bar and the chat empty-state timeline. */
function stageStepState(stage:OrderTeamFulfillmentStage,index:number):FulfillmentStepState{
  if(stage==="SETTLED")return "done";
  if(stage==="CANCELLED")return "cancelled";
  const current=stageStepIndex(stage);
  return index<current?"done":index===current?"current":"pending";
}
const orderDetailPath=(order:{orderId:string},party:"renter"|"owner")=>`/account?view=${party==="owner"?"leased":"rentals"}&orderId=${encodeURIComponent(order.orderId)}`;
function stageOf(info:OrderTeamAccess):OrderTeamFulfillmentStage{
  return info.stage??(info.orderStatus==="PENDING_PAYMENT"?"PENDING_PAYMENT":info.orderStatus==="COMPLETED"?"SETTLED":info.orderStatus==="CANCELLED"?"CANCELLED":info.teamState==="READY"?(info.openingState==="CONFIRMED"?"RENTING":"OPENING_CONFIRM"):"WAITING_STAFF");
}
function stageCollapsedText(info:OrderTeamAccess):string{
  const stage=stageOf(info);
  if(stage==="PENDING_PAYMENT")return "待付款";
  if(stage==="WAITING_STAFF")return "已付款 · 等待客服接入";
  if(stage==="TEAM_PENDING")return "已付款 · 正在组建订单群";
  if(stage==="OPENING_CONFIRM"){
    const acks=info.openingAcks;
    const who=acks?`租客${acks.renter?"已确认":"待确认"} · 号主${acks.owner?"已确认":"待确认"}`:null;
    return who?`账号与开租确认 · ${who}`:"账号与开租确认";
  }
  if(stage==="RENTING"){
    if(info.dueAt){const due=new Date(info.dueAt).getTime();return Number.isFinite(due)&&due<Date.now()?`租用中 · 已到期 ${serverTimeLabel(info.dueAt)}`:`租用中 · 到期 ${serverTimeLabel(info.dueAt)}`;}
    return "租用中";
  }
  if(stage==="ENDING")return "结束确认 · 等待双方确认";
  if(stage==="CANCELLED"){
    const until=info.sendUntil?new Date(info.sendUntil).getTime():Number.NaN;
    const now=typeof info.serverNow==="string"?new Date(info.serverNow).getTime():Date.now();
    const allowed=typeof info.terminalSendAllowed==="boolean"
      ? info.terminalSendAllowed
      : (Number.isFinite(until)&&Number.isFinite(now)&&now<until);
    if(info.cancelReason==="PRESTART_TERMINATED"){
      if(info.refundPending===true||allowed)return info.sendUntil?`未开租终止 · 可沟通至 ${serverTimeLabel(info.sendUntil)}`:"未开租终止 · 退款处理中 · 可沟通";
      return "未开租终止 · 仅可查看";
    }
    if(info.cancelReason==="MANUAL_CLOSE"){
      if(allowed)return info.sendUntil?`客服手动结束 · 可沟通至 ${serverTimeLabel(info.sendUntil)}`:"客服手动结束 · 可沟通";
      return "客服手动结束 · 仅可查看";
    }
    return allowed?(info.sendUntil?`已取消 · 可沟通至 ${serverTimeLabel(info.sendUntil)}`:"已取消 · 可沟通"):"已取消";
  }
  const until=info.sendUntil?new Date(info.sendUntil).getTime():Number.NaN;
  const now=typeof info.serverNow==="string"?new Date(info.serverNow).getTime():Date.now();
  const allowed=typeof info.terminalSendAllowed==="boolean"
    ? info.terminalSendAllowed
    : (Number.isFinite(until)&&Number.isFinite(now)&&now<until);
  if(allowed)return info.sendUntil?`结算完成 · 可沟通至 ${serverTimeLabel(info.sendUntil)}`:"结算完成 · 可沟通";
  return info.sendUntil||typeof info.terminalSendAllowed==="boolean"
    ? "结算完成 · 已超过 72 小时 · 仅可查看"
    : "结算完成";
}
/** Compact six-step bar. Collapsed it is one line; the steps stay available without becoming a dashboard. */
export function FulfillmentStageBar({info,transport,connection}:{info:OrderTeamAccess;transport?:"nim"|"local-fake";connection?:string}){
  const [open,setOpen]=useState(false);
  const stage=stageOf(info);
  const tone=stage==="CANCELLED"?"warn":stage==="SETTLED"?"done":stage==="ENDING"?"active":"active";
  return <section className="order-team-stage" data-open={open} data-stage={stage} data-tone={tone} aria-label="订单阶段">
    <button type="button" className="order-team-stage-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
      <span className="order-team-stage-dot" data-tone={tone} aria-hidden="true"/>
      <span className="order-team-stage-now">{stageCollapsedText(info)}</span>
      {transport==="local-fake"?<span className="order-team-stage-env">本地测试</span>:null}
      {connection&&connection!=="CONNECTED"?<span className="order-team-stage-env" data-tone="warn">{connection==="RECONNECTING"?"重连中":"未连接"}</span>:null}
      <span className="order-team-stage-chevron" aria-hidden="true"/>
    </button>
    {open?<ol className="order-team-stage-steps">{FULFILLMENT_STEPS.map((step,index)=>{
      const state=stageStepState(stage,index);
      return <li key={step.key} data-state={state}><span className="order-team-stage-step-mark" aria-hidden="true"/><span>{step.label}</span></li>;
    })}</ol>:null}
  </section>;
}
/** NIM history can be empty even when the order is settled; order facts still tell the six-step story. */
export function OrderTeamChatEmptyState({info,reading,orderDetailHref}:{info:OrderTeamAccess;reading:boolean;orderDetailHref?:string}){
  const stage=stageOf(info),current=stageStepIndex(stage);
  return <div className="order-team-chat-empty" role="status">
    <span className="order-team-empty-mark" aria-hidden="true"/>
    <strong>{reading?"正在读取消息…":"还没有消息"}</strong>
    <span className="order-team-chat-empty-copy">{reading?"请稍候":"本单暂时还没有消息。"}{orderDetailHref?<a className="order-team-chat-empty-link" href={orderDetailHref}>查看订单详情</a>:null}</span>
    <ol className="order-team-stage-steps" aria-label="订单阶段时间线">
      {FULFILLMENT_STEPS.map((step,index)=>{const state=stageStepState(stage,index);
        return <li key={step.key} data-state={state} {...(index===current&&state==="current"?{"aria-current":"step" as const}:{})}><span className="order-team-stage-step-mark" aria-hidden="true"/><span>{step.label}</span></li>;})}
    </ol>
  </div>;
}
// Read-only formatter adapted from the reviewed order Web candidate; no write flow imported.
function serverTimeLabel(value:string):string{
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(date):"时间暂不可用";
}
const CHAT_TIME_ZONE="Asia/Shanghai";
function chatDayParts(ms:number):{key:string;year:number;month:number;day:number}|null{
  const date=new Date(ms);if(!Number.isFinite(date.getTime()))return null;
  const parts=new Intl.DateTimeFormat("en",{timeZone:CHAT_TIME_ZONE,year:"numeric",month:"numeric",day:"numeric"}).formatToParts(date);
  const read=(type:string)=>Number(parts.find(part=>part.type===type)?.value);
  const year=read("year"),month=read("month")-1,day=read("day");
  return [year,month,day].every(Number.isFinite)?{key:`${year}-${month}-${day}`,year,month,day}:null;
}
function chatDayDiff(parts:{year:number;month:number;day:number},today:{year:number;month:number;day:number}):number{
  return Date.UTC(today.year,today.month,today.day)/86_400_000-Date.UTC(parts.year,parts.month,parts.day)/86_400_000;
}
function chatDayKey(ms:number):string|null{return chatDayParts(ms)?.key??null}
function chatDayLabel(ms:number):string{
  const parts=chatDayParts(ms),today=chatDayParts(Date.now());
  if(!parts||!today)return "日期暂不可用";
  const days=chatDayDiff(parts,today);
  if(days===0)return "今天";
  if(days===1)return "昨天";
  if(days>1&&days<7)return new Intl.DateTimeFormat("zh-CN",{timeZone:CHAT_TIME_ZONE,weekday:"short"}).format(new Date(ms));
  return parts.year===today.year?`${parts.month+1}月${parts.day}日`:`${parts.year}年${parts.month+1}月${parts.day}日`;
}
function chatTimeLabel(value:string):string{
  const date=new Date(value),ms=date.getTime();
  if(!Number.isFinite(ms))return "时间暂不可用";
  const time=new Intl.DateTimeFormat("zh-CN",{timeZone:CHAT_TIME_ZONE,hour:"2-digit",minute:"2-digit"}).format(date);
  const parts=chatDayParts(ms),today=chatDayParts(Date.now());
  if(!parts||!today)return time;
  const days=chatDayDiff(parts,today);
  if(days===0)return time;
  if(days===1)return `昨天 ${time}`;
  if(days>1&&days<7)return `${new Intl.DateTimeFormat("zh-CN",{timeZone:CHAT_TIME_ZONE,weekday:"short"}).format(date)} ${time}`;
  return parts.year===today.year?`${parts.month+1}月${parts.day}日 ${time}`:`${parts.year}年${parts.month+1}月${parts.day}日 ${time}`;
}
export function escalationStateLabel(state:string,firstResponseAt:string|null=null):string{
  switch(state){
    case "RUNNING":return "待客服回应";
    case "STOPPED":return firstResponseAt?"已收到客服回应":"接待跟踪已停止";
    case "EXHAUSTED":return "暂无合格客服可补派";
    case "VERIFY_REQUIRED":return "补派结果待人工核验";
    case "NOT_STARTED":return "接待跟踪未启用";
    default:return "接待状态待确认";
  }
}
export function escalationReviewReason(value:Pick<SupportEscalation,"needsManualReview"|"noEligibleStaff">):string|null{
  if(!value.needsManualReview)return null;
  return value.noEligibleStaff?"待人工处理：当前没有符合条件的客服可补派":"待人工核验：补派结果尚未确认";
}
function AdminEscalationSummary({item}:{item:OrderItem}){
  if(item.teamState!=="READY")return null;
  // Escalation tracking only matters while the order runs; an ended order needs no attention chip.
  if(item.status==="COMPLETED"||item.status==="CANCELLED")return null;
  const state=item.escalationState??"NOT_STARTED";
  const review=state==="EXHAUSTED"?"待人工处理 · 暂无合格客服":state==="VERIFY_REQUIRED"?"待人工核验 · 补派结果待确认":null;
  return <span className="order-team-list-escalation" aria-label="订单群接待状态">
    <small>{escalationStateLabel(state,item.firstResponseAt)}</small>
    {state==="RUNNING"&&item.remindDueAt?<small>提醒节点 · {serverTimeLabel(item.remindDueAt)}</small>:null}
    {item.firstResponseAt?<small>首响时间 · {serverTimeLabel(item.firstResponseAt)}</small>:null}
    <small>补派轮次 · {item.addRound??0}</small>
    {review?<small>{review}</small>:null}
  </span>;
}
function OrderTeamEscalation({value}:{value:SupportEscalation}){
  const review=escalationReviewReason(value);
  return <section className="order-team-escalation" aria-label="接待状态">
    <div className="order-team-escalation-heading">
      <strong>{escalationStateLabel(value.state,value.firstResponseAt)}</strong>
      {value.state==="NOT_STARTED"?<small>此订单群未启用接待跟踪。</small>:null}
      {value.state==="STOPPED"?<small>首响后自动提醒与补派已停止。</small>:null}
    </div>
    <dl>
      {value.state==="RUNNING"?<div><dt>提醒节点</dt><dd>{value.remindDueAt?<time dateTime={value.remindDueAt}>{serverTimeLabel(value.remindDueAt)}</time>:"暂未提供"}</dd></div>:null}
      {value.firstResponseAt?<div><dt>首响时间</dt><dd><time dateTime={value.firstResponseAt}>{serverTimeLabel(value.firstResponseAt)}</time></dd></div>:null}
      <div><dt>补派轮次</dt><dd>{value.addRound}</dd></div>
    </dl>
    {review?<p className="order-team-escalation-review" role="status">{review}</p>:null}
    <small className="order-team-escalation-note">接待与消息状态不代表订单交付或结算。</small>
  </section>;
}
export const orderTeamMemberRole=(m:OrderTeamMember)=>m.party==="BUYER"?"租客":m.party==="OWNER"?"号主":m.responsible?"负责客服":"协作客服";
const role=orderTeamMemberRole;
type ImageAttachment=NonNullable<NimMessageLike["attachment"]>;
type ImageDraft={file:File;previewUrl:string;name:string;size:number;width:number;height:number;state:"DECODING"|"READY"|"SENDING"|"FAILED"|"UNKNOWN";progress:number;messageClientId?:string};
type TextDraft={text:string;messageClientId?:string;state:"SENDING"|"UNKNOWN"};
function supportedImageUrl(value:unknown):string|null{
  if(typeof value!=="string"||value.length>2048)return null;
  if(/^\/api\/(?:im|bff\/admin\/im)\/images\/[A-Za-z0-9._:-]{1,128}$/.test(value))return value;
  try{const parsed=new URL(value,typeof window==="undefined"?"https://invalid.local":window.location.origin),protocol=parsed.protocol.toLowerCase();if(["blob:","data:","file:","javascript:"].includes(protocol))return null;return protocol==="https:"||(protocol==="http:"&&typeof window!=="undefined"&&parsed.origin===window.location.origin)?parsed.href:null;}catch{return null;}
}
function decodeImage(url:string):Promise<{width:number;height:number}>{
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>image.naturalWidth>0&&image.naturalHeight>0?resolve({width:image.naturalWidth,height:image.naturalHeight}):reject(new Error("图片无法解码"));image.onerror=()=>reject(new Error("图片无法解码"));image.src=url;});
}
function formatBytes(value:number):string{return value>=1024*1024?`${(value/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.round(value/1024))} KiB`;}
function imageErrorMessage(error:unknown):string{
  if(error instanceof NimImageSendError&&error.kind==="UNKNOWN")return "图片发送结果未确认，请先刷新历史；确认未发送后再重试";
  return statusOf(error)===403?"发送权限已变化，图片草稿已保留":"图片发送失败，可重试";
}
function OrderMessageImage({attachment}:{attachment:ImageAttachment}){
  const thumbnail=supportedImageUrl((attachment as {thumbUrl?:unknown}).thumbUrl)??supportedImageUrl(attachment.url);
  const full=supportedImageUrl(attachment.url)??thumbnail;
  return <MessageImage url={full} thumbnailUrl={thumbnail} name={typeof attachment.name==="string"?attachment.name:"订单图片"} className="order-team-image"/>;
}

/** Both platforms pass their existing client. This component never logs in or creates a Team. */
export function OrderTeamPanel({identity,realm,client,connection,active,visible=true,polling=true,selectedOrderId,compact=false,initialParty="renter",sendAllowed=true,layout="inline",request,onAuthError,renderFulfillment,renderList,renderAside,renderConversation,extraMenuItems,onExtraMenuAction,onConfirmOpening,onRequestAfterSales,onBlankContextMenu,onSelectedOrderChange,gridPane,gridDetailsOpen}:Props){
  const [party,setParty]=useState(initialParty),[items,setItems]=useState<OrderItem[]>([]),[next,setNext]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[info,setInfo]=useState<OrderTeamAccess|null>(null),[error,setError]=useState("");
  // 「重新确认授权」只在真的失权（401/403/423）时才是恢复动作；正常列表不该常驻一个
  // 语义模糊的按钮。其它失败是读取错误，靠面板自身的轮询重试，不假装是权限问题。
  const [unauthorized,setUnauthorized]=useState(false);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[refreshingPages,setRefreshingPages]=useState(false),[drafts,setDrafts]=useState<Record<string,string>>({});
  const [stagedByOrder,setStagedByOrder]=useState<Record<string,ImageDraft[]>>({});
  const [pendingByOrder,setPendingByOrder]=useState<Record<string,ImageDraft|null>>({});
  const [pendingTextByOrder,setPendingTextByOrder]=useState<Record<string,TextDraft|null>>({});
  const [mediaByOrder,setMediaByOrder]=useState<Record<string,MessageMediaDraft|null>>({});
  const pendingTextByOrderRef=useRef(pendingTextByOrder);pendingTextByOrderRef.current=pendingTextByOrder;
  const stagedByOrderRef=useRef(stagedByOrder);stagedByOrderRef.current=stagedByOrder;
  const pendingByOrderRef=useRef(pendingByOrder);pendingByOrderRef.current=pendingByOrder;
  const mediaByOrderRef=useRef(mediaByOrder);mediaByOrderRef.current=mediaByOrder;
  const identityRef=useRef(identity);identityRef.current=identity;
  const sendingClientRef=useRef(client);sendingClientRef.current=client;
  const textAttempts=useRef(new Map<string,{draft:TextDraft;client:NimWebClientLike;unknown:boolean}>());
  const imageAttempts=useRef(new Map<string,{draft:ImageDraft;unknown:boolean;client:NimWebClientLike|null}>());
  const mediaAttempts=useRef(new Map<string,{draft:MessageMediaDraft;unknown:boolean;client:NimWebClientLike|null}>());
  const beginPendingText=useCallback((targetDraftKey:string,text:string,messageClientId?:string):TextDraft|null=>{
    if(textAttempts.current.has(targetDraftKey)||imageAttempts.current.has(targetDraftKey)||!sendingClientRef.current)return null;
    try{if(JSON.parse(targetDraftKey)[0]!==identityRef.current)return null;}catch{return null;}
    const previous=pendingTextByOrderRef.current[targetDraftKey];
    if(previous?.state==="UNKNOWN"&&(!messageClientId||messageClientId!==previous.messageClientId))return null;
    const attempt:TextDraft={text,messageClientId,state:"SENDING"};
    textAttempts.current.set(targetDraftKey,{draft:attempt,client:sendingClientRef.current,unknown:previous?.state==="UNKNOWN"});
    pendingTextByOrderRef.current={...pendingTextByOrderRef.current,[targetDraftKey]:attempt};setPendingTextByOrder(pendingTextByOrderRef.current);
    return attempt;
  },[]);
  const settlePendingText=useCallback((targetDraftKey:string,attempt:TextDraft,result:{success:boolean;error?:unknown})=>{
    const flight=textAttempts.current.get(targetDraftKey);
    if(flight?.draft!==attempt)return;
    textAttempts.current.delete(targetDraftKey);
    try{if(JSON.parse(targetDraftKey)[0]!==identityRef.current)return;}catch{return;}
    const previous=pendingTextByOrderRef.current[targetDraftKey];
    if(!previous)return;
    if(result.success){
      pendingTextByOrderRef.current={...pendingTextByOrderRef.current,[targetDraftKey]:null};
      setDrafts(current=>current[targetDraftKey]?.trim()===attempt.text?{...current,[targetDraftKey]:""}:current);
    }else{
      const cause=result.error,textError=cause instanceof NimTextSendError?cause:null;
      // View expiry aborts authorization before dispatch; a replaced SDK may lose an in-flight receipt.
      const unknown=flight.unknown||textError?.kind==="UNKNOWN"||(superseded(cause)&&flight.client!==sendingClientRef.current);
      const messageClientId=textError?.messageClientId??attempt.messageClientId;
      pendingTextByOrderRef.current={...pendingTextByOrderRef.current,[targetDraftKey]:unknown?{text:previous.text,messageClientId,state:"UNKNOWN"}:null};
    }
    setPendingTextByOrder(pendingTextByOrderRef.current);
  },[]);
  const beginPendingImage=useCallback((targetDraftKey:string,image:ImageDraft):ImageDraft|null=>{
    if(imageAttempts.current.has(targetDraftKey)||textAttempts.current.has(targetDraftKey)||pendingTextByOrderRef.current[targetDraftKey]?.state==="UNKNOWN")return null;
    try{if(JSON.parse(targetDraftKey)[0]!==identityRef.current)return null;}catch{return null;}
    const attempt:ImageDraft={...image,state:"SENDING",progress:0};
    imageAttempts.current.set(targetDraftKey,{draft:attempt,unknown:image.state==="UNKNOWN",client:sendingClientRef.current});
    setPendingByOrder(current=>({...current,[targetDraftKey]:attempt}));
    return attempt;
  },[]);
  const settlePendingImage=useCallback((targetDraftKey:string,attempt:ImageDraft,result:{success:boolean;error?:unknown;cancelledBeforeDispatch?:boolean})=>{
    const flight=imageAttempts.current.get(targetDraftKey);
    if(flight?.draft!==attempt)return;
    imageAttempts.current.delete(targetDraftKey);
    try{const [savedIdentity]=JSON.parse(targetDraftKey);if(savedIdentity!==identityRef.current)return;}catch{return;}
    setPendingByOrder(current=>{
      const prev=current[targetDraftKey];
      if(!prev||prev.file!==attempt.file||prev.previewUrl!==attempt.previewUrl)return current;
      if(result.success){
        if(prev.previewUrl)URL.revokeObjectURL(prev.previewUrl);
        return {...current,[targetDraftKey]:null};
      }
      const cause=result.error;
      const messageClientId=cause instanceof NimImageSendError?cause.messageClientId:undefined;
      // Retry refusal cannot resolve the original UNKNOWN; only our rejected pre-send authorization proves cancellation.
      const isUnknown=flight.unknown||flight.client!==sendingClientRef.current||(cause instanceof NimImageSendError&&cause.kind==="UNKNOWN")
        ||(superseded(cause)&&!result.cancelledBeforeDispatch);
      return {
        ...current,
        [targetDraftKey]:{
          ...prev,
          state:isUnknown?"UNKNOWN":"FAILED",
          messageClientId:flight.unknown?attempt.messageClientId:messageClientId??prev.messageClientId,
        },
      };
    });
  },[]);
  const setMediaFor=useCallback((targetDraftKey:string,next:((current:MessageMediaDraft|null)=>MessageMediaDraft|null)|MessageMediaDraft|null)=>{
    const previous=mediaByOrderRef.current[targetDraftKey]??null;
    const resolved=typeof next==="function"?next(previous):next;
    mediaByOrderRef.current={...mediaByOrderRef.current,[targetDraftKey]:resolved};setMediaByOrder(mediaByOrderRef.current);
  },[]);
  const stageMedia=useCallback((targetDraftKey:string,file:File,kind:"video"|"file"):string|null=>{
    try{validateNimMediaFile(file,kind);}catch(cause){return cause instanceof Error?cause.message:"媒体文件无效";}
    const current=mediaByOrderRef.current[targetDraftKey]??null;
    if(current?.state==="SENDING")return "媒体正在发送，请稍候";
    if(current?.state==="UNKNOWN")return "上次媒体发送结果未确认，请先按原消息重试";
    setMediaFor(targetDraftKey,{file,kind,name:file.name,size:file.size,state:"READY",progress:0});
    return null;
  },[]);
  const removeMedia=useCallback((targetDraftKey:string):string|null=>{
    const current=mediaByOrderRef.current[targetDraftKey]??null;
    if(!current)return null;
    if(current.state==="SENDING"||mediaAttempts.current.has(targetDraftKey))return "媒体正在发送，暂不能移除";
    if(current.state==="UNKNOWN")return "媒体发送结果未确认，暂不能移除；请先核对历史";
    setMediaFor(targetDraftKey,null);
    return null;
  },[]);
  const beginPendingMedia=useCallback((targetDraftKey:string,media:MessageMediaDraft):MessageMediaDraft|null=>{
    if(mediaAttempts.current.has(targetDraftKey)||imageAttempts.current.has(targetDraftKey)||textAttempts.current.has(targetDraftKey))return null;
    if(!sendingClientRef.current)return null;
    try{if(JSON.parse(targetDraftKey)[0]!==identityRef.current)return null;}catch{return null;}
    const attempt:MessageMediaDraft={...media,state:"SENDING",progress:0};
    mediaAttempts.current.set(targetDraftKey,{draft:attempt,unknown:media.state==="UNKNOWN",client:sendingClientRef.current});
    setMediaFor(targetDraftKey,attempt);
    return attempt;
  },[]);
  const settlePendingMedia=useCallback((targetDraftKey:string,attempt:MessageMediaDraft,result:{success:boolean;error?:unknown;cancelledBeforeDispatch?:boolean})=>{
    const flight=mediaAttempts.current.get(targetDraftKey);
    if(flight?.draft!==attempt)return;
    mediaAttempts.current.delete(targetDraftKey);
    try{if(JSON.parse(targetDraftKey)[0]!==identityRef.current)return;}catch{return;}
    setMediaByOrder(current=>{
      const prev=current[targetDraftKey];
      if(!prev||prev.file!==attempt.file)return current;
      if(result.success)return {...current,[targetDraftKey]:null};
      const cause=result.error,mediaError=cause instanceof NimMediaSendError?cause:null;
      const isUnknown=flight.unknown||flight.client!==sendingClientRef.current||mediaError?.kind==="UNKNOWN"
        ||(superseded(cause)&&!result.cancelledBeforeDispatch);
      return {
        ...current,
        [targetDraftKey]:{
          ...prev,
          state:isUnknown?"UNKNOWN":"FAILED",
          progress:0,
          messageClientId:flight.unknown?attempt.messageClientId:mediaError?.messageClientId??prev.messageClientId,
        },
      };
    });
  },[]);
  useEffect(()=>{
    pendingTextByOrderRef.current={};setPendingTextByOrder({});
    mediaByOrderRef.current={};setMediaByOrder({});
    return ()=>{
      textAttempts.current.clear();
      imageAttempts.current.clear();
      mediaAttempts.current.clear();
      Object.values(stagedByOrderRef.current).flat().forEach(d=>{if(d.previewUrl)URL.revokeObjectURL(d.previewUrl);});
      Object.values(pendingByOrderRef.current).forEach(d=>{if(d?.previewUrl)URL.revokeObjectURL(d.previewUrl);});
    };
  },[identity]);
  const requestRef=useRef(request),authErrorRef=useRef(onAuthError);requestRef.current=request;authErrorRef.current=onAuthError;
  const orderTrigger=useRef<HTMLButtonElement|null>(null);
  const context=useRef(""),accessSequence=useRef(0),listSequence=useRef(0),loadedPages=useRef(1),nextCursor=useRef<string|null>(null),refreshCycle=useRef<ListRefresh|null>(null),moreRequested=useRef(false),mounted=useRef(true),listFlight=useRef<{scope:string;ticket:number;cursor?:string;promise:Promise<void>}|null>(null);
  const accessFlight=useRef<{key:string;ticket:number;operation:"read"|"send";promise:Promise<OrderTeamAccess>}|null>(null);
  const contextKey=JSON.stringify([identity,realm,party,selected,active]);
  const listScope=JSON.stringify([identity,realm,party]);
  const listScopeRef=useRef(listScope),itemsScope=useRef(listScope);
  const activeRef=useRef(active);activeRef.current=active;
  if(context.current!==contextKey){context.current=contextKey;accessSequence.current++;}
  if(listScopeRef.current!==listScope){listScopeRef.current=listScope;listSequence.current++;loadedPages.current=1;nextCursor.current=null;refreshCycle.current=null;moreRequested.current=false;}
  const listWasActive=useRef(active);
  if(listWasActive.current!==active){listWasActive.current=active;listSequence.current++;refreshCycle.current=null;moreRequested.current=false;}
  const prefix=realm==="admin"?"/orders":"/api/orders";
  const draftKey=info?JSON.stringify([identity,info.appId,info.orderId,info.teamId]):"";
  useEffect(()=>{setParty(initialParty);},[initialParty]);
  const report=(cause:unknown,operation:"list"|"read"|"send",key:string)=>{
    if(context.current!==key||superseded(cause))return;
    const status=statusOf(cause);
    if(status===401||status===423){
      setInfo(null);itemsScope.current=listScopeRef.current;setItems([]);loadedPages.current=1;nextCursor.current=null;refreshCycle.current=null;moreRequested.current=false;setRefreshingPages(false);setNext(null);setDrafts({});
      setStagedByOrder(current=>{Object.values(current).flat().forEach(d=>{if(d.previewUrl)URL.revokeObjectURL(d.previewUrl);});return {};});
      setPendingByOrder(current=>{Object.values(current).forEach(d=>{if(d?.previewUrl)URL.revokeObjectURL(d.previewUrl);});return {};});
      mediaAttempts.current.clear();mediaByOrderRef.current={};setMediaByOrder({});
      textAttempts.current.clear();pendingTextByOrderRef.current={};setPendingTextByOrder({});
      setUnauthorized(true);
      setError(status===423?"请先解锁管理会话":"登录已失效，请重新确认身份");authErrorRef.current(status);return;
    }
    if(status===403||status===404){
      if(operation==="list"){setInfo(null);itemsScope.current=listScopeRef.current;setItems([]);loadedPages.current=1;nextCursor.current=null;refreshCycle.current=null;moreRequested.current=false;setRefreshingPages(false);setNext(null);}
      else if(operation==="read"){
        const revoked=selected;setInfo(null);
        if(revoked)setItems(current=>current.filter(item=>item.id!==revoked));
        setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([key])=>JSON.parse(key)[2]!==selected)));
        // Keep only the original retry responsibility; revoked private text must not return on a late receipt.
        pendingTextByOrderRef.current=Object.fromEntries(Object.entries(pendingTextByOrderRef.current).map(([key,value])=>[key,JSON.parse(key)[2]===revoked&&value?{...value,text:""}:value]));setPendingTextByOrder(pendingTextByOrderRef.current);
        setStagedByOrder(current=>{
          const next={...current};
          for(const [k,list] of Object.entries(next)){
            try{if(JSON.parse(k)[2]===revoked){list.forEach(d=>{if(d.previewUrl)URL.revokeObjectURL(d.previewUrl);});delete next[k];}}catch{}
          }
          return next;
        });
        setPendingByOrder(current=>{
          const next={...current};
          for(const [k,d] of Object.entries(next)){
            try{if(JSON.parse(k)[2]===revoked){
              // info is hidden after denial; retain only pending delivery responsibility for the same identity.
              if(d&&(imageAttempts.current.has(k)||d.state==="UNKNOWN"))continue;
              if(d?.previewUrl)URL.revokeObjectURL(d.previewUrl);delete next[k];
            }}catch{}
          }
          return next;
        });
        setMediaByOrder(current=>{
          const next={...current};
          for(const [k,d] of Object.entries(next)){
            try{if(JSON.parse(k)[2]===revoked){
              // Keep an unconfirmed delivery responsibility; a read denial hides the rest.
              if(d&&(mediaAttempts.current.has(k)||d.state==="UNKNOWN"))continue;
              delete next[k];
            }}catch{}
          }
          mediaByOrderRef.current=next;
          return next;
        });
      }
      else setInfo(current=>current?{...current,canSend:false}:current);
      setUnauthorized(true);
      setError(operation==="send"?"当前不可发送，已保留可读历史和草稿":"当前订单不可访问，请重新确认授权");return;
    }
    setError("暂时无法连接服务，请检查网络后重试");
  };
  const readAccess=(operation:"read"|"send"):Promise<OrderTeamAccess>=>{
    const key=context.current,id=selected,flight=accessFlight.current;
    if(!id||!active)return Promise.reject(new ImLifecycleSupersededError());
    if(flight&&flight.key===key&&flight.operation===operation&&flight.ticket===accessSequence.current)return flight.promise;
    const ticket=++accessSequence.current;
    const promise=(async()=>{try{
        const value=await requestRef.current<OrderTeamAccess>(`${prefix}/${encodeURIComponent(id)}/im?operation=${operation}`);
        if(context.current!==key||ticket!==accessSequence.current)throw new ImLifecycleSupersededError();
        if(value.orderId!==id)throw rejected();
        setInfo(value);setItems(current=>current.map(item=>item.id===id?{...item,status:value.orderStatus,teamState:value.teamState,firstResponseAt:value.supportEscalation.firstResponseAt,remindDueAt:value.supportEscalation.remindDueAt,addRound:value.supportEscalation.addRound,escalationState:value.supportEscalation.state,fulfillmentAssignment:item.fulfillmentAssignment?{...item.fulfillmentAssignment,state:value.assignmentState??item.fulfillmentAssignment.state,teamState:value.teamState}:item.fulfillmentAssignment}:item));setError("");setUnauthorized(false);return value;
      }catch(cause){if(ticket===accessSequence.current)report(cause,operation,key);throw cause;}})();
    accessFlight.current={key,ticket,operation,promise};
    const clear=()=>{if(accessFlight.current?.promise===promise)accessFlight.current=null;};void promise.then(clear,clear);
    return promise;
  };
  const accessRef=useRef(readAccess);accessRef.current=readAccess;
  const loadList=(cursor?:string):Promise<void>=>{
    if(!mounted.current)return Promise.resolve();
    const scope=listScope,flight=listFlight.current;
    if(flight){
      if(flight.scope===scope&&flight.ticket===listSequence.current&&cursor===undefined&&flight.cursor===undefined)return flight.promise;
      if(cursor!==undefined){if(flight.scope===scope)moreRequested.current=true;return flight.promise;}
      return flight.promise.then(()=>mounted.current&&activeRef.current?listRef.current():undefined);
    }
    if(!active)return Promise.resolve();
    if(cursor!==undefined&&refreshCycle.current?.scope===scope){moreRequested.current=true;return Promise.resolve();}
    const ticket=++listSequence.current,reportContext=context.current,isRefresh=cursor===undefined;
    if(isRefresh&&(!refreshCycle.current||refreshCycle.current.scope!==scope))refreshCycle.current={scope,targetPages:Math.max(1,loadedPages.current),pagesRead:0,cursor:undefined,items:[]};
    setLoading(true);
    const promise=(async()=>{
      try{
        if(isRefresh){
          const cycle=refreshCycle.current!;let requests=0;
          while(requests<REFRESH_PAGE_BUDGET&&cycle.pagesRead<cycle.targetPages&&cycle.cursor!==null){
            const pageCursor=cycle.pagesRead===0?undefined:cycle.cursor;
            const value=await requestRef.current<OrderPage>(`${prefix}/${realm==="admin"?"im-groups":""}?${realm==="user"?`party=${party}&`:""}limit=20${pageCursor?`&cursor=${encodeURIComponent(pageCursor)}`:""}`);
            if(listScopeRef.current!==scope||ticket!==listSequence.current||!activeRef.current)return;
            const seen=new Set(cycle.items.map(item=>item.id));for(const item of value.items)if(!seen.has(item.id)){seen.add(item.id);cycle.items.push(item);}
            cycle.pagesRead++;cycle.cursor=value.nextCursor;requests++;
          }
          if(cycle.cursor===null||cycle.pagesRead>=cycle.targetPages){
            const fresh=cycle.items,nextPage=cycle.cursor??null;itemsScope.current=scope;setItems(fresh);loadedPages.current=Math.max(1,cycle.pagesRead);nextCursor.current=nextPage;setNext(nextPage);
            refreshCycle.current=null;setRefreshingPages(false);setError("");setUnauthorized(false);
            if(!nextPage)moreRequested.current=false;
          }else{setRefreshingPages(true);setError("");}
        }else{
          const value=await requestRef.current<OrderPage>(`${prefix}/${realm==="admin"?"im-groups":""}?${realm==="user"?`party=${party}&`:""}limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
          if(listScopeRef.current!==scope||ticket!==listSequence.current||!activeRef.current)return;
          itemsScope.current=scope;setItems(current=>{const seen=new Set(current.map(item=>item.id));return [...current,...value.items.filter(row=>{if(seen.has(row.id))return false;seen.add(row.id);return true;})];});
          loadedPages.current=Math.max(loadedPages.current,1)+1;nextCursor.current=value.nextCursor;setNext(value.nextCursor);setError("");setUnauthorized(false);
        }
      }catch(cause){
        if(ticket===listSequence.current&&listScopeRef.current===scope){if(isRefresh){refreshCycle.current=null;setRefreshingPages(false);}moreRequested.current=false;report(cause,"list",reportContext);}
      }finally{if(ticket===listSequence.current)setLoading(false);}
    })();
    listFlight.current={scope,ticket,cursor,promise};
    const clear=()=>{if(listFlight.current?.promise===promise){listFlight.current=null;if(!refreshCycle.current){const queued=moreRequested.current;moreRequested.current=false;if(queued&&nextCursor.current&&activeRef.current&&mounted.current)void listRef.current(nextCursor.current);}}};void promise.then(clear,clear);
    return promise;
  };
  const listRef=useRef(loadList);listRef.current=loadList;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;listSequence.current++;refreshCycle.current=null;moreRequested.current=false;};},[]);
  useEffect(()=>{
    if(!active||!polling){setLoading(false);setRefreshingPages(false);listSequence.current++;refreshCycle.current=null;return;}
    let cancelled=false,pending=false;
    const refresh=async()=>{
      if(cancelled||pending||(typeof document!=="undefined"&&document.visibilityState==="hidden"))return;
      pending=true;
      try{if(!compact)await listRef.current();if(!cancelled&&selected)await accessRef.current("read").catch(()=>undefined);}
      finally{pending=false;}
    };
    void refresh();const timer=setInterval(()=>{void refresh();},5000);
    return()=>{cancelled=true;clearInterval(timer);accessSequence.current++;};
  },[identity,party,selected,active,revision,compact,polling]);
  useEffect(()=>{if(selectedOrderId){accessSequence.current++;setInfo(null);setSelected(selectedOrderId);setError("");onSelectedOrderChange?.(selectedOrderId);}},[selectedOrderId]);
  const choose=(id:string|null)=>{accessSequence.current++;setInfo(null);setSelected(id);setError("");onSelectedOrderChange?.(id);};
  const visibleItems=itemsScope.current===listScope?items:[],visibleNext=itemsScope.current===listScope?next:null;
  const orderHeader=info&&!renderConversation?<header className="order-team-head">
    <div className="order-team-head-row"><h3>订单 {info.displayNo}</h3><span className="order-team-head-chip">{stageOf(info)==="CANCELLED"&&info.cancelReason==="PRESTART_TERMINATED"?"未开租终止":stageOf(info)==="CANCELLED"&&info.cancelReason==="MANUAL_CLOSE"?"客服手动结束":fulfillmentStageLabel(stageOf(info))}</span><a className="order-team-head-link" href={orderDetailPath(info,party)}>订单详情</a></div>
    <p className="order-team-head-sub">{info.gameName} · {info.account.title?.trim()||"账号"}</p>
    <p className="order-team-head-members">{info.members.map(member=>`${role(member)} ${member.name?.trim()||"未署名"}`).join(" · ")}</p>
  </header>:null;
  const orderEscalation=info?(compact?<details className="support-order-summary"><summary>{orderTeamLabel(info)} · 查看订单摘要</summary><p>{info.gameName} · {info.account.title?.trim()||"账号"}</p><a href={orderDetailPath(info,party)}>前往订单核对</a><OrderTeamEscalation value={info.supportEscalation}/></details>:<OrderTeamEscalation value={info.supportEscalation}/>):null;
  const orderFulfillment=info&&realm==="admin"&&renderFulfillment?<div className="order-team-fulfillment-slot">{renderFulfillment({orderId:info.orderId,displayNo:info.displayNo,teamState:info.teamState,canSend:info.canSend,...(info.frozenInventory?{frozenInventory:info.frozenInventory}:{})})}</div>:null;
  const orderMembers=info?<ul className="order-team-members" aria-label="群成员">{info.members.map(m=><li key={m.accountId}><ProfileImage src={m.avatar} fallback={<span aria-hidden="true">{Array.from(m.name?.trim()||role(m))[0]||"用"}</span>} width={28} height={28}/><span>{m.name?.trim()||role(m)}<small>{role(m)}</small>{realm==="admin"&&m.party!=="STAFF"?<small>用户编号 {m.platformId} · 会员：未知 · 实名：未知</small>:null}</span></li>)}</ul>:null;
  const orderAsideNodes=info?<>{realm==="admin"?orderEscalation:null}{orderFulfillment}{orderMembers}</>:null;
  const orderAside=info?(renderAside?renderAside({info,fulfillment:orderFulfillment,escalation:orderEscalation,members:orderMembers}):<aside className="order-team-aside">{orderAsideNodes}</aside>):null;
  const confirmOpeningWithRefresh=onConfirmOpening?async(target:OrderTeamAccess)=>{
    await onConfirmOpening(target);
    // Server truth, not a local ack: a failed refresh keeps the polling cycle in charge.
    await accessRef.current("read").catch(()=>undefined);
  }:undefined;
  const orderConversation=info&&client&&active?<>
    <OrderConversation key={JSON.stringify([identity,info.appId,info.orderId,info.teamId])} client={client} info={{...info,canSend:info.canSend&&sendAllowed}} connection={connection} active={active} visible={visible} orderDetailHref={realm==="user"?orderDetailPath(info,party):undefined}
    extraMenuItems={extraMenuItems} onExtraMenuAction={onExtraMenuAction}
    onConfirmOpening={confirmOpeningWithRefresh} onRequestAfterSales={onRequestAfterSales}
    readAccess={operation=>accessRef.current(operation)} draftKey={draftKey} draft={drafts[draftKey]??""} setDraft={value=>setDrafts(current=>({...current,[draftKey]:value}))}
    pendingText={pendingTextByOrder[draftKey]??null} getPendingText={()=>pendingTextByOrderRef.current[draftKey]??null} isTextSending={()=>textAttempts.current.has(draftKey)} beginPendingText={beginPendingText} settlePendingText={settlePendingText}
    stagedImages={stagedByOrder[draftKey]??[]} setStagedImages={updater=>setStagedByOrder(current=>{
      const prev=current[draftKey]??[];
      const next=typeof updater==="function"?updater(prev):updater;
      return {...current,[draftKey]:next};
    })}
    pendingImage={pendingByOrder[draftKey]??null} setPendingImage={updater=>setPendingByOrder(current=>{
      const prev=current[draftKey]??null;
      const next=typeof updater==="function"?updater(prev):updater;
      return {...current,[draftKey]:next};
    })}
    isImageSending={()=>imageAttempts.current.has(draftKey)} beginPendingImage={beginPendingImage} settlePendingImage={settlePendingImage}
    mediaDraft={mediaByOrder[draftKey]??null} isMediaSending={()=>mediaAttempts.current.has(draftKey)}
    stageMedia={stageMedia} removeMedia={removeMedia} beginPendingMedia={beginPendingMedia} settlePendingMedia={settlePendingMedia}
    setMediaFor={setMediaFor} render={renderConversation}/></>:<p role="status">聊天连接正在准备中，订单与付款状态不受影响。</p>;
  return <section className="order-team-panel" data-compact={compact} hidden={!active} aria-label={realm==="admin"?"我参与的订单群":"我的订单群"} onContextMenu={onBlankContextMenu}>
    <header className="order-team-toolbar"><strong>{realm==="admin"?"我参与的订单群":"我的订单群"}</strong>{realm==="user"?<div className="order-team-role-switch" role="group" aria-label="订单身份"><button type="button" aria-pressed={party==="renter"} onClick={()=>{if(party==="renter")return;choose(null);setItems([]);setParty("renter");}}>租入</button><button type="button" aria-pressed={party==="owner"} onClick={()=>{if(party==="owner")return;choose(null);setItems([]);setParty("owner");}}>出租</button></div>:null}{/* 正常时这只是重新读取，不是让用户"重新授权"；只有真的 401/403/423 才换成授权语义。 */}<button type="button" data-action="refresh-order-panel" onClick={()=>setRevision(n=>n+1)}>{unauthorized?"重新确认授权":"刷新"}</button></header>
    {/* 已经选中某个订单（含从订单页直接跳进来）时，列表区不可用时不能把原因藏起来：
        空态整区只在"什么也没得看"时接管，其余情况下错误仍要照常出现在上方。 */}
    {error&&(Boolean(selected)||visibleItems.length>0)?<p role="alert">{error}</p>:null}
    {/* 零条订单只留一个整区空态，不再同时出现"暂无订单"和"请选择订单"两半；读取错误、
        失权、正常空列表分别表达。非失权的读取错误不摆"重新授权"，靠面板轮询自恢复。
        直接从订单跳进来的会话（compact/selectedOrderId）不属于"空列表"，仍照常显示。 */}
    {!selected&&!loading&&!visibleItems.length?<div className="order-team-empty" role={unauthorized||error?"alert":"status"}>
      <strong>{unauthorized?"暂时无法访问订单群":error?"订单列表读取失败":"暂无可访问的订单"}</strong>
      <span>{unauthorized?error||"当前账号没有可访问的订单群权限。":error?error:"付款确认并分配客服后，本单的群会话会出现在这里。"}</span>
      {!unauthorized&&error?<button type="button" onClick={()=>void loadList()}>重新读取</button>:null}
    </div>:<div className="order-team-grid" data-detail={Boolean(selected)} data-list={visibleItems.length?"full":"empty"} {...(gridPane?{"data-pane":gridPane}:{})} {...(gridDetailsOpen===undefined?{}:{"data-details":String(gridDetailsOpen)})}>
      {renderList?renderList({items:visibleItems,selectedId:selected,onSelect:choose,loading,refreshing:refreshingPages,nextCursor:visibleNext,onLoadMore:()=>{if(visibleNext)void loadList(visibleNext);}}):<nav className="order-team-list" aria-label="订单列表" aria-busy={loading||refreshingPages}>
        {loading?<p>正在读取订单…</p>:null}
        {visibleItems.map(item=><button type="button" key={item.id} aria-current={selected===item.id?"page":undefined} onClick={event=>{orderTrigger.current=event.currentTarget;choose(item.id);}}><small>{item.title?.trim()||"订单群"}</small><strong>{item.displayNo}</strong><span>{orderTeamLabel(item)}</span>{realm==="admin"?<AdminEscalationSummary item={item}/>:null}</button>)}
        {visibleNext?<button type="button" disabled={loading||refreshingPages} onClick={()=>void loadList(visibleNext)}>更多订单</button>:null}
      </nav>}
      <div className="order-team-detail">
        {selected&&!renderList?<button type="button" className="order-team-back" onClick={()=>{choose(null);requestAnimationFrame(()=>orderTrigger.current?.focus());}}>返回订单列表</button>:null}
        {!selected?<p>选择订单查看群状态和沟通记录。</p>:!info?<p role="status">{error?"订单信息未获确认":"正在核对订单授权…"}</p>:<>
          {info.canRead&&info.teamState==="READY"?layout==="aside"?<>
            <div className="order-team-conversation">{orderHeader}<FulfillmentStageBar info={info} transport={client?.transport} connection={String(connection)}/>{orderConversation}</div>
            {orderAside}
          </>:<>{orderHeader}<FulfillmentStageBar info={info} transport={client?.transport} connection={String(connection)}/>{realm==="admin"?orderAsideNodes:<div className="order-team-user-members" role="group" aria-label="群成员"><span className="order-team-members-label">群成员：</span><span className="order-team-members-text">{info.members.map(m=>`${role(m)} ${m.name?.trim()||"未署名"}`).join(" · ")}</span></div>}{orderConversation}</>:<>{orderHeader}<FulfillmentStageBar info={info} transport={client?.transport} connection={String(connection)}/>{realm==="admin"?orderAsideNodes:null}<div className="order-team-notready" role="status"><strong>订单群还在准备中</strong><span>页面会自动更新状态；打开页面不会触发付款或重复建群。</span></div></>}
        </>}
      </div>
    </div>}
  </section>;
}

function OrderConversation({
  client,
  info: rawInfo,
  connection,
  active,
  visible,
  orderDetailHref,
  readAccess,
  draftKey,
  draft,
  setDraft,
  stagedImages,
  setStagedImages,
  pendingImage,
  setPendingImage,
  isImageSending,
  beginPendingImage,
  settlePendingImage,
  mediaDraft,
  isMediaSending,
  stageMedia,
  removeMedia,
  beginPendingMedia,
  settlePendingMedia,
  setMediaFor,
  pendingText,
  getPendingText,
  isTextSending,
  beginPendingText,
  settlePendingText,
  render,
  extraMenuItems,
  onExtraMenuAction,
  onConfirmOpening,
  onRequestAfterSales,
}:{
  client:NimWebClientLike;
  info:OrderTeamAccess;
  connection:Props["connection"];
  active:boolean;
  visible:boolean;
  orderDetailHref?:string;
  readAccess:(operation:"read"|"send")=>Promise<OrderTeamAccess>;
  draftKey:string;
  draft:string;
  setDraft:(value:string)=>void;
  stagedImages:ImageDraft[];
  setStagedImages:(updater:ImageDraft[]|((current:ImageDraft[])=>ImageDraft[]))=>void;
  pendingImage:ImageDraft|null;
  setPendingImage:(updater:(ImageDraft|null)|((current:ImageDraft|null)=>(ImageDraft|null)))=>void;
  isImageSending:()=>boolean;
  beginPendingImage:(targetDraftKey:string,image:ImageDraft)=>ImageDraft|null;
  settlePendingImage:(targetDraftKey:string,attempt:ImageDraft,result:{success:boolean;error?:unknown;cancelledBeforeDispatch?:boolean})=>void;
  mediaDraft:MessageMediaDraft|null;
  isMediaSending:()=>boolean;
  stageMedia:(targetDraftKey:string,file:File,kind:"video"|"file")=>string|null;
  removeMedia:(targetDraftKey:string)=>string|null;
  beginPendingMedia:(targetDraftKey:string,media:MessageMediaDraft)=>MessageMediaDraft|null;
  settlePendingMedia:(targetDraftKey:string,attempt:MessageMediaDraft,result:{success:boolean;error?:unknown;cancelledBeforeDispatch?:boolean})=>void;
  setMediaFor:(targetDraftKey:string,next:((current:MessageMediaDraft|null)=>MessageMediaDraft|null)|MessageMediaDraft|null)=>void;
  pendingText:TextDraft|null;
  getPendingText:()=>TextDraft|null;
  isTextSending:()=>boolean;
  beginPendingText:(targetDraftKey:string,text:string,messageClientId?:string)=>TextDraft|null;
  settlePendingText:(targetDraftKey:string,attempt:TextDraft,result:{success:boolean;error?:unknown})=>void;
  render?:(view:OrderTeamConversationView)=>ReactNode;
  extraMenuItems?:MessageActionItem[];
  onExtraMenuAction?:(id:MessageActionId)=>void;
  onConfirmOpening?:(info:OrderTeamAccess)=>Promise<void>;
  onRequestAfterSales?:(info:OrderTeamAccess)=>void;
}){
  type Message=NimMessageLike&{id:string};
  const [readReady,setReadReady]=useState(false);
  const info={...rawInfo,canSend:rawInfo.canSend&&readReady};
  const [messages,setMessages]=useState<Message[]>([]),[error,setError]=useState(""),[localSending,setSending]=useState(false),[reading,setReading]=useState(false),[more,setMore]=useState(true),[viewer,setViewer]=useState<{url:string;name:string}|null>(null),[historyFailed,setHistoryFailed]=useState(false);
  const [replyTo,setReplyTo]=useState<Message|null>(null),[replyUncertain,setReplyUncertain]=useState(false);
  const [emojiOpen,setEmojiOpen]=useState(false);
  const messageListRef=useRef<HTMLOListElement|null>(null);
  const [menu,setMenu]=useState<{id:string;x:number;y:number;row:HTMLElement|null}|null>(null);
  const composerRef=useRef<HTMLTextAreaElement|null>(null);
  const imageInput=useRef<HTMLInputElement|null>(null);
  const videoInput=useRef<HTMLInputElement|null>(null);
  const mediaFileInput=useRef<HTMLInputElement|null>(null);
  const sending=localSending||isTextSending(),textRetry=pendingText&&pendingText.state!=="SENDING"?pendingText:null;
  const submittingRef=useRef(false),canStartSendRef=useRef(false);canStartSendRef.current=info.canSend&&connection==="CONNECTED"&&active&&visible;
  const generation=useRef(0),clientRef=useRef(client),accessRef=useRef(readAccess),sendOwner=useRef(0),readOwner=useRef(0),viewerTrigger=useRef<HTMLElement|null>(null);
  const stagedImagesRef=useRef(stagedImages);stagedImagesRef.current=stagedImages;
  const pendingImageRef=useRef(pendingImage);pendingImageRef.current=pendingImage;
  const mediaDraftRef=useRef(mediaDraft);mediaDraftRef.current=mediaDraft;
  const activeRef=useRef(active);activeRef.current=active;
  const visibleRef=useRef(visible);visibleRef.current=visible;
  accessRef.current=readAccess;
  if(clientRef.current!==client){clientRef.current=client;generation.current++;}
  const scope=JSON.stringify([info.appId,info.orderId,info.teamId,info.conversationId,info.viewerAccountId]);
  const scopeRef=useRef(scope);scopeRef.current=scope;
  // A quote whose target was deleted or revoked must stop claiming to be replyable.
  useEffect(()=>{if(!replyTo)return;const current=messages.find(message=>message.id===replyTo.id);if(!current||current.revoked){setReplyTo(null);setReplyUncertain(false);}},[messages,replyTo]);
  const stageFiles=(files:File[])=>{
    if(!files.length)return;
    const currentTotal=stagedImages.length+(pendingImage?1:0);
    const available=6-currentTotal;
    if(available<=0){setError("每个订单最多暂存 6 张图片");return;}
    const toAdd:ImageDraft[]=[];const errors:string[]=[];
    for(const file of files){
      if(toAdd.length>=available){errors.push("最多暂存 6 张图片，超出部分已忽略");break;}
      try{validateNimImageFile(file);}catch(cause){errors.push(`${file.name}: ${cause instanceof Error?cause.message:"图片无效"}`);continue;}
      const previewUrl=URL.createObjectURL(file);
      toAdd.push({file,previewUrl,name:file.name,size:file.size,width:0,height:0,state:"DECODING",progress:0});
    }
    if(errors.length)setError(errors.join("；"));
    if(!toAdd.length)return;
    setStagedImages(current=>[...current,...toAdd]);
    for(const item of toAdd){
      void decodeImage(item.previewUrl).then(({width,height})=>{
        setStagedImages(current=>current.map(it=>it.previewUrl===item.previewUrl?{...it,width,height,state:"READY"}:it));
      }).catch(()=>{
        setStagedImages(current=>{
          const exists=current.some(it=>it.previewUrl===item.previewUrl);
          if(!exists)return current;
          URL.revokeObjectURL(item.previewUrl);
          return current.filter(it=>it.previewUrl!==item.previewUrl);
        });
        setError(`${item.name}: 图片无法解码，请选择有效的 JPG 或 PNG`);
      });
    }
  };
  const chooseImage=(event:ChangeEvent<HTMLInputElement>)=>{
    const files=event.target.files?Array.from(event.target.files):[];event.target.value="";stageFiles(files);
  };
  const removeStagedImage=(previewUrl:string)=>{
    setStagedImages(current=>{
      const target=current.find(it=>it.previewUrl===previewUrl);
      if(target?.previewUrl)URL.revokeObjectURL(target.previewUrl);
      return current.filter(it=>it.previewUrl!==previewUrl);
    });
  };
  const removePendingImage=()=>{
    if(!pendingImage)return;
    if(isImageSending()||pendingImage.state==="SENDING")return;
    if(pendingImage.state==="UNKNOWN"){setError("图片发送结果未确认，原图片已保留；不可直接移除。");return;}
    if(pendingImage.previewUrl)URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };
  const chooseMedia=(kind:"video"|"file")=>(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];event.target.value="";
    if(!file)return;
    setError(stageMedia(draftKey,file,kind)??"");
  };
  const removeMediaDraft=()=>setError(removeMedia(draftKey)??"");
  const sendOneMedia=async(media:MessageMediaDraft,version:number)=>{
    if(media.state==="UNKNOWN"&&!media.messageClientId)throw new Error("原媒体标识不可用，请先核验发送结果");
    const attempt=beginPendingMedia(draftKey,media);
    if(!attempt)throw new ImLifecycleSupersededError();
    const progress=(percentage:number)=>{
      if(version===generation.current)setMediaFor(draftKey,current=>current?.file===attempt.file?{...current,progress:percentage}:current);
    };
    let authorized=false,cancelledBeforeDispatch=false;
    const authorizeMedia:NimMessageAuthorization=async input=>{
      try{const grant=await authorize(version)(input);authorized=true;return grant;}
      catch(cause){if(!authorized&&superseded(cause))cancelledBeforeDispatch=true;throw cause;}
    };
    try{
      const sent=media.messageClientId
        ?await client.retryMedia(info.conversationId!,media.messageClientId,{authorize:authorizeMedia,onProgress:progress})
        :await client.sendMedia(info.conversationId!,media.file,media.kind,{authorize:authorizeMedia,onProgress:progress});
      settlePendingMedia(draftKey,attempt,{success:true});
      return sent;
    }catch(error){settlePendingMedia(draftKey,attempt,{success:false,error,cancelledBeforeDispatch});throw error;}
  };
  const authorize=(version:number):NimMessageAuthorization=>async({conversationId,operation})=>{
    if(operation==="send"&&!canStartSendRef.current)throw rejected();
    const fresh=await accessRef.current(operation);
    if(version!==generation.current||clientRef.current!==client||scope!==scopeRef.current)throw new ImLifecycleSupersededError();
    if(!fresh.canRead||fresh.teamState!=="READY"||fresh.appId!==info.appId||fresh.orderId!==info.orderId||fresh.teamId!==info.teamId
      ||fresh.conversationId!==conversationId||fresh.viewerAccountId!==client.accountId||(operation==="send"&&(!fresh.canSend||!canStartSendRef.current)))throw rejected();
    if(operation!=="send"||!fresh.messageRoute)return;
    const grant=fresh.messageRoute;
    if(grant.appId!==info.appId||grant.orderId!==info.orderId||grant.teamId!==info.teamId||grant.conversationId!==info.conversationId
      ||grant.conversationId!==conversationId||!/^[A-Za-z0-9._-]{1,32}$/.test(grant.routeEnvironment))throw rejected();
    return grant;
  };
  const merge=(incoming:NimMessageLike[])=>setMessages(current=>mergeImMessages(current,incoming.filter(m=>m.conversationId===info.conversationId&&typeof m.messageClientId==="string"&&Number.isFinite(m.createTime)).map(m=>({...m,id:m.messageServerId||m.messageClientId}))));
  const history=async(before?:NimMessageLike)=>{
    const version=generation.current,owner=++readOwner.current;setReading(true);
    try{const rows=await client.getMessageHistory(info.conversationId!,50,before,authorize(version));if(version!==generation.current||clientRef.current!==client)return;merge(rows);setReadReady(true);setMore(rows.length===50);setError("");setReplyUncertain(false);setHistoryFailed(false);}
    catch(cause){if(version===generation.current&&!superseded(cause)){if(!before||statusOf(cause)===403)setReadReady(false);setError(statusOf(cause)===403?"暂时无法查看本单消息，请重新加载；若仍失败请联系客服。":"历史暂未加载，请重试");if(!before)setHistoryFailed(true);}}
    finally{if(version===generation.current&&owner===readOwner.current)setReading(false);}
  };
  useEffect(()=>{
    const version=++generation.current;setReadReady(false);setMessages([]);setSending(false);setReading(false);setHistoryFailed(false);let off:(()=>void)|undefined;let delivery=Promise.resolve();
    void authorize(version)({conversationId:info.conversationId!,operation:"read"}).then(()=>{
      if(version!==generation.current)return;
      off=client.onMessages(incoming=>{if(!incoming.some(m=>m.conversationId===info.conversationId))return;delivery=delivery.then(async()=>{await authorize(version)({conversationId:info.conversationId!,operation:"read"});if(version===generation.current)merge(incoming);}).catch(()=>undefined);});
      void history();
    }).catch(cause=>{if(version===generation.current&&!superseded(cause)){setReadReady(false);setError("暂时无法查看本单消息，请重新加载；若仍失败请联系客服。");setHistoryFailed(true);}});
    return()=>{generation.current++;off?.();};
  },[client,scope]);
  const previousConnection=useRef(connection);
  useEffect(()=>{if(connection==="CONNECTED"&&previousConnection.current!=="CONNECTED")void history();previousConnection.current=connection;},[connection]);
  const sendOneImage=async(image:ImageDraft,version:number)=>{
    if(image.state==="UNKNOWN"&&!image.messageClientId)throw new Error("原图片标识不可用，请先核验发送结果");
    const attempt=beginPendingImage(draftKey,image);
    if(!attempt)throw new ImLifecycleSupersededError();
    const progress=(percentage:number)=>{
      if(version===generation.current)setPendingImage(current=>current?.previewUrl===attempt.previewUrl?{...current,progress:percentage}:current);
    };
    let authorized=false,cancelledBeforeDispatch=false;
    const authorizeImage:NimMessageAuthorization=async input=>{
      try{const grant=await authorize(version)(input);authorized=true;return grant;}
      catch(cause){if(!authorized&&superseded(cause))cancelledBeforeDispatch=true;throw cause;}
    };
    try{
      const sent=image.messageClientId
        ?await client.retryImage(info.conversationId!,image.messageClientId,{authorize:authorizeImage,onProgress:progress})
        :await client.sendImage(info.conversationId!,image.file,{authorize:authorizeImage,onProgress:progress,width:image.width,height:image.height});
      settlePendingImage(draftKey,attempt,{success:true});
      return sent;
    }catch(error){settlePendingImage(draftKey,attempt,{success:false,error,cancelledBeforeDispatch});throw error;}
  };
  const sendOneText=async(text:string,version:number,messageClientId?:string)=>{
    const attempt=beginPendingText(draftKey,text,messageClientId);
    if(!attempt)throw new ImLifecycleSupersededError();
    try{
      const sent=messageClientId?await client.retryText(info.conversationId!,messageClientId,authorize(version)):await client.sendText(info.conversationId!,text,authorize(version));
      settlePendingText(draftKey,attempt,{success:true});return sent;
    }catch(error){settlePendingText(draftKey,attempt,{success:false,error});throw error;}
  };
  const textBlocksImages=()=>{
    if(isTextSending()||getPendingText()?.state==="UNKNOWN"){
      setError("上一条文字发送结果未确认，请先核验或按原消息重试");return true;
    }
    const currentMedia=mediaDraftRef.current;
    if(currentMedia?.state==="UNKNOWN"){setError("视频/文件发送结果未确认，请先核验或按原消息重试");return true;}
    if(currentMedia?.state==="FAILED"){setError("请先重试或移除失败的视频/文件，再发送后续内容");return true;}
    return false;
  };
  const send=async(event:FormEvent)=>{
    event.preventDefault();const text=draft.trim(),currentStaged=stagedImagesRef.current,currentPending=pendingImageRef.current,currentMedia=mediaDraftRef.current;
    if((!text&&!currentStaged.length&&!currentPending&&!currentMedia)||submittingRef.current||sending||isTextSending()||isImageSending()||isMediaSending()||currentPending?.state==="SENDING"||currentMedia?.state==="SENDING"||!canStartSendRef.current)return;
    if(currentMedia?.state==="UNKNOWN"){setError("视频/文件发送结果未确认，请先刷新历史；确认未发送后再按原消息重试");return;}
    if(currentMedia?.state==="FAILED"){setError("请先重试或移除发送失败的视频/文件，再发送后续内容");return;}
    const currentText=getPendingText(),originalText=currentText&&currentText.state!=="SENDING"?currentText:null;
    if(replyTo){
      if(replyUncertain){setError(REPLY_UNCERTAIN);return;}
      if(!text){setError("回复需要先输入文字；图片回复暂不支持");return;}
      if(originalText?.state==="UNKNOWN"){setError("上一条文字发送结果未确认，请先按原消息重试");return;}
    }
    if(originalText?.state==="UNKNOWN"&&(!text||!originalText.messageClientId)){setError(originalText.messageClientId?"请先按原消息重试文字，再发送图片":"原文字标识不可用，请先核验发送结果；不可重新发送");return;}
    if(currentStaged.some(it=>it.state==="DECODING"||it.width<=0||it.height<=0)){setError("图片仍在检查，请稍候");return;}
    if(currentPending?.state==="UNKNOWN"){setError("图片发送结果未确认，请先刷新历史；确认未发送后再重试");return;}
    if(currentPending?.state==="FAILED"&&currentStaged.length>0){setError("请先处理失败的图片，再发送后续内容");return;}
    const version=generation.current,owner=++sendOwner.current;submittingRef.current=true;setSending(true);setError("");
    let activeStage:"text"|"image"|"media"|null=null;
    try{
      if(text){
        activeStage="text";
        if(replyTo){
          const sent=await client.replyText(info.conversationId!,text,replyTo,authorize(version));
          if(version!==generation.current)return;
          merge([sent]);
          setReplyTo(null);setReplyUncertain(false);
          if(draft.trim()===text)setDraft("");
        }else{
          const sent=await sendOneText(originalText?.text??text,version,originalText?.messageClientId);
          if(version!==generation.current)return;merge([sent]);
        }
      }
      if(currentPending&&currentPending.state==="FAILED"){
        activeStage="image";
        const sent=await sendOneImage(currentPending,version);
        if(version===generation.current){merge([sent]);pendingImageRef.current=null;}
      }
      activeStage="image";
      const toSendImages=[...stagedImagesRef.current];
      for(const stagedItem of toSendImages){
        if(version!==generation.current||!canStartSendRef.current||!activeRef.current||!visibleRef.current||clientRef.current!==client)break;
        stagedImagesRef.current=stagedImagesRef.current.filter(it=>it.previewUrl!==stagedItem.previewUrl);
        setStagedImages(curr=>curr.filter(it=>it.previewUrl!==stagedItem.previewUrl));
        const pendingItem:ImageDraft={...stagedItem,state:"SENDING",progress:0};
        pendingImageRef.current=pendingItem;
        const sent=await sendOneImage(stagedItem,version);
        if(version===generation.current){merge([sent]);pendingImageRef.current=null;}
      }
      const mediaToSend=mediaDraftRef.current;
      if(mediaToSend?.state==="READY"){
        activeStage="media";
        const sent=await sendOneMedia(mediaToSend,version);
        if(version===generation.current)merge([sent]);
      }
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        if(activeStage==="media"||cause instanceof NimMediaSendError){
          const mediaError=cause instanceof NimMediaSendError?cause:null;
          if(mediaError?.kind==="UNSUPPORTED")setError("当前暂不支持发送视频或文件，未发送；草稿已保留。");
          else if(mediaError?.kind==="UNKNOWN"){setError("视频/文件发送结果未确认，原文件已保留；可刷新历史或按原消息重试");void history();}
          else setError(statusOf(cause)===403?"发送权限已变化，草稿已保留":cause instanceof Error?cause.message:"视频/文件发送失败，草稿已保留，可重试");
        }else if(activeStage==="text"||cause instanceof NimTextSendError){
          const textError=cause instanceof NimTextSendError?cause:null;
          if(replyTo&&activeStage==="text"){
            // A reply has no original-id replay API: keep the text and quote, and
            // never re-dispatch under a fresh id automatically.
            if(unconfirmedReply(cause)){setReplyUncertain(true);setError(REPLY_UNCERTAIN);}
            else setError(statusOf(cause)===403?"发送权限已变化，草稿已保留":cause instanceof Error?cause.message:"回复发送失败，草稿和引用已保留");
          }else setError(statusOf(cause)===403?"发送权限已变化，草稿已保留":textError?.kind==="UNKNOWN"?"发送结果未确认，草稿已保留；可先刷新历史或原消息重试":"发送失败，草稿已保留，可重试");
        }else{
          const messageClientId=cause instanceof NimImageSendError?cause.messageClientId:undefined;
          const isUnknown=cause instanceof NimImageSendError&&cause.kind==="UNKNOWN";
          if(pendingImageRef.current){
            pendingImageRef.current={
              ...pendingImageRef.current,
              state:isUnknown?"UNKNOWN":"FAILED",
              messageClientId:messageClientId??pendingImageRef.current.messageClientId,
            };
          }
          setError(imageErrorMessage(cause));
          if(cause instanceof NimImageSendError&&cause.kind==="UNKNOWN")void history();
        }
        if(statusOf(cause)===403)void accessRef.current("read").catch(()=>undefined);
      }
    }finally{if(version===generation.current&&owner===sendOwner.current){submittingRef.current=false;setSending(false);}}
  };
  const onComposerKeyDown=(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key!=="Enter"||event.shiftKey||event.nativeEvent.isComposing)return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  const insertEmoji=(emoji:string)=>{
    setDraft(`${draft}${emoji}`);
    setEmojiOpen(false);
    requestAnimationFrame(()=>composerRef.current?.focus());
  };
  const retryText=async()=>{
    if(submittingRef.current||sending||isTextSending()||isImageSending()||isMediaSending()||pendingImageRef.current?.state==="SENDING"||!canStartSendRef.current)return;
    const original=getPendingText();
    if(!original?.messageClientId){setError("原文字标识不可用，请先核验发送结果；不可重新发送");return;}
    const version=generation.current,owner=++sendOwner.current;submittingRef.current=true;setSending(true);setError("");
    try{
      const sent=await sendOneText(original.text,version,original.messageClientId);
      if(version!==generation.current)return;merge([sent]);
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        const textError=cause instanceof NimTextSendError?cause:null;
        setError(textError?.kind==="UNKNOWN"?"发送结果仍未确认，请先刷新历史确认":"发送失败，可再次重试");
      }
    }finally{if(version===generation.current&&owner===sendOwner.current){submittingRef.current=false;setSending(false);}}
  };
  const retryMediaDraft=async()=>{
    const media=mediaDraftRef.current;
    if(!media||submittingRef.current||sending||isTextSending()||isImageSending()||isMediaSending()||media.state==="SENDING"||!canStartSendRef.current)return;
    if(media.state==="UNKNOWN"&&!media.messageClientId){setError("原媒体标识不可用，请先刷新历史核验；不可重新发送");return;}
    const version=generation.current,owner=++sendOwner.current;submittingRef.current=true;setSending(true);setError("");
    try{
      const sent=await sendOneMedia(media,version);
      if(version===generation.current)merge([sent]);
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        const mediaError=cause instanceof NimMediaSendError?cause:null;
        if(mediaError?.kind==="UNSUPPORTED")setError("当前暂不支持发送视频或文件，未发送。");
        else setError(mediaError?.kind==="UNKNOWN"?"视频/文件发送结果仍未确认，请先刷新历史":"视频/文件发送失败，可再次重试");
      }
    }finally{if(version===generation.current&&owner===sendOwner.current){submittingRef.current=false;setSending(false);}}
  };
  const retryPendingImage=async()=>{
    if(!pendingImage||submittingRef.current||sending||isTextSending()||isImageSending()||isMediaSending()||pendingImage.state==="SENDING"||!canStartSendRef.current)return;
    if(textBlocksImages())return;
    const version=generation.current,owner=++sendOwner.current;submittingRef.current=true;setSending(true);setError("");
    try{
      const sent=await sendOneImage(pendingImage,version);
      if(version===generation.current){merge([sent]);pendingImageRef.current=null;}
      const toSendImages=[...stagedImagesRef.current];
      for(const stagedItem of toSendImages){
        if(version!==generation.current||!canStartSendRef.current||!activeRef.current||!visibleRef.current||clientRef.current!==client)break;
        stagedImagesRef.current=stagedImagesRef.current.filter(it=>it.previewUrl!==stagedItem.previewUrl);
        setStagedImages(curr=>curr.filter(it=>it.previewUrl!==stagedItem.previewUrl));
        const nextPending:ImageDraft={...stagedItem,state:"SENDING",progress:0};
        pendingImageRef.current=nextPending;
        const subSent=await sendOneImage(stagedItem,version);
        if(version===generation.current){merge([subSent]);pendingImageRef.current=null;}
      }
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        const messageClientId=cause instanceof NimImageSendError?cause.messageClientId:undefined;
        const isUnknown=cause instanceof NimImageSendError&&cause.kind==="UNKNOWN";
        if(pendingImageRef.current){
          pendingImageRef.current={
            ...pendingImageRef.current,
            state:isUnknown?"UNKNOWN":"FAILED",
            messageClientId:messageClientId??pendingImageRef.current.messageClientId,
          };
        }
        setError(imageErrorMessage(cause));
        if(cause instanceof NimImageSendError&&cause.kind==="UNKNOWN")void history();
        if(statusOf(cause)===403)void accessRef.current("read").catch(()=>undefined);
      }
    }finally{if(version===generation.current&&owner===sendOwner.current){submittingRef.current=false;setSending(false);}}
  };
  const menuMessage=menu?messages.find(message=>message.id===menu.id)??null:null;
  const menuCanWrite=info.canSend&&connection==="CONNECTED";
  const menuItems:MessageActionItem[]=menuMessage&&!menuMessage.revoked&&menuMessage.messageType!==5?[
    ...(copyableText(menuMessage)?[{id:"copy" as const,label:"复制"}]:[]),
    ...(menuCanWrite?[{id:"reply" as const,label:"回复"}]:[]),
    ...(menuCanWrite&&menuMessage.senderId===client.accountId?[{id:"revoke" as const,label:"撤回"}]:[]),
    {id:"delete" as const,label:"删除",danger:true},
    ...(extraMenuItems??[]),
  ]:[];
  const openMessageMenu=(message:Message,x:number,y:number,row:HTMLElement|null)=>{
    if(message.messageType===5||message.revoked||menu?.id===message.id)return;
    setMenu({id:message.id,x,y,row});
  };
  const onMessagesContextMenu=(event:ReactMouseEvent<HTMLElement>)=>{
    const row=messageRowOf(event.target);
    event.preventDefault();
    if(!row){setMenu(null);return;}
    const message=messages.find(item=>item.id===row.dataset.messageId);
    if(message)openMessageMenu(message,event.clientX,event.clientY,row);
  };
  const longPress=useMessageLongPress((point,target)=>{
    const row=messageRowOf(target);
    if(!row)return;
    const message=messages.find(item=>item.id===row.dataset.messageId);
    if(message)openMessageMenu(message,point.x,point.y,row);
  });
  const copyMessage=async(message:Message)=>{
    const text=copyableText(message);
    try{
      if(!text||typeof navigator==="undefined"||!navigator.clipboard?.writeText)throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setError("");
    }catch{setError("复制失败，请手动选择文本");}
  };
  const revokeMessage=async(message:Message)=>{
    const version=generation.current;
    try{
      const updated=await client.revokeMessage(info.conversationId!,message,authorize(version));
      if(version!==generation.current)return;
      merge([updated]);setError("");
      if(replyTo?.id===message.id){setReplyTo(null);setReplyUncertain(false);}
    }catch(cause){
      if(version!==generation.current||superseded(cause))return;
      const status=statusOf(cause);
      setError(status===409?"已超过可撤回时间":status===403?"无权撤回此消息":"撤回失败，请重试");
    }
  };
  const removeMessage=async(message:Message)=>{
    const version=generation.current;
    try{
      await client.deleteMessage(info.conversationId!,message,authorize(version));
      if(version!==generation.current)return;
      setMessages(current=>current.filter(item=>item.id!==message.id));
      if(replyTo?.id===message.id){setReplyTo(null);setReplyUncertain(false);}
      setError("");
    }catch(cause){
      if(version!==generation.current||superseded(cause))return;
      setError(statusOf(cause)===403?"无权删除此消息":"删除失败，消息仍保留");
    }
  };
  const selectMenuAction=(action:MessageActionId)=>{
    const message=menuMessage;
    setMenu(null);
    if(extraMenuItems?.some(item=>item.id===action)){onExtraMenuAction?.(action);return;}
    if(!message)return;
    if(action==="copy"){void copyMessage(message);return;}
    if(action==="reply"){setReplyTo(message);setReplyUncertain(false);setError("");requestAnimationFrame(()=>composerRef.current?.focus());return;}
    if(action==="revoke"){void revokeMessage(message);return;}
    void removeMessage(message);
  };
  const imageInFlight=pendingImage?.state==="SENDING";
  const imageBlocked=stagedImages.some(it=>it.state==="DECODING"||it.width<=0||it.height<=0);
  const mediaInFlight=isMediaSending()||mediaDraft?.state==="SENDING";
  const sendError=error||(pendingText?.state==="UNKNOWN"?(pendingText.messageClientId?"上一条文字发送结果未确认，请先核验或按原消息重试":"原文字标识不可用，请先核验发送结果；不可重新发送"):"");
  // 放大查看始终是同一个原生 modal dialog：换呈现层不能顺带丢掉 Escape 收敛与焦点回归。
  const viewerDialog=<MediaPreview item={viewer?{...viewer,kind:"image"}:null} returnFocus={viewerTrigger.current} onClose={()=>setViewer(null)}/>;
  if(render)return <>
    {render({info,messages,connection,accountId:client.accountId,draft,setDraft,stagedImages,pendingImage,error:sendError,reading:reading||(!readReady&&!historyFailed),sending,
      hasMore:more,textRetry,viewer,openImage:(url,name,trigger)=>{viewerTrigger.current=trigger;setViewer({url,name});},closeImage:()=>setViewer(null),
      canSend:info.canSend,isImageSending:imageInFlight,imageBlocked,
      mediaDraft,isMediaSending:mediaInFlight,
      onStageMedia:(file,kind)=>setError(stageMedia(draftKey,file,kind)??""),onRemoveMedia:removeMediaDraft,onRetryMedia:()=>void retryMediaDraft(),
      onRefresh:()=>void history(),onLoadEarlier:()=>{if(messages[0])void history(messages[0]);},onSubmit:send,onStageFiles:stageFiles,
      onRemoveStaged:removeStagedImage,onRemovePending:removePendingImage,onRetryText:()=>void retryText(),onRetryPendingImage:()=>void retryPendingImage(),
      menuHandlers:{onContextMenu:onMessagesContextMenu,longPress},replyLabel:replyTo?replySummaryOf(replyTo):null,onCancelReply:()=>{setReplyTo(null);setReplyUncertain(false);},
      refreshAccess:()=>readAccess("read").then(()=>undefined)})}
    {viewerDialog}
    {menuMessage&&menu?<MessageActionMenu key={menu.id} x={menu.x} y={menu.y} items={menuItems} onSelect={selectMenuAction} onClose={()=>setMenu(null)} returnFocus={menu.row}/>:null}
  </>;
  const until=info.sendUntil?new Date(info.sendUntil).getTime():Number.NaN;
  const now=typeof info.serverNow==="string"?new Date(info.serverNow).getTime():Date.now();
  const allowed=typeof info.terminalSendAllowed==="boolean"
    ? info.terminalSendAllowed
    : (Number.isFinite(until)&&Number.isFinite(now)&&now<until);
  const readOnlyText=info.orderStatus==="COMPLETED"||info.orderStatus==="CANCELLED"
    ?(info.cancelReason==="PRESTART_TERMINATED"
      ?(allowed?"本单未开租终止，仍可在沟通窗口内发送消息":"本单未开租终止，退款已核销，仅可查看历史")
      :info.cancelReason==="MANUAL_CLOSE"
        ?(allowed?"本单客服手动结束，仍可在沟通窗口内发送消息":"本单客服手动结束，仅可查看历史")
        :(allowed?"本单已结束，仍可在沟通窗口内发送消息":"本单已结束，仅可查看历史"))
    :info.teamState!=="READY"?"订单群尚未就绪，暂不可发送":"当前不可发送";
  const jumpToMessage = (messageId: string) => {
    const target = messages.find((message) => message.id === messageId || message.messageClientId === messageId || message.messageServerId === messageId);
    if (!target) return;
    const node = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${target.id.replaceAll('"', '\\"')}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const targetNode = node.querySelector<HTMLElement>("p, .order-team-message-revoked, .order-card") ?? node;
    targetNode.classList.add("message-quote-target");
    window.setTimeout(() => targetNode.classList.remove("message-quote-target"), 1600);
  };
  return <section className="order-team-chat" aria-label="订单文字和图片沟通">
    {more&&messages.length?<div className="order-team-history"><button type="button" className="order-team-link" disabled={reading} onClick={()=>void history(messages[0])}>{reading?"正在读取…":"更早的消息"}</button></div>:null}
    {sendError?<p role="alert">{sendError}</p>:null}
    {textRetry?<div className="order-team-text-retry" role="status"><p>{textRetry.text}</p><span>发送结果待确认，请核对这条原消息</span><button type="button" disabled={sending||!textRetry.messageClientId||!info.canSend||connection!=="CONNECTED"} onClick={()=>void retryText()}>原消息重试</button></div>:null}
    <ol ref={messageListRef} className="order-team-messages" aria-label="订单消息" aria-live="polite" onContextMenu={onMessagesContextMenu} {...longPress}>{messages.map((message,index)=>{
      const member=info.members.find(m=>m.accountId===message.senderId),replyMember=message.reply?info.members.find(m=>m.accountId===message.reply!.senderId):undefined,self=message.senderId===client.accountId,revoked=message.revoked===true;
      const media=mediaMessageOf(message),card=Boolean(message.card);
      const caption=typeof message.text==="string"&&message.text.trim()?<p className="message-media-caption-text">{message.text}</p>:null;
      const grouped=Boolean(index>0&&messages[index-1]?.senderId===message.senderId&&message.createTime-messages[index-1]!.createTime<300_000);
      const bot=Boolean(!self&&info.botAccountId&&message.senderId===info.botAccountId);
      const label=self?"我":bot?"洲洲助手（Bot）":member?.name?.trim()||(member?role(member):"平台消息");
      const avatar=member?.avatar?.trim()||null;
      const content=revoked?<span className="order-team-message-revoked">消息已撤回</span>:<>{card?<OrderCardMessage message={message} info={info} onConfirmOpening={onConfirmOpening}/>:media?<><MediaMessage media={media}/>{caption}</>:message.messageType===1&&message.attachment?<><OrderMessageImage attachment={message.attachment}/>{caption}</>:<p>{(message.messageType===undefined||message.messageType===0)&&typeof message.text==="string"?message.text:"暂不支持此消息类型"}</p>}{message.reply?<MessageQuoted text={message.reply.text??"消息"} senderName={replyMember?.name?.trim()||(replyMember?role(replyMember):null)} onJump={()=>jumpToMessage(message.reply!.messageId)}/>:null}</>;
      const showDay=index===0||chatDayKey(message.createTime)!==chatDayKey(messages[index-1]!.createTime);
      return <Fragment key={message.id}>
        {showDay?<li className="order-team-day" role="separator"><span>{chatDayLabel(message.createTime)}</span></li>:null}
        <li data-message-id={message.id} tabIndex={-1} data-self={self} data-grouped={grouped} data-card={card||undefined}>
        <span className="order-team-msg-avatar" aria-hidden="true">{bot?<img src="/art/zhouzhou/avatar.webp" alt=""/>:<ProfileImage src={avatar} fallback={Array.from(label)[0]||"用"} loading="lazy"/>}</span>
        <div className="order-team-msg-body">
          <small className="order-team-msg-meta"><b>{label}</b>{member?<em className="order-team-msg-role">{role(member)}</em>:null}<time>{chatTimeLabel(new Date(message.createTime).toString())}</time></small>
          {content}
          {self&&!revoked&&!card?<small className="order-team-msg-status"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg><span>已发送</span></small>:null}
        </div>
        </li>
      </Fragment>;
    })}</ol>
    {historyFailed&&!messages.length?<div className="order-team-chat-empty" role="status"><span className="order-team-empty-mark" aria-hidden="true"/><strong>消息暂未加载</strong><span className="order-team-chat-empty-copy">历史消息读取失败，请检查网络或点击重新加载。</span><button type="button" className="order-team-link" disabled={reading} onClick={()=>void history()}>重新加载消息</button></div>:!messages.length?<OrderTeamChatEmptyState info={info} reading={reading||!readReady} orderDetailHref={orderDetailHref}/>:null}
    {pendingImage?<div className="order-team-image-draft" aria-label="待发送图片" data-state={pendingImage.state}><img src={pendingImage.previewUrl} alt={pendingImage.name}/><span>{pendingImage.name} · {formatBytes(pendingImage.size)}{pendingImage.state==="DECODING"?" · 正在检查":pendingImage.state==="SENDING"?` · 发送中 ${pendingImage.progress}%`:pendingImage.state==="UNKNOWN"?" · 结果未确认":pendingImage.state==="FAILED"?" · 发送失败":" · 待发送"}</span><button type="button" onClick={()=>void retryPendingImage()} disabled={sending||imageInFlight}>{pendingImage.messageClientId?"原消息重试":"重试"}</button><button type="button" onClick={removePendingImage} disabled={sending||imageInFlight||pendingImage.state==="UNKNOWN"}>移除</button></div>:null}
    {stagedImages.map((staged,idx)=><div key={staged.previewUrl} className="order-team-image-draft" aria-label="待发送图片" data-state={staged.state}><img src={staged.previewUrl} alt={staged.name}/><span>{stagedImages.length>1?`${idx+1}. `:""}{staged.name} · {formatBytes(staged.size)}{staged.state==="DECODING"?" · 正在检查":" · 待发送"}</span><button type="button" onClick={()=>removeStagedImage(staged.previewUrl)} disabled={sending||imageInFlight}>移除</button></div>)}
    {mediaDraft?<MediaDraftBar draft={mediaDraft} onRetry={()=>void retryMediaDraft()} onRemove={removeMediaDraft} disabled={sending}/>:null}
    {replyTo?<MessageReplyQuote label={replySummaryOf(replyTo)} onCancel={()=>{setReplyTo(null);setReplyUncertain(false);}}/>:null}
    {!info.canSend||(historyFailed&&!messages.length)?<div className="order-team-readonly" role="status"><span className="order-team-readonly-mark" aria-hidden="true"/><span>{historyFailed&&!messages.length?"消息暂未加载，暂不可发送":readOnlyText}</span>{(info.orderStatus==="COMPLETED"||info.orderStatus==="CANCELLED")&&onRequestAfterSales?<button type="button" className="order-team-readonly-action" onClick={()=>onRequestAfterSales(info)}>联系客服处理订单问题</button>:null}</div>:<form className="order-team-composer" onSubmit={send}>
      <div className="order-team-composer-box">
        <textarea ref={composerRef} aria-label="订单消息输入" rows={2} value={draft} maxLength={4000} onChange={e=>{setDraft(e.target.value);e.currentTarget.style.height="auto";e.currentTarget.style.height=Math.min(e.currentTarget.scrollHeight,120)+"px";}} onKeyDown={onComposerKeyDown} placeholder="输入消息…"/>
        <div className="order-team-composer-tools">
          <div className="order-team-emoji">
            <button type="button" className="order-team-tool" data-tip="表情" aria-label="表情" aria-expanded={emojiOpen} onClick={()=>setEmojiOpen(open=>!open)}><ComposerIcon id="emoji" /></button>
            {emojiOpen?<div className="order-team-emoji-grid" role="menu" aria-label="表情">{CHAT_EMOJIS.map(item=><button key={item.emoji} type="button" role="menuitem" className="order-team-emoji-item" aria-label={item.label} onClick={()=>insertEmoji(item.emoji)}>{item.emoji}</button>)}</div>:null}
          </div>
          <button type="button" className="order-team-tool" data-tip="发送图片" onClick={()=>imageInput.current?.click()} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight} aria-label="发送图片"><ComposerIcon id="image" /></button>
          <input ref={imageInput} type="file" multiple accept="image/jpeg,image/png" hidden onChange={chooseImage} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight}/>
          <button type="button" className="order-team-tool" data-tip="发送视频" onClick={()=>videoInput.current?.click()} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight} aria-label="发送视频"><ComposerIcon id="video" /></button>
          <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={chooseMedia("video")} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight||mediaDraft?.state==="UNKNOWN"}/>
          <button type="button" className="order-team-tool" data-tip="发送文件" onClick={()=>mediaFileInput.current?.click()} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight} aria-label="发送文件"><ComposerIcon id="file" /></button>
          <input ref={mediaFileInput} type="file" accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={chooseMedia("file")} disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight||mediaDraft?.state==="UNKNOWN"}/>
          <button type="button" className="order-team-tool" data-tip="插入本单信息" aria-label="插入本单信息" onClick={()=>{const infoText=`【本单信息】${info.account.title?.trim()||"账号"} (订单尾号: ${info.displayNo})`;setDraft(draft?`${draft}\n${infoText}`:infoText);}}><ComposerIcon id="info" /></button>
          <span className="order-team-composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
          <button type="submit" className="order-team-send" disabled={connection!=="CONNECTED"||sending||imageInFlight||mediaInFlight||imageBlocked||(!draft.trim()&&!stagedImages.length&&!pendingImage&&mediaDraft?.state!=="READY")}>{sending?"发送中…":pendingImage&&(pendingImage.state==="FAILED"||pendingImage.state==="UNKNOWN")?"重试图片":stagedImages.length>0?"发送图片":"发送"}</button>
        </div>
      </div>
    </form>}
    {viewerDialog}
    {menuMessage&&menu?<MessageActionMenu key={menu.id} x={menu.x} y={menu.y} items={menuItems} onSelect={selectMenuAction} onClose={()=>setMenu(null)} returnFocus={menu.row}/>:null}
  </section>;
}
