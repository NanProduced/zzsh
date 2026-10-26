import { AdminOrderPaymentSummary } from './admin-order-payment-summary';
import type { AdminOrderPaymentSummary as PaymentSummary } from '../api';
import { PublicBasisView } from "./supply-review/detail-pane";
import { accountNumberLabel, formatFundingCents, formatTermDays, historicalAttributeFacts, historicalReadSummary, historicalResourceText, orderTitleText, quantityText, unitText } from "./supply-review/model";
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
import { ArrowLeft,ArrowUpRight,CalendarDays,CircleAlert,CreditCard,FileText,Flag,KeyRound,X } from "lucide-react";
import { ListPagination, ListToolbar, ListToolbarSearch, ListToolbarEnumSelect, ListToolbarApplied } from "@/components/admin-list";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DateSelector, type DateSelectorValue } from "@/components/reui/date-selector";
import { useIsMobile } from "@/hooks/use-mobile";
import { adminRequest,friendlyError,AdminApiError,type SessionSnapshot,type AdminOrderMoney,type AdminOrder } from "../api";
import { BEIJING_TIME_ZONE } from "../workspace/beijing-time";
import { AdminOrderSettlementEvidence, type OrderSettlementReadState } from './admin-order-settlement-evidence';
import { defaultFinanceFilters, financeRead, type OrderSettlementEvidence } from './admin-finance-api';
import { LegacyAdminContinuationPanel } from "./legacy-continuation-panel";
import { Button } from "../components/ui-elements";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { OrderStages as Stages, ORDER_STATUS_LABELS, type OrderProgress } from "./admin-order-stages";
import { EntityPreviewTrigger, AccountPreviewCard, UserPreviewCard } from "../components/admin-preview";
import { financeContextIdentity, financeOriginPath, registerFinanceOrigin } from "./admin-finance-view";
import { sanitizeFinanceReturn } from '../workspace/tab-model';
type Snapshot=Extract<SessionSnapshot,{authenticated:true}>;
type Payment={state:"RECORDED_PAID"|"RECORDED_UNPAID"|"UNKNOWN";recordedAt:string|null;recordedAmount:AdminOrderMoney|null};
type PartySummary=import('../api').DirectoryUserPreview;
type PrepaymentBreakdown={basis:string;completeness:"COMPLETE"|"PARTIAL"|"UNKNOWN";haffRental:AdminOrderMoney|null;materialsPrepay:AdminOrderMoney|null};
type RefundIntent={intentId:string;refundOrderNo:string;amount:{cents:string;currency:string};localState:string;budgetDisposition:string;requiresReview:boolean;mayResubmit:boolean;bankArrival:"UNKNOWN"};
type RefundSummary={contractVersion:string;integration:string;intents:RefundIntent[]|null;bankArrival:"UNKNOWN";reasonCodes:string[]};
type FrozenAccount={source:"ORDER_VERSION"|"LEGACY_ACCOUNT";haff:{code:string;name:string|null;quantity:string|null;unit:string}|null;materials:Array<{code:string;name:string|null;quantity:string|null;unit:string}>;termDays:string|null;termSeconds:string|null;loginMethodText:string|null};
type Order={id:string;displayNo:string;status:string;title:string|null;accountTitle?:{source?:string;title?:string|null;neutralSummary?:string|null}|null;accountId:string;accountDisplayNo?:string|null;gameId:string;ownerUserId:string;renterUserId:string;ownerName:string;renterName:string;ownerBusinessNo?:string|null;renterBusinessNo?:string|null;createdAt:string|null;paidAt:string|null;cancelledAt?:string|null;completedAt?:string|null;expiredAwaitingCancel?:boolean;payment:Payment;amounts:{totalDue:AdminOrderMoney|null;rental:AdminOrderMoney|null;deposit:AdminOrderMoney|null};fulfillmentAssignment?:AdminOrder["fulfillmentAssignment"];source:{origin:"NATIVE"|"LEGACY";statusLabel?:string};legacyAmounts?:{refund:AdminOrderMoney|null;refundChannelState:string};prepaymentBreakdown?:PrepaymentBreakdown|null;progress?:OrderProgress|null;ownerSummary?:PartySummary|null;renterSummary?:PartySummary|null;frozenAccount?:FrozenAccount|null};
type Page={items:Order[];page:number;pageSize:number;total:number;contextKey:string};
type Filters={kind:string;q:string;status:string;origin:string;from:string;to:string};
const empty:Filters={kind:"order",q:"",status:"",origin:"",from:"",to:""},statusLabel:Record<string,string>={PENDING_PAYMENT:"待支付",PAID:"已支付",CANCELLED:"已取消",COMPLETED:"已完成",UNKNOWN:"源状态待核"};
const partyLabel=(order:Order,role:"renter"|"owner")=>(order.source.origin==="LEGACY"?"历史":"")+(role==="renter"?"租客":"号主");
const money=(v:AdminOrderMoney|null|undefined)=>v?`¥${v.amount}`:"未知",time=(v:string|null|undefined)=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat("zh-CN",{timeZone:BEIJING_TIME_ZONE,dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"时间未提供";
const paymentLabel=(o:Order)=>o.payment.state==="RECORDED_PAID"?"支付已记录":o.payment.state==="RECORDED_UNPAID"?"未支付":"支付事实待核";
const paymentTime=(o:Order)=>o.payment.state==="RECORDED_PAID"?o.payment.recordedAt?time(o.payment.recordedAt):"支付时间待确认":paymentLabel(o);
/** 本单冻结账号摘要只来自本单版本/历史快照；缺源保持未提供。 */
const frozenText=(f:FrozenAccount)=>{
 const haff=f.haff?quantityText(f.haff.quantity):"哈夫未提供";
 const materials=f.materials.length?f.materials.slice(0,2).map(item=>`${item.name??"名称待核"} ${item.quantity??"数量未知"} ${unitText(item.unit,item.code)}`).join("、")+(f.materials.length>2?` 等 ${f.materials.length} 项`:""):"物资未提供";
 const term=f.source==="LEGACY_ACCOUNT"?(f.termDays?`历史账号租期 ${f.termDays} 天`:"历史账号租期未提供"):f.termDays?`${f.termDays} 天`:f.termSeconds?formatTermDays(f.termSeconds):"租期未提供";
 return `${haff} · ${materials} · ${term} · 登录 ${f.loginMethodText??"未提供"}`;
};
const frozenCompact=(f:FrozenAccount)=>{
 const haff=f.haff?quantityText(f.haff.quantity):"哈夫未提供";
 const materials=f.materials.length?f.materials.slice(0,2).map(item=>item.name??"名称待核").join("、")+(f.materials.length>2?` 等 ${f.materials.length} 项`:""):"物资未提供";
 const term=f.source==="LEGACY_ACCOUNT"?(f.termDays?`历史账号租期 ${f.termDays} 天`:"历史账号租期未提供"):f.termDays?`${f.termDays} 天`:f.termSeconds?formatTermDays(f.termSeconds):"租期未提供";
 return `${f.source==="LEGACY_ACCOUNT"?"历史账号参考":"本单冻结"}：${haff} · ${materials} · ${term} · ${f.loginMethodText??"登录未提供"}`;
};
const frozenHaff=(f?:FrozenAccount|null)=>f?.haff?quantityText(f.haff.quantity):null;
const frozenMaterials=(f?:FrozenAccount|null)=>f?.materials.length?f.materials.slice(0,3).map(item=>`${item.name??"名称待核"} ${item.quantity??"数量未知"} ${unitText(item.unit,item.code)}`).join(" · ")+(f.materials.length>3?`（另${f.materials.length-3}项）`:""):null;
const frozenTerm=(f?:FrozenAccount|null)=>f?.termDays?`${f.termDays} 天`:f?.termSeconds?formatTermDays(f.termSeconds):null;
/** 列表只显示本单原金额与构成；支付状态独立，不用“未支付”替代费用分项。 */
const feeAmountText=(o:Order)=>money(o.amounts.totalDue);
const feeLabel=(o:Order)=>o.status==="PENDING_PAYMENT"?"本次预付":o.status==="CANCELLED"?"原单金额":"原预付";
const feeSplitLines=(o:Order)=>{
 const p=o.prepaymentBreakdown, deposit=money(o.amounts.deposit);
 const lines=p?.completeness==="COMPLETE"?[`哈夫租金 ${money(p.haffRental)}`,`物资预付 ${money(p.materialsPrepay)}`,`押金 ${deposit}`]
  :p?[`哈夫租金 ${p.haffRental?money(p.haffRental):"分项待核"}`,`物资预付 ${p.materialsPrepay?money(p.materialsPrepay):"分项待核"}`,`押金 ${deposit}`]
  :["哈夫租金/物资预付分项待核",`押金 ${deposit}`];
 if(o.status==="CANCELLED")lines.push(o.payment.state==="RECORDED_UNPAID"?"未形成支付":o.payment.state==="RECORDED_PAID"?"已支付 · 退款待核":"支付事实待核");
 return lines;
};
const feeNoteText=(o:Order)=>feeSplitLines(o).join(" · ");
/** 当前下一步只从已取得的同单事实推导；不把 PAID、群或更新时间当成开租/完成。 */
const nextStepText=(o:Order)=>{
 if(o.source.origin==="LEGACY")return o.source.statusLabel?`沿原来源阶段：${o.source.statusLabel}`:"旧来源阶段待核；不套原生开租节点";
 if(o.status==="CANCELLED")return o.payment.state==="RECORDED_PAID"?"租赁结算不适用；退款与迟到付款独立核对":"订单已取消；租赁结算不适用；迟到付款/退款核对独立";
 if(o.status==="PENDING_PAYMENT")return o.expiredAwaitingCancel?"占用到期，待系统取消":"等待租客支付；未支付前不开始履约";
 const p=o.progress;
 if(p?.ending.state==="PENDING_CLASSIFICATION")return "已有待分类结束申请，先完成分类";
 if(p?.ending.state==="PENDING_PARTIES")return "等待租客与号主确认当前结束版本";
 if(p?.ending.state==="PENDING_SUPPORT_REVIEW")return "等待客服复核提前结束";
 if(p?.ending.state==="PENDING_APPROVAL")return "等待有效的运营批准";
 if(p?.ending.state==="READY")return "结算条件已满足，待过账";
 if(p?.ending.state==="POSTED")return "已过账；退款出款与渠道到账另行核对";
 if(p?.opening.state==="AWAITING_CONFIRMATION")return "等待双方确认期初清单；群就绪不等于开租";
 if(p?.opening.state==="CONFIRMED")return o.status==="COMPLETED"?"订单已完成；退款到账另行核对":"已开租，等待结束处理";
 return o.status==="COMPLETED"?"订单已完成；结算依据见资金凭证":"开租依据未提供，不能把 PAID 当作已开始履约";
};
const keyOf=(s:Snapshot)=>JSON.stringify([s.adminUserId,s.session.id,s.security.isBoss,[...s.permissions].sort()]);
type Saved={filters:Filters;page:number;size:number;context?:string;selected?:string;scroll:number};
const saved=new Map<string,Saved>();let currentIdentity="";
/** 地址栏只保存非敏感筛选（状态、下单时间、页码、每页条数）；查找线索不落 URL，也不参与地址相等比较。 */
const ORDER_STATUS_VALUES=["PENDING_PAYMENT","PAID","COMPLETED","CANCELLED"],ORDER_ORIGINS=["NATIVE","LEGACY"];
/** UI 可选每页条数与 URL 解析共用同一集合，避免「能选不能恢复」。 */
const ORDER_PAGE_SIZES=[3,20,50,100];
const ORDER_DEFAULT_SIZE=20;
function parseOrderSize(value:string|undefined){const size=Number(value);return ORDER_PAGE_SIZES.includes(size)?size:ORDER_DEFAULT_SIZE;}
function orderUrlFilters(query:Record<string,string>):Filters{return {kind:"order",q:"",status:ORDER_STATUS_VALUES.includes(query.status??"")?query.status!:"",origin:ORDER_ORIGINS.includes(query.origin??"")?query.origin!:"",from:isIsoDay(query.from??"")?query.from!:"",to:isIsoDay(query.to??"")?query.to!:""};}
/** 只比较允许持久化的公开投影：kind/q 等线索既不写 URL，也不参与相等判断。 */
function orderUrlQuery(filters:Filters,page:number,size:number){const query:Record<string,string>={};if(filters.status)query.status=filters.status;if(filters.origin)query.origin=filters.origin;if(filters.from)query.from=filters.from;if(filters.to)query.to=filters.to;if(page>1)query.page=String(page);if(size!==ORDER_DEFAULT_SIZE)query.size=String(size);return query;}
function orderUrlKey(query:Record<string,string>){return JSON.stringify([query.status??"",query.origin??"",query.from??"",query.to??"",query.page??"",query.size??""]);}
function orderUrlMatches(filters:Filters,page:number,size:number,query:Record<string,string>){const next=orderUrlFilters(query);return next.status===filters.status&&next.origin===filters.origin&&next.from===filters.from&&next.to===filters.to&&page===Math.max(1,Number(query.page)||1)&&size===parseOrderSize(query.size);}
function pageScroller(){const page=document.querySelector<HTMLElement>(".workspace-page");return page&&page.scrollHeight>page.clientHeight?page:document.scrollingElement;}
function Link({children,className,...props}:React.ComponentProps<"button">){return <button type="button" className={className ? `oc-link ${className}` : "oc-link"} {...props}>{children}<ArrowUpRight size={13}/></button>;}
function resourcePublicBasis(data: Record<string, any>, snapshot: Snapshot, accountId: string, onOpenPath: (path: string, title?: string) => void) {
  const basis = data.publicBasis, canHandle = snapshot.security.isBoss || snapshot.permissions.includes("supply.review.read");
  const jump = canHandle ? <Link onClick={() => onOpenPath(`/supply/accounts/${accountId}`, accountNumberLabel(data.displayNo))}>处理此账号</Link> : <span>处理账号需要供给复核权限</span>;
  if (!basis || typeof basis !== "object" || typeof basis.id !== "string") return <section className="oc-section"><h2>对外版本</h2><p>{data.publicVisible === false ? "当前没有对外版本。" : "这次没有读到租客看到的版本。"}</p><p>当前资料标题：{typeof data.title === "string" && data.title ? data.title : "未提供"} · 版本 {data.versionId ?? "未提供"}</p>{jump}</section>;
  return <div className="oc-section"><PublicBasisView basis={basis} /><p className="text-sm text-muted-foreground">当前资料版本 {data.versionId ?? "未提供"} 不替代上面这一版。</p>{jump}</div>;
}
function ErrorState({error,retry}:{error:string;retry:()=>void}){return <Alert variant="destructive"><CircleAlert aria-hidden /><AlertTitle>读取暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription><AlertAction><Button size="sm" variant="secondary" onClick={retry}>重试</Button></AlertAction></Alert>;}
const isoDay=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const nextIsoDay=(value:string)=>{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10);};
const isIsoDay=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));
/** Beijing calendar-day range; the API receives an exclusive next-day bound. */
function OrderDateRange({from,to,onChange}:{from:string;to:string;onChange:(from:string,to:string)=>void}){
 const mobile=useIsMobile();
 const [open,setOpen]=useState(false);
 const seed=():DateSelectorValue=>({period:"day",operator:"between",startDate:from?new Date(`${from}T00:00:00`):undefined,endDate:to?new Date(`${to}T00:00:00`):undefined});
 const [draft,setDraft]=useState<DateSelectorValue>(seed);
 useEffect(()=>{if(open)setDraft(seed());},[open,from,to]);
 return <Field label="下单日期" className="ud-field">
  <Popover open={open} onOpenChange={setOpen}>
   <PopoverTrigger render={<Button type="button" variant="secondary" className="ud-date-trigger" aria-label="下单日期" />}><CalendarDays size={15} aria-hidden/>{from||to?`${from||"不限"} 至 ${to||"不限"}`:"不限"}</PopoverTrigger>
   <PopoverContent className="ud-date-popover" align="start">
    <DateSelector value={draft} onChange={next=>{setDraft(next);if(next.startDate&&next.endDate){onChange(isoDay(next.startDate),isoDay(next.endDate));setOpen(false);}}} presetMode="between" allowRange showTwoMonths={!mobile} dayDateFormat="yyyy-MM-dd" presets={[{label:"近 7 天",days:7},{label:"近 30 天",days:30},{label:"近 90 天",days:90}]}/>
    <div className="ud-date-actions"><Button type="button" variant="secondary" size="sm" onClick={()=>{setDraft({period:"day",operator:"between"});onChange("","");setOpen(false);}}>清空</Button></div>
   </PopoverContent>
  </Popover>
 </Field>;
}
function OrderList({snapshot,onOpenPath,refreshNonce,initialQuery,onQueryChange}:{snapshot:Snapshot;onOpenPath:(path:string,title?:string)=>void;refreshNonce:number;initialQuery?:Record<string,string>;onQueryChange?:(query:Record<string,string>)=>void;}){
 const identity=keyOf(snapshot);const previous=saved.get(identity);
 // 同地址返回才恢复本地线索；新地址仍独立决定公共筛选和分页。
 const restored=previous&&(!initialQuery||orderUrlMatches(previous.filters,previous.page,previous.size,initialQuery))?previous:undefined;
 const initialFilters=initialQuery?{...orderUrlFilters(initialQuery),...(restored?{kind:restored.filters.kind,q:restored.filters.q}:{})}:restored?.filters??empty;
 const [filters,setFilters]=useState<Filters>(()=>initialFilters),[active,setActive]=useState<Filters>(()=>initialFilters),[page,setPage]=useState(()=>initialQuery?Math.max(1,Number(initialQuery.page)||1):restored?.page??1),[size,setSize]=useState(()=>initialQuery?parseOrderSize(initialQuery.size):restored?.size??ORDER_DEFAULT_SIZE),[data,setData]=useState<Page>(),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[inputError,setInputError]=useState<string>(),[nonce,setNonce]=useState(0);
 const state=useRef<Saved>({filters:active,page,size,context:restored?.context,selected:restored?.selected,scroll:restored?.scroll??0}),sequence=useRef(0),ready=useRef(false);state.current={...state.current,filters:active,page,size};
 // URL 是状态/时间/页码的来源：显式地址优先于缓存；外部地址变化时采用地址栏，本地变更时写回地址栏。
 const incomingQuery=initialQuery??{};
 const incomingKey=orderUrlKey(incomingQuery);
 const lastUrlKey=useRef(incomingKey);
 useEffect(()=>{
  if(!onQueryChange)return;
  // 显式地址变化（打开链接/前进后退/宿主传入新 query）优先于旧缓存，缓存只提供地址未承载的线索与上下文。
  if(incomingKey!==lastUrlKey.current){
   lastUrlKey.current=incomingKey;
   if(orderUrlMatches(active,page,size,incomingQuery))return;
   const next=orderUrlFilters(incomingQuery);
   setFilters(current=>({...current,...next}));
   setActive(current=>({...current,...next}));
   setPage(Math.max(1,Number(incomingQuery.page)||1));
   setSize(parseOrderSize(incomingQuery.size));
   setNotice("已按地址栏恢复筛选条件；本次查找线索需重新输入。");
   return;
  }
  if(orderUrlMatches(active,page,size,incomingQuery))return;
  // 本地变更：只投影公开筛选与分页，线索留在本地。
  onQueryChange(orderUrlQuery(active,page,size));
 },[active,incomingKey,onQueryChange,page,size]);
 useLayoutEffect(()=>{const rememberScroll=()=>{if(ready.current)state.current.scroll=pageScroller()?.scrollTop??0;};window.addEventListener("scroll",rememberScroll,true);return()=>{window.removeEventListener("scroll",rememberScroll,true);if(currentIdentity===identity)saved.set(identity,state.current);};},[identity]);
 useEffect(()=>{const controller=new AbortController(),n=++sequence.current;ready.current=false;setData(undefined);setError(undefined);
  const q=new URLSearchParams({page:String(page),pageSize:String(size)});if(active.status)q.set("status",active.status);if(active.origin)q.set("origin",active.origin);if(active.q.trim()){q.set("qKind",active.kind);q.set("qValue",active.q.trim());}if(active.from)q.set("createdFrom",active.from+"T00:00:00+08:00");if(active.to)q.set("createdTo",nextIsoDay(active.to)+"T00:00:00+08:00");if(state.current.context)q.set("restoreKey",state.current.context);
  void adminRequest<Page>(`/orders?${q}`,undefined,"GET",{},controller.signal).then(value=>{if(controller.signal.aborted||sequence.current!==n)return;state.current.context=value.contextKey;setData(value);requestAnimationFrame(()=>{if(controller.signal.aborted||sequence.current!==n)return;const scroller=pageScroller();if(scroller)scroller.scrollTop=state.current.scroll;ready.current=true;if(state.current.selected)[...document.querySelectorAll<HTMLElement>(`[data-order-focus="${CSS.escape(state.current.selected)}"]`)].find(element=>element.getClientRects().length>0)?.focus({preventScroll:true});});}).catch(e=>{if(controller.signal.aborted||sequence.current!==n)return;if(e instanceof AdminApiError&&e.status===409){state.current.context=undefined;state.current.scroll=0;setPage(1);setNotice("可见范围已变化，正在重新读取第一页。");setNonce(v=>v+1);return;}setError(friendlyError(e));});return()=>controller.abort();
 },[identity,active,page,size,refreshNonce,nonce]);
 const open=(o:Order)=>{state.current.selected=o.id;state.current.scroll=pageScroller()?.scrollTop??0;saved.set(identity,state.current);onOpenPath(`/orders/${o.id}`,o.displayNo);};
 const related=(o:Order,role:"renter"|"owner")=>{state.current.selected=o.id;saved.set(identity,state.current);onOpenPath(`/users/${role==="renter"?o.renterUserId:o.ownerUserId}?fromOrderId=${o.id}`,role==="renter"?o.renterName:o.ownerName);};
 const resource=(o:Order)=>{state.current.selected=o.id;saved.set(identity,state.current);onOpenPath(`/supply/accounts/${o.accountId}?fromOrderId=${o.id}`,accountNumberLabel(o.accountDisplayNo));};
 const canUser=snapshot.permissions.includes("user.directory.read")||snapshot.security.isBoss,canResource=(snapshot.permissions.includes("supply.rental_account.read")&&canUser)||snapshot.security.isBoss;
 const submitSearch=()=>{if(filters.from&&filters.to&&filters.from>filters.to){setInputError("起始日期不能晚于截止日期，请修正后查询。");return;}setInputError(undefined);state.current.context=undefined;state.current.scroll=0;setPage(1);setActive({...filters});};
 const resetSearch=()=>{state.current.context=undefined;state.current.scroll=0;setInputError(undefined);setFilters(empty);setActive({...empty});setPage(1);};
 const changePage=(next:number)=>{state.current.scroll=0;setPage(next);};
 const changeSize=(next:number)=>{state.current.scroll=0;setSize(next);setPage(1);};
 return <div className="oc-design"><div className="oc-heading"><div><h1>订单</h1><p>凭订单号、账号编号或交易双方线索定位并核对。</p></div><span className="oc-scope">当前授权游戏范围 · 北京时间</span></div>
 <ListToolbar noValidate className="oc-search" onSubmit={e=>{e.preventDefault();submitSearch();}} onReset={resetSearch}>
   <div className="oc-search-main">
     <Field label="查找方式" composite className="ud-field"><Select value={filters.kind} onValueChange={kind=>setFilters(f=>({...f,kind:kind||"order"}))} items={[["order","订单号"],["account","账号编号"],["party","交易双方"],["renter","租客"],["owner","号主"]].map(([value,label])=>({value,label}))}><SelectTrigger aria-label="查找方式" className="h-9 min-w-[120px] text-xs"><SelectValue/></SelectTrigger><SelectContent className="min-w-[120px]">{[["order","订单号"],["account","账号编号"],["party","交易双方"],["renter","租客"],["owner","号主"]].map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
     <ListToolbarSearch value={filters.q} onChange={q=>setFilters(f=>({...f,q}))} ariaLabel="查找线索" placeholder={filters.kind==="order"||filters.kind==="account"?"业务编号精确匹配":"用户编号精确；昵称、用户名包含匹配"} />
     <Button size="sm" type="submit">查询</Button>
   </div>
   <div className="admin-list-toolbar-row">
     <ListToolbarEnumSelect label="主状态" value={filters.status} onChange={status=>{setFilters(f=>({...f,status}));setInputError(undefined);}} options={["PENDING_PAYMENT","PAID","COMPLETED","CANCELLED"].map(s=>[s,statusLabel[s]] as [string,string])} allLabel="全部状态" />
     <ListToolbarEnumSelect label="来源" value={filters.origin} onChange={origin=>{setFilters(f=>({...f,origin}));setInputError(undefined);}} options={[["NATIVE","新平台订单"],["LEGACY","旧平台订单"]]} allLabel="全部来源" />
     <OrderDateRange from={filters.from} to={filters.to} onChange={(from,to)=>{setFilters(f=>({...f,from,to}));setInputError(undefined);}} />
     <Button size="sm" type="reset" variant="ghost">重置</Button>
   </div>
   {inputError?<p id="oc-date-error" role="alert" className="text-xs text-destructive">{inputError}</p>:null}
   <ListToolbarApplied filters={[
     ...(active.status?[{key:"status",label:"状态 "+statusLabel[active.status],onRemove:()=>{state.current.context=undefined;setFilters(f=>({...f,status:""}));setActive(f=>({...f,status:""}));setPage(1);}}]:[]),
     ...(active.origin?[{key:"origin",label:"来源 "+ (active.origin==="NATIVE"?"新平台":"旧平台"),onRemove:()=>{state.current.context=undefined;setFilters(f=>({...f,origin:""}));setActive(f=>({...f,origin:""}));setPage(1);}}]:[]),
     ...(active.from||active.to?[{key:"date",label:`下单 ${active.from||"不限"} 至 ${active.to||"不限"}`,onRemove:()=>{state.current.context=undefined;setFilters(f=>({...f,from:"",to:""}));setActive(f=>({...f,from:"",to:""}));setPage(1);}}]:[]),
   ]} />
 </ListToolbar>
 {notice?<p role="status">{notice}</p>:null}{error?<ErrorState error={error} retry={()=>setNonce(n=>n+1)}/>:!data?<div className="oc-empty" aria-busy="true">正在读取订单…</div>:<><div className="oc-results-head"><span>共 <strong>{data.total}</strong> 条 · 按下单时间倒序</span><small>状态、下单时间与页码保留在地址栏；查找线索与手机号不落 URL</small></div>{!data.items.length?<div className="oc-empty"><h2>当前筛选与授权范围内暂无订单</h2><p>调整查询线索，或联系权限管理员核对游戏范围。</p></div>:<><div className="oc-table-wrap"><table className="oc-table oc-table-compact"><thead><tr><th>订单 / 下单时间</th><th>资源账号</th><th>租客 → 号主</th><th>当前进度</th><th className="oc-amount">费用</th></tr></thead><tbody>{data.items.map(o=><tr key={o.id}>
 <td><button data-order-focus={o.id} className="oc-order-no" onClick={()=>open(o)}>{o.displayNo}</button><small>{time(o.createdAt)}</small></td>
 <td><EntityPreviewTrigger touchLabel={"预览账号 " + accountNumberLabel(o.accountDisplayNo)} trigger={canResource?<Link onClick={()=>resource(o)}>{accountNumberLabel(o.accountDisplayNo).replace(/^账号 /, "")}</Link>:<span>{accountNumberLabel(o.accountDisplayNo).replace(/^账号 /, "")}</span>} content={<AccountPreviewCard displayNo={o.accountDisplayNo} accountId={o.accountId} title={orderTitleText(o)} haffText={frozenHaff(o.frozenAccount)} materialsText={frozenMaterials(o.frozenAccount)} termText={frozenTerm(o.frozenAccount)} loginMethodText={o.frozenAccount?.loginMethodText??null} depositText={o.frozenAccount?.source==="ORDER_VERSION"&&o.amounts.deposit?money(o.amounts.deposit):null} depositLabel="本单租客押金" sourceText={o.frozenAccount?o.frozenAccount.source==="ORDER_VERSION"?"本单冻结版本":"历史账号参考":o.source.origin==="LEGACY"?"旧平台订单":"新平台订单"} canOpen={canResource} onOpen={()=>resource(o)} deniedReason="关联资源需要独立读取权限"/>}/><span className="oc-account-title">{orderTitleText(o)}</span>{o.frozenAccount?<span className="oc-account-title">{o.frozenAccount.source==="ORDER_VERSION"?"本单冻结":"历史账号参考"}：{frozenCompact(o.frozenAccount)}</span>:null}</td>
 <td>{(["renter","owner"] as const).map(role=>{const summary=role==="renter"?o.renterSummary:o.ownerSummary,name=role==="renter"?o.renterName:o.ownerName;return <div className="oc-party-line" key={role}><span className="oc-party-role">{partyLabel(o,role)}</span><EntityPreviewTrigger touchLabel={"预览"+(role==="renter"?"租客":"号主")+" "+name} trigger={canUser?<Link onClick={()=>related(o,role)}>{name}</Link>:<span>{name}</span>} content={<UserPreviewCard name={name} userId={role==="renter"?o.renterUserId:o.ownerUserId} image={summary?.image} maskedPhone={summary?.maskedPhone} currentName={summary?.name} businessNo={role==="renter"?o.renterBusinessNo:o.ownerBusinessNo} membershipSummary={summary?.membershipSummary} creditSummary={summary?.creditSummary} riskFlag={summary?.riskFlag} canOpen={canUser} onOpen={()=>related(o,role)} deniedReason="无用户目录权限"/>}/><small>{role==="renter"?o.renterBusinessNo:o.ownerBusinessNo}</small></div>;})}</td>
 <td><Stages order={o} progress={o.progress} variant="compact"/></td>
 <td className="oc-amount"><small className="text-muted-foreground">{feeLabel(o)}</small><strong>{feeAmountText(o)}</strong>{feeSplitLines(o).map((line,index)=><small key={index} className="oc-fee-line">{line}</small>)}</td>
</tr>)}</tbody></table></div><div className="oc-mobile-list">{data.items.map(o=><article key={o.id}><div><button data-order-focus={o.id} className="oc-order-no" onClick={()=>open(o)}>{o.displayNo}</button><span>{statusLabel[o.status]??"待核"}</span></div><h2>{orderTitleText(o)}</h2><p>{o.renterName} → {o.ownerName}</p><Stages order={o} progress={o.progress} variant="compact"/>{o.frozenAccount?<p className="text-xs text-muted-foreground">{o.frozenAccount.source==="ORDER_VERSION"?"本单冻结":"历史账号参考"}：{frozenCompact(o.frozenAccount)}</p>:null}<footer><span>{feeLabel(o)} {feeAmountText(o)} · {feeNoteText(o)}</span><Button size="sm" onClick={()=>open(o)}>查看详情</Button></footer></article>)}</div></>}
 <ListPagination mode="page" page={page} pageSize={size} total={data.total} loadedCount={data.items.length} loading={false} pageSizeOptions={ORDER_PAGE_SIZES} itemLabel="条订单" onPageChange={changePage} onPageSizeChange={changeSize}/>
 </>}
 </div>;
}
function Detail({snapshot,id,onOpenPath,refreshNonce,financeOrigin,financeReturn}:{snapshot:Snapshot;id:string;onOpenPath:(p:string,t?:string)=>void;refreshNonce:number;financeOrigin?:string;financeReturn?:string}){
 // A source-only navigation keeps this request alive; use its latest return context.
 const openPath=useRef(onOpenPath);openPath.current=(path,title)=>{const query=new URLSearchParams();if(financeOrigin)query.set('financeOrigin',financeOrigin);const fallback=sanitizeFinanceReturn(financeReturn);if(fallback)query.set('financeReturn',fallback);onOpenPath(path+(query.size?`?${query}`:''),title);};
 const [error,setError]=useState<string>(),[nonce,setNonce]=useState(0);
 const orderReadKey=JSON.stringify([id,keyOf(snapshot),refreshNonce,nonce]);
 const [loadedOrder,setLoadedOrder]=useState<{key:string;value:Order}>();
 const order=loadedOrder?.key===orderReadKey?loadedOrder.value:undefined;
 const [paymentSummary,setPaymentSummary]=useState<PaymentSummary|null>();
 const [refundSummary,setRefundSummary]=useState<RefundSummary|null>();
 const [fundsNonce,retryFunds]=useState(0),[teamNonce,retryTeam]=useState(0);
 const [funds,setFunds]=useState<{state:OrderSettlementReadState;evidence?:OrderSettlementEvidence;requestId?:string}>({state:'loading'});
 const [team,setTeam]=useState<{state:string;data?:{teamState:string|null;canRead:boolean;name?:string}}>({state:"loading"});
 useEffect(()=>{
  const controller=new AbortController();setLoadedOrder(undefined);setPaymentSummary(undefined);setRefundSummary(undefined);setError(undefined);
  void adminRequest<{order:Order;paymentSummary?:PaymentSummary|null;refundSummary?:RefundSummary|null}>(`/orders/${encodeURIComponent(id)}?readMode=combined`,undefined,"GET",{},controller.signal).then(value=>{   if(controller.signal.aborted)return;setLoadedOrder({key:orderReadKey,value:value.order});setPaymentSummary(value.paymentSummary);setRefundSummary(value.refundSummary);openPath.current(`/orders/${encodeURIComponent(id)}`,value.order.displayNo);
  }).catch(e=>{if(!controller.signal.aborted)setError(friendlyError(e));});return()=>controller.abort();
 },[id,keyOf(snapshot),refreshNonce,nonce]);
 useEffect(()=>{
  const controller=new AbortController();setFunds({state:'loading'});
  if(!snapshot.permissions.includes('finance.document.read')){setFunds({state:'forbidden'});return()=>controller.abort();}
  if(!order)return()=>controller.abort();
  const ref=(order.source.origin==='LEGACY'?'LEGACY_ORDER:':'ORDER:')+order.id;
  void financeRead(`documents/${encodeURIComponent(ref)}`,defaultFinanceFilters(false),controller.signal).then(data=>{
   if(controller.signal.aborted)return;
   if(data.document?.ref!==ref||data.orderSettlement&&(data.orderSettlement.documentRef!==ref||data.orderSettlement.schema!=='admin-order-settlement-evidence.v1'))throw new Error('ORDER_FINANCE_REFERENCE_MISMATCH');
   setFunds({state:'ready',evidence:data.orderSettlement});
  }).catch(e=>{if(!controller.signal.aborted)setFunds({state:e instanceof AdminApiError?e.status===403?'forbidden':e.status===404?'missing':e.status===409?'conflict':'unavailable':'unavailable',requestId:e instanceof AdminApiError?e.requestId:undefined});});
  return()=>controller.abort();
 },[order?.id,order?.source.origin,id,keyOf(snapshot),refreshNonce,fundsNonce]);
 useEffect(()=>{
  const controller=new AbortController();setTeam({state:"loading"});
  if(!order)return()=>controller.abort();
  if(order.source.origin==="LEGACY"){setTeam({state:"legacy"});return()=>controller.abort();}
  if(!snapshot.permissions.includes("im.support.read")){setTeam({state:"forbidden"});return()=>controller.abort();}
  void adminRequest<{teamState:string|null;canRead:boolean;name?:string}>(`/orders/${encodeURIComponent(id)}/im?operation=read`,undefined,"GET",{},controller.signal).then(data=>{
   if(!controller.signal.aborted)setTeam({state:"ready",data});
  }).catch(e=>{if(!controller.signal.aborted)setTeam({state:e instanceof AdminApiError&&e.status===403?"forbidden":e instanceof AdminApiError&&e.status===404?"missing":"unavailable"});});
  return()=>controller.abort();
 },[order?.id,id,keyOf(snapshot),refreshNonce,teamNonce]);
 const returnFinance=financeOriginPath(financeOrigin,snapshot,financeReturn);
 const back=<div className="flex flex-wrap gap-3">{returnFinance&&(snapshot.permissions.includes('finance.read')||snapshot.permissions.includes('finance.document.read'))?<Button variant="secondary" onClick={()=>onOpenPath(returnFinance)}>返回来源资金</Button>:null}<Button variant="secondary" onClick={()=>onOpenPath("/orders")}><ArrowLeft size={15}/>返回订单列表</Button></div>;
 if(error)return <>{back}<ErrorState error={error} retry={()=>setNonce(n=>n+1)}/></>;if(!order)return <>{back}<div className="oc-empty" aria-busy="true">正在读取订单主体…</div></>;
 function openFundsDocument(ref:string,title='资金凭证'){
  if(!snapshot.permissions.includes('finance.document.read')||!order)return;
  const source=`/orders/${encodeURIComponent(order.id)}`,origin=registerFinanceOrigin(source+(financeOrigin?`?financeOrigin=${encodeURIComponent(financeOrigin)}`:''),financeContextIdentity(snapshot));
  const fallback=sanitizeFinanceReturn(financeReturn)??sanitizeFinanceReturn(source);
  onOpenPath(`/finance/documents/${encodeURIComponent(ref)}?origin=${encodeURIComponent(origin)}${fallback?`&financeReturn=${encodeURIComponent(fallback)}`:''}`,title);
 }
 function relatedUserPath(userId:string){
  const query=new URLSearchParams({fromOrderId:order!.id});
  if(financeOrigin)query.set('financeOrigin',financeOrigin);
  const fallback=sanitizeFinanceReturn(financeReturn)??sanitizeFinanceReturn(returnFinance);
  if(fallback)query.set('financeReturn',fallback);
  return `/users/${encodeURIComponent(userId)}?${query}`;
 }
 const o=order,canUser=snapshot.security.isBoss||snapshot.permissions.includes("user.directory.read"),canResource=canUser&&(snapshot.security.isBoss||snapshot.permissions.includes("supply.rental_account.read"));
 const partySection=<section className="oc-section oc-related"><h2>本单账号和双方</h2><p className="oc-fact-note">本单冻结账号与双方</p><div className="oc-related-person"><small>资源账号</small>{canResource?<Link onClick={()=>onOpenPath(`/supply/accounts/${o.accountId}?fromOrderId=${o.id}`,accountNumberLabel(o.accountDisplayNo))}>{accountNumberLabel(o.accountDisplayNo)}</Link>:<span>关联资源需要独立读取权限</span>}</div>{(["renter","owner"] as const).map(role=><div className="oc-related-person" key={role}><small>{partyLabel(o,role)} · 编号 {role==="renter"?o.renterBusinessNo:o.ownerBusinessNo}</small>{canUser?<Link onClick={()=>onOpenPath(relatedUserPath(role==="renter"?o.renterUserId:o.ownerUserId),role==="renter"?o.renterName:o.ownerName)}>{role==="renter"?o.renterName:o.ownerName}</Link>:<span>{role==="renter"?o.renterName:o.ownerName}</span>}</div>)}{o.frozenAccount?<div className="oc-related-person"><small>本单冻结账号摘要 · {o.frozenAccount.source==="ORDER_VERSION"?"本单版本":"历史账号参考（非本单冻结）"}</small><p>{frozenText(o.frozenAccount)}</p></div>:null}<p className="oc-fact-note">当前账号资料不等于本单冻结摘要；订单、付款、结算、退款与群权限各自独立。</p></section>;
 const refundList=refundSummary?(refundSummary.integration==="FORBIDDEN"?<p className="oc-fact-note">当前无权读取退款明细；不能据此认定没有退款。</p>:refundSummary.integration==="NOT_APPLICABLE"?<p className="oc-fact-note">旧来源退款未接入本平台退款摘要；按原来源核对。</p>:refundSummary.integration==="INTEGRATED"?<>{refundSummary.intents?.length?<ul className="oc-refund-intents space-y-1 text-sm">{refundSummary.intents.map(intent=><li key={intent.intentId}><div><span>{intent.refundOrderNo} · 申请 {formatFundingCents(intent.amount.cents)}</span><small className="ml-2 text-xs text-muted-foreground">本地 {({READY:"待提交",SUBMITTING:"提交中",UNKNOWN:"结果未知",PROCESSING:"处理中",REVIEW_REQUIRED:"需人工复核",SUCCEEDED:"本地退款成功记录",FAILED:"本地失败"} as Record<string,string>)[intent.localState]??"状态待核"}{intent.requiresReview?" · 需复核":""}{intent.budgetDisposition==="CONSUMED"?" · 预算已用":intent.budgetDisposition==="RELEASED"?" · 预算释放":" · 预算分配待核"}</small></div><small className="ml-2 text-xs text-muted-foreground">覆盖：本笔本地退款意图；渠道到账未核定，不能升级为银行到账{intent.mayResubmit?" · 按原流程核对重提条件":" · 不重复提交"}</small></li>)}</ul>:<p className="oc-fact-note">已接入退款查询，当前没有本单退款记录；不能据此认定无需退款。</p>}<p className="oc-fact-note">退款责任来自结算依据，逐笔意图只证明本地范围；不把本地成功或受控状态当成渠道到账。</p></>:<p className="oc-fact-note">退款明细暂不可用；不能据此认定没有退款或已到账。</p>):<p className="oc-fact-note">本次未读取退款摘要；退款核对独立于订单主体。</p>;
 return <div className="oc-design">{back}<div className="oc-heading"><div><div className="oc-title-line"><h1>{o.displayNo}</h1><span>{statusLabel[o.status]??"状态待核"}</span></div><p>{accountNumberLabel(o.accountDisplayNo)} · {orderTitleText(o)}</p></div><span className="oc-scope">{o.source.origin==="LEGACY"?"旧平台订单":"新平台订单"}</span></div>
 <div className="oc-detail-grid"><main className="oc-main-facts">
<section className="oc-section"><h2>当前情况</h2><p className="oc-next-step"><strong>下一步：</strong>{nextStepText(o)}</p><Stages order={o} progress={o.progress} variant="detail"/><dl className="oc-fact-list"><dt>下单时间</dt><dd>{time(o.createdAt)}</dd><dt>支付记录</dt><dd>{paymentLabel(o)}</dd><dt>支付时间</dt><dd>{paymentTime(o)}</dd><dt>适用规则</dt><dd>{o.source.origin==="LEGACY"?"原订单来源与历史结果；不重算已完成旧单":"本单下单时确认的规则"}</dd></dl></section>
{partySection}
<section className="oc-section"><h2>关键费用</h2><div className="oc-money-list">
   <div><span>原资源合计</span><strong>{money(o.amounts.rental)}</strong></div>
   {o.prepaymentBreakdown?.haffRental?<div><span>哈夫租金（原冻结）</span><strong>{money(o.prepaymentBreakdown.haffRental)}</strong></div>:null}
   {o.prepaymentBreakdown?.materialsPrepay?<div><span>物资预付（原冻结）</span><strong>{money(o.prepaymentBreakdown.materialsPrepay)}</strong></div>:null}
   <div><span>租客实际冻结押金</span><strong>{money(o.amounts.deposit)}</strong></div>
   <div><span>{o.status==="CANCELLED"?"原单合计（已取消）":"原单合计"}</span><strong>{money(o.amounts.totalDue)}</strong></div>
   <div><span>实付记录</span><strong>{o.payment.state==="RECORDED_PAID"?money(o.payment.recordedAmount):paymentLabel(o)}</strong></div>
  </div><p className="oc-fact-note">{o.prepaymentBreakdown?(o.prepaymentBreakdown.completeness==="COMPLETE"?"预付拆分来自原冻结行，合计与服务端原单闭合。":"预付拆分"+o.prepaymentBreakdown.completeness+"；缺项保持未知，不从当前价目或会员补算。"):"本单未提供原冻结行拆分；资源合计仍按服务端原单显示。"} 实付记录不等于结算完成，应退记录不等于渠道到账。</p></section>

  <AdminOrderPaymentSummary summary={paymentSummary}/>{o.source.origin==="LEGACY"?<LegacyAdminContinuationPanel snapshot={snapshot} orderId={o.id} refreshNonce={refreshNonce}/>:null}
  <section className="oc-section"><h2>履约与处理记录</h2><ol className="oc-records"><li><FileText size={15}/><div><strong>订单创建</strong><small>{time(o.createdAt)}</small></div></li><li><CreditCard size={15}/><div><strong>{paymentLabel(o)}</strong><small>{paymentTime(o)}</small></div></li>{o.status==="CANCELLED"?<li><X size={15}/><div><strong>订单已取消</strong><small>{time(o.cancelledAt)}</small></div></li>:o.status==="COMPLETED"?<li><Flag size={15}/><div><strong>订单完成记录</strong><small>{time(o.completedAt)}</small></div></li>:null}</ol><p className="oc-fact-note">群存在、PAID 与订单更新时间都不等于开租或完成；完整节点见上方进度。</p></section>
<section className="oc-section"><h2>结算与退款</h2><p className="oc-fact-note">最终号主结算与平台贡献只来自已核财务凭证；未过账不填 0，渠道到账仍未知。</p><AdminOrderSettlementEvidence state={funds.state} evidence={funds.evidence} requestId={funds.requestId} paymentState={o.payment.state} onRetry={()=>retryFunds(n=>n+1)} onOpenDocument={openFundsDocument}/>
   <div className="oc-refund-summary"><h3 className="mt-3 text-sm font-semibold">退款记录</h3>{refundList}</div>
  </section>
<section className="oc-section"><h2>资金凭证与来源记录</h2><p className="oc-fact-note">资金凭证读取沿用独立权限；未取得渠道到账、退款出款或结算依据时保持未知。普通刷新只重读本地记录，未来渠道查询同步命令另行接入。</p><div className="flex flex-wrap gap-2">{snapshot.permissions.includes('finance.document.read')?<Button size="sm" variant="secondary" onClick={()=>openFundsDocument((o.source.origin==='LEGACY'?'LEGACY_ORDER:':'ORDER:')+o.id,`${o.displayNo} · 资金凭证`)}>查看资金凭证<ArrowUpRight size={14}/></Button>:null}</div><details className="oc-section oc-trace"><summary>来源与技术追溯</summary><p>订单ID：{o.id}</p><p>来源：{o.source.origin} · 游戏：{o.gameId}</p></details>
 </section>
</main><aside className="oc-related"><section className="oc-section"><h2>订单群</h2><p className="oc-fact-note">{team.state==="legacy"?"旧单没有新平台订单群映射。":team.state==="loading"?"正在独立核对本单群授权…":team.state==="forbidden"?"当前身份无权读取本单群；订单读取权限不包含群消息权限。":team.state==="missing"?"未找到可读取的本单群记录。":team.state==="ready"?team.data?.teamState==="READY"?team.data.canRead?"本单群已就绪，当前身份可进入核对。":"本单群已就绪，当前身份无消息访问权。":"本单群尚未就绪；群就绪不证明开租成功。":"本单群读取暂不可用，订单主体已读取。"}</p>
 {team.state==="unavailable"?<Button size="sm" variant="secondary" onClick={()=>retryTeam(n=>n+1)}>重试群读取</Button>:null}
 {snapshot.permissions.includes("im.support.read")&&team.state==="ready"&&team.data?.canRead?<Link onClick={()=>onOpenPath(`/support?fromOrderId=${o.id}&section=orders`)}>进入现有客服工作台</Link>:null}</section></aside></div></div>;
}
export function AdminOrderChainView({snapshot,initialOrderId,objectOnly,initialQuery,onOpenPath,onQueryChange,refreshNonce=0}:{snapshot:Snapshot;initialOrderId?:string;objectOnly?:boolean;initialQuery?:Record<string,string>;onOpenPath:(path:string,title?:string)=>void;onQueryChange:(q:Record<string,string>)=>void;refreshNonce?:number}){
 if(!snapshot.security.isBoss&&!snapshot.permissions.includes("order.read")){saved.clear();currentIdentity="";return <div className="oc-empty"><h1>当前没有订单查询权限</h1></div>;}
 const identity=keyOf(snapshot);if(currentIdentity!==identity){saved.clear();currentIdentity=identity;}return objectOnly&&initialOrderId?<Detail key={identity+initialOrderId} snapshot={snapshot} id={initialOrderId} onOpenPath={onOpenPath} refreshNonce={refreshNonce} financeOrigin={initialQuery?.financeOrigin} financeReturn={initialQuery?.financeReturn}/>:<OrderList key={identity} snapshot={snapshot} onOpenPath={onOpenPath} refreshNonce={refreshNonce} initialQuery={initialQuery} onQueryChange={onQueryChange}/>;
}
export function AdminResourceReadView({snapshot,accountId,fromOrderId,fromUserId,fromUserSection,fromUserPublication,onOpenPath,refreshNonce}:{snapshot:Snapshot;accountId:string;fromOrderId?:string;fromUserId?:string;fromUserSection?:string;fromUserPublication?:string;onOpenPath:(p:string,t?:string)=>void;refreshNonce:number}){
 const [data,setData]=useState<Record<string,any>>(),[error,setError]=useState<string>(),[nonce,setNonce]=useState(0);
 useEffect(()=>{const controller=new AbortController();setData(undefined);setError(undefined);void adminRequest<{account:Record<string,any>}>(`/users/resource-accounts/${encodeURIComponent(accountId)}`,undefined,"GET",{},controller.signal).then(v=>{if(!controller.signal.aborted)setData(v.account);}).catch(e=>{if(!controller.signal.aborted)setError(friendlyError(e));});return()=>controller.abort();},[accountId,keyOf(snapshot),refreshNonce,nonce]);
 const returnSection=fromUserSection==="overview"?"orders":["orders","resources","security"].includes(fromUserSection??"")?fromUserSection:"resources";
 return <div className="oc-design">{fromUserId&&/^[A-Za-z0-9._:-]{1,128}$/.test(fromUserId)?<button className="oc-back" onClick={()=>onOpenPath(`/users/${fromUserId}?section=${returnSection}${returnSection==="resources"&&fromUserPublication==="published"?"&publication=published":""}${fromOrderId?`&fromOrderId=${fromOrderId}`:""}`)}><ArrowLeft size={15}/>返回来源用户</button>:null}{fromOrderId&&/^[A-Za-z0-9._:-]{1,128}$/.test(fromOrderId)?<button className="oc-back" onClick={()=>onOpenPath(`/orders/${fromOrderId}`)}><ArrowLeft size={15}/>返回来源订单</button>:null}{error?<ErrorState error={error} retry={()=>setNonce(n=>n+1)}/>:!data?<div className="oc-empty" aria-busy="true">正在读取资源…</div>:<><div className="oc-heading"><div><h1>{accountNumberLabel(data.displayNo)}</h1><p>{data.publicBasis?.id ? `租客看到的版本 ${data.publicBasis.id}` : data.publicVisible === false ? "当前没有对外版本" : (data.title ?? "当前资料标题未提供")}</p></div></div>{resourcePublicBasis(data,snapshot,accountId,onOpenPath)}{data.historicalRead ? <section className="oc-section"><h2>历史来源显示资料</h2><p>{historicalReadSummary(data.historicalRead)}</p>{data.historicalRead.display?.state === "KNOWN" && data.historicalRead.display.facts?.attributes && Array.isArray(data.historicalRead.display.facts.resources) ? <><dl className="oc-fact-list">{historicalAttributeFacts(data.historicalRead).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><ul>{data.historicalRead.display.facts.resources.map((item: {code:string;name:string;quantity:string|null;unit:string}) => <li key={item.code}>{item.name}：{historicalResourceText(item)}</li>)}</ul><p className="oc-fact-note">来源记录更新于 {time(data.historicalRead.display.facts.sourceUpdatedAt)}。仅为历史显示量，不替代当前申报、报价或资格。</p></> : <p role={data.historicalRead.display?.state === "KNOWN" ? "alert" : "status"}>{data.historicalRead.display?.state === "KNOWN" ? "历史扩展资料返回不完整，请重试读取。" : "历史扩展资料尚待接入，不能认定资源数量为零。"}</p>}</section> : null}<section className="oc-section"><h2>资源核对</h2><dl className="oc-fact-list"><dt>游戏</dt><dd>{data.gameName}</dd><dt>当前号主</dt><dd><Link onClick={()=>onOpenPath(`/users/${data.ownerUserId}${fromOrderId?`?fromOrderId=${fromOrderId}`:""}`,data.ownerName)}>{data.ownerName}</Link></dd><dt>档案状态</dt><dd>{{ACTIVE:"有效",ARCHIVED:"已归档"}[String(data.lifecycle)]??"状态待核"}</dd><dt>号主暂停</dt><dd>{data.ownerPaused?"已暂停":"未暂停"}</dd><dt>运营限制</dt><dd>{data.staffRestricted?"已限制":"未限制"}</dd><dt>历史占用</dt><dd>{{NONE:"无",ACTIVE_LEGACY:"旧单承接中",UNRESOLVED:"待核对"}[String(data.legacyHold)]??"历史占用待核"}</dd><dt>当前资料版本</dt><dd>{data.versionId ?? "未提供"}</dd><dt>资料状态</dt><dd>{{DRAFT:"未发布",SUBMITTED:"审核中",WITHDRAWN:"已下架",REJECTED:"已驳回",IMPORTED_UNVERIFIED:"旧资料待核"}[String(data.versionState)]??"资料状态待核"}</dd></dl><p className="oc-fact-note">当前号主与历史订单号主分别保留。上述状态不单独证明当前可租。</p></section></>}</div>;
}
