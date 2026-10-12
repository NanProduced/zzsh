"use client";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { ImLifecycleSupersededError } from "@zzsh/im-client/lifecycle";
import { mergeImMessages } from "@zzsh/im-client/message-state";
import { NimImageSendError, NimTextSendError, validateNimImageFile, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState, type NimMessageAuthorization } from "@zzsh/im-client/nim-web-client";

type Member={platformId:string;accountId:string;party:string;name:string|null;avatar:string|null;responsible?:boolean;membershipStatus?:string;identityStatus?:string};
export type OrderTeamMember=Member;
export type OrderTeamListItem=OrderItem;
export type OrderTeamImageDraft=ImageDraft;
export type OrderTeamConversationMessage=NimMessageLike&{id:string};
type SupportEscalation={firstResponseAt:string|null;remindDueAt:string|null;addRound:number;state:string;needsManualReview:boolean;noEligibleStaff:boolean};
type MessageRouteGrant={appId:string;orderId:string;teamId:string;conversationId:string;routeEnvironment:string};
export type OrderTeamAccess={orderId:string;displayNo:string;orderStatus:string;assignmentState:string|null;teamState:string|null;
  appId?:string;teamId?:string;name?:string;gameName:string;account:{id:string;title:string};viewerAccountId?:string;conversationId?:string;messageRoute?:MessageRouteGrant;canRead:boolean;canSend:boolean;members:Member[];supportEscalation:SupportEscalation;
  frozenInventory?:Array<{itemId:string;quantity:string;unit:string;pricingKind:string;name:string|null}>};
type OrderItem={id:string;displayNo:string;title:string;status:string;teamState?:string|null;firstResponseAt?:string|null;remindDueAt?:string|null;addRound?:number;escalationState?:string;fulfillmentAssignment?:{state:string;teamState:string|null}|null};
type OrderPage={items:OrderItem[];nextCursor:string|null};
type ListRefresh={scope:string;targetPages:number;pagesRead:number;cursor:string|null|undefined;items:OrderItem[]};
const REFRESH_PAGE_BUDGET=2;
type Requester=<T>(path:string)=>Promise<T>;
type FulfillmentSlotContext={orderId:string;displayNo:string;teamState:string|null;canSend:boolean;frozenInventory?:OrderTeamAccess["frozenInventory"]};
type Props={identity:string;realm:"user"|"admin";client:NimWebClientLike|null;connection:NimWebConnectionState|"idle"|"error";active:boolean;visible?:boolean;polling?:boolean;selectedOrderId?:string;compact?:boolean;initialParty?:"renter"|"owner";sendAllowed?:boolean;layout?:"inline"|"aside";
  request:Requester;onAuthError:(status:number)=>void;renderFulfillment?:(context:FulfillmentSlotContext)=>ReactNode;
  renderList?:(view:OrderTeamListView)=>ReactNode;renderAside?:(view:OrderTeamAsideView)=>ReactNode;renderConversation?:(view:OrderTeamConversationView)=>ReactNode;
  gridPane?:"list"|"chat"|"details";gridDetailsOpen?:boolean};
/** Presentation-only seams. Every read, authorization, draft and send decision stays in this module. */
export type OrderTeamListView={items:OrderItem[];selectedId:string|null;onSelect:(id:string|null)=>void;loading:boolean;refreshing:boolean;nextCursor:string|null;onLoadMore:()=>void};
export type OrderTeamAsideView={info:OrderTeamAccess;fulfillment:ReactNode;escalation:ReactNode;members:ReactNode};
export type OrderTeamConversationView={
  info:OrderTeamAccess;messages:OrderTeamConversationMessage[];connection:Props["connection"];accountId:string;
  draft:string;setDraft:(value:string)=>void;stagedImages:ImageDraft[];pendingImage:ImageDraft|null;
  error:string;reading:boolean;sending:boolean;hasMore:boolean;textRetry:{messageClientId?:string;text:string}|null;
  viewer:{url:string;name:string}|null;openImage:(url:string,name:string,trigger:HTMLButtonElement)=>void;closeImage:()=>void;
  canSend:boolean;isImageSending:boolean;imageBlocked:boolean;
  onRefresh:()=>void;onLoadEarlier:()=>void;onSubmit:(event:FormEvent)=>void;onStageFiles:(files:File[])=>void;
  onRemoveStaged:(previewUrl:string)=>void;onRemovePending:()=>void;onRetryText:()=>void;onRetryPendingImage:()=>void;
};
const statusOf=(e:unknown)=>(e as {status?:number}|null)?.status;
const superseded=(e:unknown)=>e instanceof ImLifecycleSupersededError;
const rejected=()=>Object.assign(new Error("当前订单未获授权"),{status:403});
export function orderTeamLabel(order:{orderStatus?:string;status?:string;assignmentState?:string|null;teamState?:string|null;fulfillmentAssignment?:OrderItem["fulfillmentAssignment"]}):string{
  const status=order.orderStatus??order.status;
  if(status==="PENDING_PAYMENT")return "未付款";
  if(status==="CANCELLED")return "已取消";
  const team=order.teamState??order.fulfillmentAssignment?.teamState;
  if(team==="NEEDS_REVIEW")return "建群待人工核查";
  if(team==="READY")return "订单群已就绪";
  return (order.assignmentState??order.fulfillmentAssignment?.state)==="ASSIGNED"?"已分配 · 正在准备订单群":"已付款 · 等待匹配客服";
}
// Read-only formatter adapted from the reviewed order Web candidate; no write flow imported.
function serverTimeLabel(value:string):string{
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(date):"时间暂不可用";
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
export const orderTeamMemberRole=(m:OrderTeamMember)=>m.party==="BUYER"?"买家":m.party==="OWNER"?"号主":m.responsible?"负责客服":"协作客服";
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
function MessageImage({attachment,onOpen}:{attachment:ImageAttachment;onOpen:(url:string,name:string,trigger:HTMLButtonElement)=>void}){
  const [failed,setFailed]=useState(false);
  const thumbnail=supportedImageUrl((attachment as {thumbUrl?:unknown}).thumbUrl)??supportedImageUrl(attachment.url);
  const full=supportedImageUrl(attachment.url)??thumbnail;
  if(!thumbnail||failed)return <span className="order-team-image-placeholder">图片暂不可预览</span>;
  return <button type="button" className="order-team-image" onClick={event=>full&&onOpen(full,typeof attachment.name==="string"?attachment.name:"订单图片",event.currentTarget)}><img src={thumbnail} alt={typeof attachment.name==="string"?attachment.name:"订单图片"} loading="lazy" onError={()=>setFailed(true)}/></button>;
}

/** Both platforms pass their existing client. This component never logs in or creates a Team. */
export function OrderTeamPanel({identity,realm,client,connection,active,visible=true,polling=true,selectedOrderId,compact=false,initialParty="renter",sendAllowed=true,layout="inline",request,onAuthError,renderFulfillment,renderList,renderAside,renderConversation,gridPane,gridDetailsOpen}:Props){
  const [party,setParty]=useState(initialParty),[items,setItems]=useState<OrderItem[]>([]),[next,setNext]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[info,setInfo]=useState<OrderTeamAccess|null>(null),[error,setError]=useState("");
  // 「重新确认授权」只在真的失权（401/403/423）时才是恢复动作；正常列表不该常驻一个
  // 语义模糊的按钮。其它失败是读取错误，靠面板自身的轮询重试，不假装是权限问题。
  const [unauthorized,setUnauthorized]=useState(false);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[refreshingPages,setRefreshingPages]=useState(false),[drafts,setDrafts]=useState<Record<string,string>>({});
  const [stagedByOrder,setStagedByOrder]=useState<Record<string,ImageDraft[]>>({});
  const [pendingByOrder,setPendingByOrder]=useState<Record<string,ImageDraft|null>>({});
  const [pendingTextByOrder,setPendingTextByOrder]=useState<Record<string,TextDraft|null>>({});
  const pendingTextByOrderRef=useRef(pendingTextByOrder);pendingTextByOrderRef.current=pendingTextByOrder;
  const stagedByOrderRef=useRef(stagedByOrder);stagedByOrderRef.current=stagedByOrder;
  const pendingByOrderRef=useRef(pendingByOrder);pendingByOrderRef.current=pendingByOrder;
  const identityRef=useRef(identity);identityRef.current=identity;
  const sendingClientRef=useRef(client);sendingClientRef.current=client;
  const textAttempts=useRef(new Map<string,{draft:TextDraft;client:NimWebClientLike;unknown:boolean}>());
  const imageAttempts=useRef(new Map<string,{draft:ImageDraft;unknown:boolean;client:NimWebClientLike|null}>());
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
  useEffect(()=>{
    pendingTextByOrderRef.current={};setPendingTextByOrder({});
    return ()=>{
      textAttempts.current.clear();
      imageAttempts.current.clear();
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
  useEffect(()=>{if(selectedOrderId){accessSequence.current++;setInfo(null);setSelected(selectedOrderId);setError("");}},[selectedOrderId]);
  const choose=(id:string|null)=>{accessSequence.current++;setInfo(null);setSelected(id);setError("");};
  const visibleItems=itemsScope.current===listScope?items:[],visibleNext=itemsScope.current===listScope?next:null;
  const orderHeader=info&&!renderConversation?<header><h3>{info.name??info.displayNo}</h3>{compact?<small>订单群 · 群内成员可见</small>:null}<p>{orderTeamLabel(info)}</p><p>{info.gameName} · {info.account.title}</p><small>{info.name===info.displayNo?"":`订单 ${info.displayNo} · `}账号 {info.account.id}</small></header>:null;
  const orderEscalation=info?(compact?<details className="support-order-summary"><summary>{orderTeamLabel(info)} · 查看订单摘要</summary><p>{info.gameName} · {info.account.title}</p><a href={`/account?view=${party==="owner"?"leased":"rentals"}&orderId=${encodeURIComponent(info.orderId)}`}>前往订单核对</a><OrderTeamEscalation value={info.supportEscalation}/></details>:<OrderTeamEscalation value={info.supportEscalation}/>):null;
  const orderFulfillment=info&&realm==="admin"&&renderFulfillment?<div className="order-team-fulfillment-slot">{renderFulfillment({orderId:info.orderId,displayNo:info.displayNo,teamState:info.teamState,canSend:info.canSend,...(info.frozenInventory?{frozenInventory:info.frozenInventory}:{})})}</div>:null;
  const orderMembers=info?<ul className="order-team-members" aria-label="群成员">{info.members.map(m=><li key={m.accountId}>{m.avatar?<img src={m.avatar} alt="" width={28} height={28} onError={e=>{e.currentTarget.hidden=true;}}/>:<span aria-hidden="true">●</span>}<span>{m.name?.trim()||role(m)}<small>{role(m)}</small>{realm==="admin"&&m.party!=="STAFF"?<small>用户编号 {m.platformId} · 会员：未知 · 实名：未知</small>:null}</span></li>)}</ul>:null;
  const orderAsideNodes=info?<>{orderEscalation}{orderFulfillment}{orderMembers}</>:null;
  const orderAside=info?(renderAside?renderAside({info,fulfillment:orderFulfillment,escalation:orderEscalation,members:orderMembers}):<aside className="order-team-aside">{orderAsideNodes}</aside>):null;
  const orderConversation=info&&client&&active?<OrderConversation key={JSON.stringify([identity,info.appId,info.orderId,info.teamId])} client={client} info={{...info,canSend:info.canSend&&sendAllowed}} connection={connection} active={active} visible={visible}
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
    isImageSending={()=>imageAttempts.current.has(draftKey)} beginPendingImage={beginPendingImage} settlePendingImage={settlePendingImage} render={renderConversation}/>:<p role="status">聊天连接正在准备中，订单与付款状态不受影响。</p>;
  return <section className="order-team-panel" data-compact={compact} hidden={!active} aria-label={realm==="admin"?"我参与的订单群":"我的订单群"}>
    <header className="order-team-toolbar"><strong>{realm==="admin"?"我参与的订单群":"我的订单群"}</strong>{realm==="user"?<label>订单身份 <select aria-label="订单身份" value={party} onChange={e=>{choose(null);setItems([]);setParty(e.target.value as "renter"|"owner");}}><option value="renter">买家 · 租入订单</option><option value="owner">号主 · 出租订单</option></select></label>:null}{/* 正常时这只是重新读取，不是让用户"重新授权"；只有真的 401/403/423 才换成授权语义。 */}<button type="button" data-action="refresh-order-panel" onClick={()=>setRevision(n=>n+1)}>{unauthorized?"重新确认授权":"刷新"}</button></header>
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
        {visibleItems.map(item=><button type="button" key={item.id} aria-current={selected===item.id?"page":undefined} onClick={event=>{orderTrigger.current=event.currentTarget;choose(item.id);}}><small>{item.displayNo}</small><strong>{item.title}</strong><span>{orderTeamLabel(item)}</span>{realm==="admin"?<AdminEscalationSummary item={item}/>:null}</button>)}
        {visibleNext?<button type="button" disabled={loading||refreshingPages} onClick={()=>void loadList(visibleNext)}>更多订单</button>:null}
      </nav>}
      <div className="order-team-detail">
        {selected&&!renderList?<button type="button" className="order-team-back" onClick={()=>{choose(null);requestAnimationFrame(()=>orderTrigger.current?.focus());}}>返回订单列表</button>:null}
        {!selected?<p>选择订单查看群状态和沟通记录。</p>:!info?<p role="status">{error?"订单信息未获确认":"正在核对订单授权…"}</p>:<>
          {info.canRead&&info.teamState==="READY"?layout==="aside"?<>
            <div className="order-team-conversation">{orderHeader}{orderConversation}</div>
            {orderAside}
          </>:<>{orderHeader}{orderAsideNodes}{orderConversation}</>:<p>群尚未可用，暂不能发送消息。页面会自动更新状态，打开页面不会触发付款或重复建群。</p>}
        </>}
      </div>
    </div>}
  </section>;
}

function OrderConversation({
  client,
  info,
  connection,
  active,
  visible,
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
  pendingText,
  getPendingText,
  isTextSending,
  beginPendingText,
  settlePendingText,
  render,
}:{
  client:NimWebClientLike;
  info:OrderTeamAccess;
  connection:Props["connection"];
  active:boolean;
  visible:boolean;
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
  pendingText:TextDraft|null;
  getPendingText:()=>TextDraft|null;
  isTextSending:()=>boolean;
  beginPendingText:(targetDraftKey:string,text:string,messageClientId?:string)=>TextDraft|null;
  settlePendingText:(targetDraftKey:string,attempt:TextDraft,result:{success:boolean;error?:unknown})=>void;
  render?:(view:OrderTeamConversationView)=>ReactNode;
}){
  type Message=NimMessageLike&{id:string};
  const [messages,setMessages]=useState<Message[]>([]),[error,setError]=useState(""),[localSending,setSending]=useState(false),[reading,setReading]=useState(false),[more,setMore]=useState(true),[viewer,setViewer]=useState<{url:string;name:string}|null>(null);
  const sending=localSending||isTextSending(),textRetry=pendingText&&pendingText.state!=="SENDING"?pendingText:null;
  const submittingRef=useRef(false),canStartSendRef=useRef(false);canStartSendRef.current=info.canSend&&connection==="CONNECTED"&&active&&visible;
  const generation=useRef(0),clientRef=useRef(client),accessRef=useRef(readAccess),sendOwner=useRef(0),readOwner=useRef(0),viewerTrigger=useRef<HTMLElement|null>(null),viewerClose=useRef<HTMLButtonElement|null>(null);
  const stagedImagesRef=useRef(stagedImages);stagedImagesRef.current=stagedImages;
  const pendingImageRef=useRef(pendingImage);pendingImageRef.current=pendingImage;
  const activeRef=useRef(active);activeRef.current=active;
  const visibleRef=useRef(visible);visibleRef.current=visible;
  accessRef.current=readAccess;
  if(clientRef.current!==client){clientRef.current=client;generation.current++;}
  const scope=JSON.stringify([info.appId,info.orderId,info.teamId,info.conversationId,info.viewerAccountId]);
  const scopeRef=useRef(scope);scopeRef.current=scope;
  useEffect(()=>{if(viewer){const dialog=viewerClose.current?.closest("dialog");dialog?.showModal();viewerClose.current?.focus();return()=>dialog?.close();}else viewerTrigger.current?.focus();},[viewer]);
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
    try{const rows=await client.getMessageHistory(info.conversationId!,50,before,authorize(version));if(version!==generation.current||clientRef.current!==client)return;merge(rows);setMore(rows.length===50);setError("");}
    catch(cause){if(version===generation.current&&!superseded(cause))setError(statusOf(cause)===403?"当前无法读取历史，请重新确认授权":"历史暂未加载，请重试");}
    finally{if(version===generation.current&&owner===readOwner.current)setReading(false);}
  };
  useEffect(()=>{
    const version=++generation.current;setMessages([]);setSending(false);setReading(false);let off:(()=>void)|undefined;let delivery=Promise.resolve();
    void authorize(version)({conversationId:info.conversationId!,operation:"read"}).then(()=>{
      if(version!==generation.current)return;
      off=client.onMessages(incoming=>{if(!incoming.some(m=>m.conversationId===info.conversationId))return;delivery=delivery.then(async()=>{await authorize(version)({conversationId:info.conversationId!,operation:"read"});if(version===generation.current)merge(incoming);}).catch(()=>undefined);});
      void history();
    }).catch(cause=>{if(version===generation.current&&!superseded(cause))setError("当前无法读取消息，请重新确认授权");});
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
    return false;
  };
  const send=async(event:FormEvent)=>{
    event.preventDefault();const text=draft.trim(),currentStaged=stagedImagesRef.current,currentPending=pendingImageRef.current;
    if((!text&&!currentStaged.length&&!currentPending)||submittingRef.current||sending||isTextSending()||isImageSending()||currentPending?.state==="SENDING"||!canStartSendRef.current)return;
    const currentText=getPendingText(),originalText=currentText&&currentText.state!=="SENDING"?currentText:null;
    if(originalText?.state==="UNKNOWN"&&(!text||!originalText.messageClientId)){setError(originalText.messageClientId?"请先按原消息重试文字，再发送图片":"原文字标识不可用，请先核验发送结果；不可重新发送");return;}
    if(currentStaged.some(it=>it.state==="DECODING"||it.width<=0||it.height<=0)){setError("图片仍在检查，请稍候");return;}
    if(currentPending?.state==="UNKNOWN"){setError("图片发送结果未确认，请先刷新历史；确认未发送后再重试");return;}
    if(currentPending?.state==="FAILED"&&currentStaged.length>0){setError("请先处理失败的图片，再发送后续内容");return;}
    const version=generation.current,owner=++sendOwner.current;submittingRef.current=true;setSending(true);setError("");
    let activeStage:"text"|"image"|null=null;
    try{
      if(text){
        activeStage="text";
        const sent=await sendOneText(originalText?.text??text,version,originalText?.messageClientId);
        if(version!==generation.current)return;merge([sent]);
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
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        if(activeStage==="text"||cause instanceof NimTextSendError){
          const textError=cause instanceof NimTextSendError?cause:null;
          setError(statusOf(cause)===403?"发送权限已变化，草稿已保留":textError?.kind==="UNKNOWN"?"发送结果未确认，草稿已保留；可先刷新历史或原消息重试":"发送失败，草稿已保留，可重试");
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
  const retryText=async()=>{
    if(submittingRef.current||sending||isTextSending()||isImageSending()||pendingImageRef.current?.state==="SENDING"||!canStartSendRef.current)return;
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
  const retryPendingImage=async()=>{
    if(!pendingImage||submittingRef.current||sending||isTextSending()||isImageSending()||pendingImage.state==="SENDING"||!canStartSendRef.current)return;
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
  const imageInFlight=pendingImage?.state==="SENDING";
  const imageBlocked=stagedImages.some(it=>it.state==="DECODING"||it.width<=0||it.height<=0);
  const sendError=error||(pendingText?.state==="UNKNOWN"?(pendingText.messageClientId?"上一条文字发送结果未确认，请先核验或按原消息重试":"原文字标识不可用，请先核验发送结果；不可重新发送"):"");
  // 放大查看始终是同一个原生 modal dialog：换呈现层不能顺带丢掉 Escape 收敛与焦点回归。
  const viewerDialog=viewer?<dialog className="order-team-image-viewer" aria-label="图片预览" onKeyDown={event=>{if(event.key==="Tab"){event.preventDefault();viewerClose.current?.focus();}else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setViewer(null);}}} onCancel={event=>{event.preventDefault();setViewer(null);}}><button ref={viewerClose} type="button" onClick={()=>setViewer(null)}>关闭图片</button><img src={viewer.url} alt={viewer.name}/></dialog>:null;
  if(render)return <>
    {render({info,messages,connection,accountId:client.accountId,draft,setDraft,stagedImages,pendingImage,error:sendError,reading,sending,
      hasMore:more,textRetry,viewer,openImage:(url,name,trigger)=>{viewerTrigger.current=trigger;setViewer({url,name});},closeImage:()=>setViewer(null),
      canSend:info.canSend,isImageSending:imageInFlight,imageBlocked,
      onRefresh:()=>void history(),onLoadEarlier:()=>{if(messages[0])void history(messages[0]);},onSubmit:send,onStageFiles:stageFiles,
      onRemoveStaged:removeStagedImage,onRemovePending:removePendingImage,onRetryText:()=>void retryText(),onRetryPendingImage:()=>void retryPendingImage()})}
    {viewerDialog}
  </>;
  return <section className="order-team-chat" aria-label="订单文字和图片沟通">
    <p role="status">{client.transport==="local-fake"?"local-fake 受控消息 · ":""}{connection==="CONNECTED"?"已连接":connection==="RECONNECTING"?"网络中断，正在重连":"连接不可用"}{!info.canSend?" · 当前只可阅读":""}</p>
    <button type="button" onClick={()=>void history()} disabled={reading}>刷新消息</button>
    {more&&messages.length?<button type="button" disabled={reading} onClick={()=>void history(messages[0])}>更早的消息</button>:null}
    {sendError?<p role="alert">{sendError}</p>:null}
    {textRetry?<button type="button" disabled={sending||!textRetry.messageClientId||!info.canSend||connection!=="CONNECTED"} onClick={()=>void retryText()}>原消息重试</button>:null}
    <ol className="order-team-messages" aria-label="订单消息" aria-live="polite">{messages.map((message,index)=>{
      const member=info.members.find(m=>m.accountId===message.senderId),self=message.senderId===client.accountId;
      return <li key={message.id} data-self={self} data-grouped={Boolean(index>0&&messages[index-1]?.senderId===message.senderId&&message.createTime-messages[index-1]!.createTime<300_000)}><small>{self?"我":member?.name?.trim()|| (member?role(member):"平台消息")} {member?role(member):""} · {serverTimeLabel(new Date(message.createTime).toString())}</small>{message.messageType===1&&message.attachment?<MessageImage attachment={message.attachment} onOpen={(url,name,trigger)=>{viewerTrigger.current=trigger;setViewer({url,name});}}/>:<p>{(message.messageType===undefined||message.messageType===0)&&typeof message.text==="string"?message.text:"暂不支持此消息类型"}</p>}{self?<small>已发送</small>:null}</li>;
    })}</ol>
    {!messages.length?<p>{reading?"正在读取历史…":"暂无文字或图片消息"}</p>:null}
    {pendingImage?<div className="order-team-image-draft" aria-label="待发送图片" data-state={pendingImage.state}><img src={pendingImage.previewUrl} alt={pendingImage.name}/><span>{pendingImage.name} · {formatBytes(pendingImage.size)}{pendingImage.state==="DECODING"?" · 正在检查":pendingImage.state==="SENDING"?` · 发送中 ${pendingImage.progress}%`:pendingImage.state==="UNKNOWN"?" · 结果未确认":pendingImage.state==="FAILED"?" · 发送失败":" · 待发送"}</span><button type="button" onClick={()=>void retryPendingImage()} disabled={sending||imageInFlight}>{pendingImage.messageClientId?"原消息重试":"重试"}</button><button type="button" onClick={removePendingImage} disabled={sending||imageInFlight||pendingImage.state==="UNKNOWN"}>移除</button></div>:null}
    {stagedImages.map((staged,idx)=><div key={staged.previewUrl} className="order-team-image-draft" aria-label="待发送图片" data-state={staged.state}><img src={staged.previewUrl} alt={staged.name}/><span>{stagedImages.length>1?`${idx+1}. `:""}{staged.name} · {formatBytes(staged.size)}{staged.state==="DECODING"?" · 正在检查":" · 待发送"}</span><button type="button" onClick={()=>removeStagedImage(staged.previewUrl)} disabled={sending||imageInFlight}>移除</button></div>)}
    <form onSubmit={send}><label>订单消息<textarea aria-label="订单消息输入" value={draft} maxLength={4000} onChange={e=>{setDraft(e.target.value);e.currentTarget.style.height="auto";e.currentTarget.style.height=Math.min(e.currentTarget.scrollHeight,144)+"px";}} placeholder="输入文字；上号资料不进入固定摘要"/></label><div className="order-team-composer-tools"><button type="button" className="order-team-info-action" aria-label="本单信息" title="本单信息" onClick={()=>{const infoText=`【本单信息】${info.account.title} (订单尾号: ${info.displayNo})`;setDraft(draft?`${draft}\n${infoText}`:infoText);}}>本单信息</button><label className="order-team-image-picker">选择图片<input type="file" multiple accept="image/jpeg,image/png" onChange={chooseImage} disabled={!info.canSend||connection!=="CONNECTED"||sending||imageInFlight}/></label></div><button type="submit" disabled={!info.canSend||connection!=="CONNECTED"||sending||imageInFlight||imageBlocked||(!draft.trim()&&!stagedImages.length&&!pendingImage)}>{sending?"发送中…":pendingImage&&(pendingImage.state==="FAILED"||pendingImage.state==="UNKNOWN")?"重试图片":stagedImages.length>0?"发送图片":"发送文字"}</button></form>
    {viewer?<dialog className="order-team-image-viewer" aria-label="图片预览" onKeyDown={event=>{if(event.key==="Tab"){event.preventDefault();viewerClose.current?.focus();}else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setViewer(null);}}} onCancel={event=>{event.preventDefault();setViewer(null);}}><button ref={viewerClose} type="button" onClick={()=>setViewer(null)}>关闭图片</button><img src={viewer.url} alt={viewer.name}/></dialog>:null}
  </section>;
}
