"use client";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImLifecycleSupersededError } from "@zzsh/im-client/lifecycle";
import { mergeImMessages } from "@zzsh/im-client/message-state";
import { NimImageSendError, validateNimImageFile, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState, type NimMessageAuthorization } from "@zzsh/im-client/nim-web-client";

type Member={platformId:string;accountId:string;party:string;name:string|null;avatar:string|null;responsible?:boolean;membershipStatus?:string;identityStatus?:string};
type SupportEscalation={firstResponseAt:string|null;remindDueAt:string|null;addRound:number;state:string;needsManualReview:boolean;noEligibleStaff:boolean};
type MessageRouteGrant={appId:string;orderId:string;teamId:string;conversationId:string;routeEnvironment:string};
export type OrderTeamAccess={orderId:string;displayNo:string;orderStatus:string;assignmentState:string|null;teamState:string|null;
  appId?:string;teamId?:string;name?:string;gameName:string;account:{id:string;title:string};viewerAccountId?:string;conversationId?:string;messageRoute?:MessageRouteGrant;canRead:boolean;canSend:boolean;members:Member[];supportEscalation:SupportEscalation};
type OrderItem={id:string;displayNo:string;title:string;status:string;teamState?:string|null;firstResponseAt?:string|null;remindDueAt?:string|null;addRound?:number;escalationState?:string;fulfillmentAssignment?:{state:string;teamState:string|null}|null};
type OrderPage={items:OrderItem[];nextCursor:string|null};
type ListRefresh={scope:string;targetPages:number;pagesRead:number;cursor:string|null|undefined;items:OrderItem[]};
const REFRESH_PAGE_BUDGET=2;
type Requester=<T>(path:string)=>Promise<T>;
type Props={identity:string;realm:"user"|"admin";client:NimWebClientLike|null;connection:NimWebConnectionState|"idle"|"error";active:boolean;initialParty?:"renter"|"owner";sendAllowed?:boolean;
  request:Requester;onAuthError:(status:number)=>void};
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
function escalationStateLabel(state:string,firstResponseAt:string|null=null):string{
  switch(state){
    case "RUNNING":return "待客服回应";
    case "STOPPED":return firstResponseAt?"已收到客服回应":"接待跟踪已停止";
    case "EXHAUSTED":return "暂无合格客服可补派";
    case "VERIFY_REQUIRED":return "补派结果待人工核验";
    case "NOT_STARTED":return "接待跟踪未启用";
    default:return "接待状态待确认";
  }
}
function reviewReason(value:Pick<SupportEscalation,"needsManualReview"|"noEligibleStaff">):string|null{
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
  const review=reviewReason(value);
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
const role=(m:Member)=>m.party==="BUYER"?"买家":m.party==="OWNER"?"号主":m.responsible?"负责客服":"协作客服";
type ImageAttachment=NonNullable<NimMessageLike["attachment"]>;
type ImageDraft={file:File;previewUrl:string;name:string;size:number;width:number;height:number;state:"DECODING"|"READY"|"SENDING"|"FAILED"|"UNKNOWN";progress:number;messageClientId?:string};
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
export function OrderTeamPanel({identity,realm,client,connection,active,initialParty="renter",sendAllowed=true,request,onAuthError}:Props){
  const [party,setParty]=useState(initialParty),[items,setItems]=useState<OrderItem[]>([]),[next,setNext]=useState<string|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[info,setInfo]=useState<OrderTeamAccess|null>(null),[error,setError]=useState("");
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[refreshingPages,setRefreshingPages]=useState(false),[drafts,setDrafts]=useState<Record<string,string>>({});
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
    if(status===401||status===423){setInfo(null);itemsScope.current=listScopeRef.current;setItems([]);loadedPages.current=1;nextCursor.current=null;refreshCycle.current=null;moreRequested.current=false;setRefreshingPages(false);setNext(null);setDrafts({});setError(status===423?"请先解锁管理会话":"登录已失效，请重新确认身份");authErrorRef.current(status);return;}
    if(status===403||status===404){
      if(operation==="list"){setInfo(null);itemsScope.current=listScopeRef.current;setItems([]);loadedPages.current=1;nextCursor.current=null;refreshCycle.current=null;moreRequested.current=false;setRefreshingPages(false);setNext(null);}
      else if(operation==="read"){const revoked=selected;setInfo(null);if(revoked)setItems(current=>current.filter(item=>item.id!==revoked));setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([key])=>JSON.parse(key)[2]!==selected)));}
      else setInfo(current=>current?{...current,canSend:false}:current);
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
        setInfo(value);setItems(current=>current.map(item=>item.id===id?{...item,status:value.orderStatus,teamState:value.teamState,firstResponseAt:value.supportEscalation.firstResponseAt,remindDueAt:value.supportEscalation.remindDueAt,addRound:value.supportEscalation.addRound,escalationState:value.supportEscalation.state,fulfillmentAssignment:item.fulfillmentAssignment?{...item.fulfillmentAssignment,state:value.assignmentState??item.fulfillmentAssignment.state,teamState:value.teamState}:item.fulfillmentAssignment}:item));setError("");return value;
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
            refreshCycle.current=null;setRefreshingPages(false);setError("");
            if(!nextPage)moreRequested.current=false;
          }else{setRefreshingPages(true);setError("");}
        }else{
          const value=await requestRef.current<OrderPage>(`${prefix}/${realm==="admin"?"im-groups":""}?${realm==="user"?`party=${party}&`:""}limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
          if(listScopeRef.current!==scope||ticket!==listSequence.current||!activeRef.current)return;
          itemsScope.current=scope;setItems(current=>{const seen=new Set(current.map(item=>item.id));return [...current,...value.items.filter(row=>{if(seen.has(row.id))return false;seen.add(row.id);return true;})];});
          loadedPages.current=Math.max(loadedPages.current,1)+1;nextCursor.current=value.nextCursor;setNext(value.nextCursor);setError("");
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
    if(!active){setLoading(false);setRefreshingPages(false);listSequence.current++;refreshCycle.current=null;return;}
    let cancelled=false,pending=false;
    const refresh=async()=>{
      if(cancelled||pending||(typeof document!=="undefined"&&document.visibilityState==="hidden"))return;
      pending=true;
      try{await listRef.current();if(!cancelled&&selected)await accessRef.current("read").catch(()=>undefined);}
      finally{pending=false;}
    };
    void refresh();const timer=setInterval(()=>{void refresh();},5000);
    return()=>{cancelled=true;clearInterval(timer);accessSequence.current++;};
  },[identity,party,selected,active,revision]);
  const choose=(id:string|null)=>{accessSequence.current++;setInfo(null);setSelected(id);setError("");};
  const visibleItems=itemsScope.current===listScope?items:[],visibleNext=itemsScope.current===listScope?next:null;
  return <section className="order-team-panel" hidden={!active} aria-label={realm==="admin"?"我参与的订单群":"我的订单群"}>
    <header className="order-team-toolbar"><strong>{realm==="admin"?"我参与的订单群":"我的订单群"}</strong>{realm==="user"?<label>订单身份 <select aria-label="订单身份" value={party} onChange={e=>{choose(null);setItems([]);setParty(e.target.value as "renter"|"owner");}}><option value="renter">买家 · 租入订单</option><option value="owner">号主 · 出租订单</option></select></label>:null}<button type="button" onClick={()=>setRevision(n=>n+1)}>重新确认授权</button></header>
    {error?<p role="alert">{error}</p>:null}
    <div className="order-team-grid" data-detail={Boolean(selected)}>
      <nav className="order-team-list" aria-label="订单列表" aria-busy={loading||refreshingPages}>
        {!visibleItems.length?<p>{loading?"正在读取订单…":"暂无可访问的订单"}</p>:null}
        {visibleItems.map(item=><button type="button" key={item.id} aria-current={selected===item.id?"page":undefined} onClick={event=>{orderTrigger.current=event.currentTarget;choose(item.id);}}><small>{item.displayNo}</small><strong>{item.title}</strong><span>{orderTeamLabel(item)}</span>{realm==="admin"?<AdminEscalationSummary item={item}/>:null}</button>)}
        {visibleNext?<button type="button" disabled={loading||refreshingPages} onClick={()=>void loadList(visibleNext)}>更多订单</button>:null}
      </nav>
      <div className="order-team-detail">
        {selected?<button type="button" className="order-team-back" onClick={()=>{choose(null);requestAnimationFrame(()=>orderTrigger.current?.focus());}}>返回订单列表</button>:null}
        {!selected?<p>选择订单查看群状态和沟通记录。</p>:!info?<p role="status">{error?"订单信息未获确认":"正在核对订单授权…"}</p>:<>
          <header><h3>{info.name??info.displayNo}</h3><p>{orderTeamLabel(info)}</p><p>{info.gameName} · {info.account.title}</p><small>订单 {info.displayNo} · 账号 {info.account.id}</small></header>
          {info.canRead&&info.teamState==="READY"?<>
            <OrderTeamEscalation value={info.supportEscalation}/>
            <ul className="order-team-members" aria-label="群成员">{info.members.map(m=><li key={m.accountId}>{m.avatar?<img src={m.avatar} alt="" width={28} height={28} onError={e=>{e.currentTarget.hidden=true;}}/>:<span aria-hidden="true">●</span>}<span>{m.name?.trim()||role(m)}<small>{role(m)}</small>{realm==="admin"&&m.party!=="STAFF"?<small>用户编号 {m.platformId} · 会员：未知 · 实名：未知</small>:null}</span></li>)}</ul>
            {client&&active?<OrderConversation key={JSON.stringify([identity,info.appId,info.orderId,info.teamId])} client={client} info={{...info,canSend:info.canSend&&sendAllowed}} connection={connection}
              readAccess={operation=>accessRef.current(operation)} draft={drafts[draftKey]??""} setDraft={value=>setDrafts(current=>({...current,[draftKey]:value}))}/>:<p role="status">聊天连接正在准备中，订单与付款状态不受影响。</p>}
          </>:<p>群尚未可用，暂不能发送消息。页面会自动更新状态，打开页面不会触发付款或重复建群。</p>}
        </>}
      </div>
    </div>
  </section>;
}

function OrderConversation({client,info,connection,readAccess,draft,setDraft}:{client:NimWebClientLike;info:OrderTeamAccess;connection:Props["connection"];readAccess:(operation:"read"|"send")=>Promise<OrderTeamAccess>;draft:string;setDraft:(value:string)=>void}){
  type Message=NimMessageLike&{id:string};
  const [messages,setMessages]=useState<Message[]>([]),[error,setError]=useState(""),[sending,setSending]=useState(false),[reading,setReading]=useState(false),[more,setMore]=useState(true),[image,setImage]=useState<ImageDraft|null>(null),[viewer,setViewer]=useState<{url:string;name:string}|null>(null);
  const generation=useRef(0),clientRef=useRef(client),accessRef=useRef(readAccess),sendOwner=useRef(0),readOwner=useRef(0),draftRef=useRef(draft),imageRef=useRef<ImageDraft|null>(null),selection=useRef(0),viewerTrigger=useRef<HTMLElement|null>(null),viewerClose=useRef<HTMLButtonElement|null>(null);
  accessRef.current=readAccess;draftRef.current=draft;imageRef.current=image;
  if(clientRef.current!==client){clientRef.current=client;generation.current++;}
  const scope=JSON.stringify([info.appId,info.orderId,info.teamId,info.conversationId,info.viewerAccountId]);
  const scopeRef=useRef(scope);scopeRef.current=scope;
  const revoke=(draftToRelease:ImageDraft|null)=>{if(draftToRelease?.previewUrl)URL.revokeObjectURL(draftToRelease.previewUrl);};
  useEffect(()=>()=>{selection.current++;revoke(imageRef.current);},[]);
  useEffect(()=>{if(viewer){const dialog=viewerClose.current?.closest("dialog");dialog?.showModal();viewerClose.current?.focus();return()=>dialog?.close();}else viewerTrigger.current?.focus();},[viewer]);
  const replaceImage=(next:ImageDraft|null)=>{setImage(current=>{if(current&&current!==next)revoke(current);imageRef.current=next;return next;});};
  const chooseImage=(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];event.target.value="";if(!file)return;const ticket=++selection.current;
    try{validateNimImageFile(file);}catch(cause){setError(cause instanceof Error?cause.message:"图片无效");return;}
    const previewUrl=URL.createObjectURL(file);const draftImage:ImageDraft={file,previewUrl,name:file.name,size:file.size,width:0,height:0,state:"DECODING",progress:0};replaceImage(draftImage);
    void decodeImage(previewUrl).then(({width,height})=>{if(ticket!==selection.current){revoke(draftImage);return;}setImage(current=>current===draftImage?{...current,width,height,state:"READY"}:current);}).catch(()=>{if(ticket===selection.current){replaceImage(null);setError("图片无法解码，请选择有效的 JPG 或 PNG");}});
  };
  const authorize=(version:number):NimMessageAuthorization=>async({conversationId,operation})=>{
    const fresh=await accessRef.current(operation);
    if(version!==generation.current||clientRef.current!==client||scope!==scopeRef.current)throw new ImLifecycleSupersededError();
    if(!fresh.canRead||fresh.teamState!=="READY"||fresh.appId!==info.appId||fresh.orderId!==info.orderId||fresh.teamId!==info.teamId
      ||fresh.conversationId!==conversationId||fresh.viewerAccountId!==client.accountId||(operation==="send"&&!fresh.canSend))throw rejected();
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
  const send=async(event:FormEvent)=>{
    event.preventDefault();const text=draft.trim(),selectedImage=imageRef.current;if((!text&&!selectedImage)||sending||!info.canSend||connection!=="CONNECTED")return;
    if(selectedImage&&(selectedImage.state==="DECODING"||selectedImage.width<=0||selectedImage.height<=0)){setError("图片仍在检查，请稍候");return;}
    const version=generation.current,owner=++sendOwner.current;setSending(true);setError("");
    try{
      if(selectedImage){
        setImage(current=>current?{...current,state:"SENDING",progress:0}:current);
        const progress=(percentage:number)=>{if(version===generation.current)setImage(current=>current?{...current,progress:percentage}:current);};
        const sent=selectedImage.messageClientId?await client.retryImage(info.conversationId!,selectedImage.messageClientId,{authorize:authorize(version),onProgress:progress}):await client.sendImage(info.conversationId!,selectedImage.file,{authorize:authorize(version),onProgress:progress,width:selectedImage.width,height:selectedImage.height});
        if(version!==generation.current)return;merge([sent]);replaceImage(null);
      }else{
        const sent=await client.sendText(info.conversationId!,text,authorize(version));if(version!==generation.current)return;merge([sent]);if(draftRef.current.trim()===text)setDraft("");
      }
    }catch(cause){
      if(version===generation.current&&!superseded(cause)){
        if(selectedImage){const messageClientId=cause instanceof NimImageSendError?cause.messageClientId:selectedImage.messageClientId;setImage(current=>current?{...current,state:cause instanceof NimImageSendError&&cause.kind==="UNKNOWN"?"UNKNOWN":"FAILED",messageClientId:messageClientId??current.messageClientId}:current);setError(imageErrorMessage(cause));if(cause instanceof NimImageSendError&&cause.kind==="UNKNOWN")void history();}
        else{setError(statusOf(cause)===403?"发送权限已变化，草稿已保留":"发送结果未确认，请先查看历史再决定是否重试");}
        if(statusOf(cause)===403)void accessRef.current("read").catch(()=>undefined);
      }
    }finally{if(version===generation.current&&owner===sendOwner.current)setSending(false);}
  };
  const removeImage=()=>{selection.current++;replaceImage(null);};
  const imageBlocked=Boolean(image&&(image.state==="DECODING"||image.width<=0||image.height<=0));
  return <section className="order-team-chat" aria-label="订单文字和图片沟通">
    <p role="status">{client.transport==="local-fake"?"local-fake 受控消息 · ":""}{connection==="CONNECTED"?"已连接":connection==="RECONNECTING"?"网络中断，正在重连":"连接不可用"}{!info.canSend?" · 当前只可阅读":""}</p>
    <button type="button" onClick={()=>void history()} disabled={reading}>刷新消息</button>
    {more&&messages.length?<button type="button" disabled={reading} onClick={()=>void history(messages[0])}>更早的消息</button>:null}
    {error?<p role="alert">{error}</p>:null}
    <ol className="order-team-messages" aria-label="订单消息" aria-live="polite">{messages.map(message=>{
      const member=info.members.find(m=>m.accountId===message.senderId),self=message.senderId===client.accountId;
      return <li key={message.id} data-self={self}><small>{self?"我":member?.name?.trim()|| (member?role(member):"平台消息")} {member?role(member):""} · {serverTimeLabel(new Date(message.createTime).toString())}</small>{message.messageType===1&&message.attachment?<MessageImage attachment={message.attachment} onOpen={(url,name,trigger)=>{viewerTrigger.current=trigger;setViewer({url,name});}}/>:<p>{(message.messageType===undefined||message.messageType===0)&&typeof message.text==="string"?message.text:"暂不支持此消息类型"}</p>}{self?<small>已发送</small>:null}</li>;
    })}</ol>
    {!messages.length?<p>{reading?"正在读取历史…":"暂无文字或图片消息"}</p>:null}
    {image?<div className="order-team-image-draft" aria-label="待发送图片"><img src={image.previewUrl} alt={image.name}/><span>{image.name} · {formatBytes(image.size)}{image.state==="DECODING"?" · 正在检查":image.state==="SENDING"?` · 发送中 ${image.progress}%`:image.state==="UNKNOWN"?" · 结果未确认":image.state==="FAILED"?" · 发送失败":" · 待发送"}</span><button type="button" onClick={removeImage} disabled={sending}>移除</button></div>:null}
    <form onSubmit={send}><label>订单消息<textarea aria-label="订单消息输入" value={draft} maxLength={4000} onChange={e=>setDraft(e.target.value)} placeholder="输入文字；上号资料不进入固定摘要"/></label><label className="order-team-image-picker">选择图片<input type="file" accept="image/jpeg,image/png" onChange={chooseImage} disabled={!info.canSend||connection!=="CONNECTED"||sending}/></label><button type="submit" disabled={!info.canSend||connection!=="CONNECTED"||sending||imageBlocked||(!draft.trim()&&!image)}>{sending?"发送中…":image?(image.state==="FAILED"||image.state==="UNKNOWN"?"重试图片":"发送图片"):"发送文字"}</button></form>
    {viewer?<dialog className="order-team-image-viewer" aria-label="图片预览" onKeyDown={event=>{if(event.key==="Tab"){event.preventDefault();viewerClose.current?.focus();}else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setViewer(null);}}} onCancel={event=>{event.preventDefault();setViewer(null);}}><button ref={viewerClose} type="button" onClick={()=>setViewer(null)}>关闭图片</button><img src={viewer.url} alt={viewer.name}/></dialog>:null}
  </section>;
}
