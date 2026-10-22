import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { CalendarIcon } from 'lucide-react';
import { zhCN } from 'date-fns/locale';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import './membership-growth-view.css';

export type EntitlementMode = 'ordinary' | 'custom' | 'fast';
export type EntitlementKind = 'FRIEND' | 'PRESTIGE';
export type AdminEntitlementRange = {status:'CONFIGURED';kind:'TOTAL_DISCOUNT_RANGE';mode:EntitlementMode;priceVersionId:string;minPayableRatio:string;maxPayableRatio:string;costBasisRef:string};
export type AdminEntitlementRanges = Record<EntitlementKind,{byMode:Partial<Record<EntitlementMode,AdminEntitlementRange | {status:'NOT_PRICED';reason:string}>>}>;
export type AdminEntitlementDraft = {kind:EntitlementKind;scopeKey:string;startsAtUtc:string;endsAtUtc:string;pricingMode:EntitlementMode;priceVersionId:string;payableRatio:string;costBasisRef:string;depositWaived:boolean;reason:string};
export type MembershipEntitlementContext = {
  schema:'membership-entitlement-context.v1';
  subject:{userId:string;name:string|null;image:string|null;maskedPhone:string|null};
  game:{id:string;name:string};
  approvedMeta:{id:string;version:string;effectiveAtUtc:string;ruleReleaseId:string;priceVersionId:string;payloadHash:string;sourceRef:string}|null;
  ranges:AdminEntitlementRanges|null;
  rangeSource:'INDEPENDENT'|'LEGACY_TIER_CAP'|null;
  capability:{canRequest:boolean;reasonCode:'OK'|'FEATURE_DISABLED'|'POLICY_UNAVAILABLE'|'RANGE_UNAVAILABLE'};
  existingEntitlements:Array<{id:string;userId:string;userSummary:{name:string;image:string|null;maskedPhone:string|null}|null;gameId:string;gameName:string|null;kind:EntitlementKind;scopeKey:string;startsAtUtc:string;endsAtUtc:string;status:'PENDING'|'APPROVED_PENDING_EXECUTION'|'EXECUTED_PENDING_START'|'ACTIVE'|'EXPIRED'|'REPLACED'|'REVOKED';depositWaived:boolean;approvedPolicyId:string;approvalRequestId:string;pricingSummary:{knowledge:'KNOWN';kind:'TOTAL_DISCOUNT';mode:EntitlementMode;payableRatio:string}|{knowledge:'LEGACY';kind:'LEGACY'}|{knowledge:'UNKNOWN';kind:'UNKNOWN'}}>;
};
export const ENTITLEMENT_MODE_LABELS: Record<EntitlementMode,string> = {ordinary:'普通',custom:'自定义',fast:'极速'};
const RATIO_SCALE=100_000_000n;

/** Exact decimal text in (0,1]; no floating-point comparison at the allowance boundary. */
export function parsePayableRatio(value:string|undefined):bigint|null {
  if (typeof value!=='string' || !value || !/^(0|1)(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole='0',fraction='']=value.split('.');
  const parsed=BigInt(whole)*RATIO_SCALE+BigInt(fraction.padEnd(8,'0'));
  return parsed>0n&&parsed<=RATIO_SCALE?parsed:null;
}
export function formatEntitlementDiscount(payableRatio?:string):string {
  const ratio=parsePayableRatio(payableRatio);if(ratio===null)return '折扣待核';
  const discount=ratio*10n,fraction=(discount%RATIO_SCALE).toString().padStart(8,'0').replace(/0+$/,'');
  return `${discount/RATIO_SCALE}${fraction?'.'+fraction:''}折`;
}
export function utcToBeijingInput(value:string):string {
  if(typeof value!=='string'||!value)return '';
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(name:string)=>parts.find(part=>part.type===name)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function beijingInputToUtc(value:string):string {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return '';
  const date=new Date(`${value}:00+08:00`);
  return Number.isFinite(date.getTime())&&utcToBeijingInput(date.toISOString())===value?date.toISOString():'';
}
export function entitlementWindowError(start:string,end:string):string {
  if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))return '请填写北京时间起止';
  const duration=Date.parse(end)-Date.parse(start);
  return duration<=0||duration>90*86400000?'礼遇单次最多90天':'';
}

/** Calendar days are local Date objects, while the stored instant is explicitly Beijing time. */
export function MembershipDateTimeField({label,value,onChange,disabled=false}:{label:string;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[clock,setClock]=useState(utcToBeijingInput(value).slice(11)||'00:00');
  const local=utcToBeijingInput(value),day=local.slice(0,10);
  const selected=day?new Date(`${day}T00:00:00`):undefined;
  useEffect(()=>setClock(utcToBeijingInput(value).slice(11)||'00:00'),[value]);
  return <div className="membership-admin-control"><span>{label}（北京时间）</span><div className="membership-admin-date-time">
    <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" disabled={disabled} aria-label={`${label}日期`}/> }><CalendarIcon size={14}/>{day||'选择日期'}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={selected} defaultMonth={selected} locale={zhCN} disabled={disabled} onSelect={date=>{if(!disabled&&date){const dateText=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;onChange(beijingInputToUtc(`${dateText}T${clock}`));setOpen(false);}}}/></PopoverContent>
    </Popover>
    <Input type="time" aria-label={`${label}时间`} disabled={disabled} value={clock} onChange={event=>{setClock(event.target.value);if(day)onChange(beijingInputToUtc(`${day}T${event.target.value}`));}}/>
  </div></div>;
}

function initialDraft(context:MembershipEntitlementContext,initial?:AdminEntitlementDraft):AdminEntitlementDraft {
  const firstMode=(['ordinary','custom','fast'] as const).find(mode=>context.ranges?.FRIEND?.byMode[mode]?.status==='CONFIGURED')??'ordinary';
  return initial?{...initial}:{kind:'FRIEND',scopeKey:`game:${context.game.id}`,startsAtUtc:'',endsAtUtc:'',pricingMode:firstMode,priceVersionId:'',payableRatio:'',costBasisRef:'',depositWaived:false,reason:''};
}
export function MembershipEntitlementForm({context,initial,onSubmit,busy=false,error}:{context:MembershipEntitlementContext;initial?:AdminEntitlementDraft;onSubmit:(draft:AdminEntitlementDraft)=>void|Promise<void>;busy?:boolean;error?:string|null}) {
  const identity=JSON.stringify([context.subject.userId,context.game.id,context.approvedMeta?.id,context.approvedMeta?.payloadHash,context.rangeSource,initial]);
  return <EntitlementFields key={identity} context={context} initial={initial} onSubmit={onSubmit} busy={busy} error={error}/>;
}
function EntitlementFields({context,initial,onSubmit,busy,error}:ComponentProps<typeof MembershipEntitlementForm>) {
  const [draft,setDraft]=useState(()=>initialDraft(context,initial)),[pending,setPending]=useState(false),[submitError,setSubmitError]=useState('');
  const depositId=useId();
  const inFlight=useRef(false),locked=busy||pending;
  const entry=context.ranges?.[draft.kind]?.byMode[draft.pricingMode];
  const modes=(['ordinary','custom','fast'] as const).filter(mode=>context.ranges?.[draft.kind]?.byMode[mode]);
  const range=entry?.status==='CONFIGURED'?entry:null;
  const ratio=parsePayableRatio(draft.payableRatio),min=range?parsePayableRatio(range.minPayableRatio):null,max=range?parsePayableRatio(range.maxPayableRatio):null;
  const rangeReady=!!range&&min!==null&&max!==null&&min<=max&&range.mode===draft.pricingMode&&/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(range.costBasisRef)&&range.priceVersionId===context.approvedMeta?.priceVersionId;
  const outsideRange=ratio!==null&&min!==null&&max!==null&&(ratio<min||ratio>max);
  const ratioError=draft.payableRatio?(ratio===null?'应付比例须大于0且不超过1，最多8位小数':rangeReady&&outsideRange?'应付比例超出允许范围':''):'';
  const windowError=entitlementWindowError(draft.startsAtUtc,draft.endsAtUtc);
  const canSubmit=context.capability.canRequest&&context.capability.reasonCode==='OK'&&context.rangeSource!==null&&!!context.approvedMeta&&rangeReady&&ratio!==null&&!ratioError&&!windowError&&draft.reason.trim().length>=2&&draft.reason.trim().length<=500&&!locked&&!submitError;
  const capabilityText={OK:'',FEATURE_DISABLED:'礼遇功能尚未启用',POLICY_UNAVAILABLE:'暂无可用的已批准政策',RANGE_UNAVAILABLE:'礼遇范围未配置'}[context.capability.reasonCode];
  const update=(patch:Partial<AdminEntitlementDraft>)=>setDraft(current=>({...current,...patch}));
  return <form className="membership-admin-view membership-entitlement-form" onSubmit={async event=>{
    event.preventDefault();if(!canSubmit||!range||inFlight.current)return;
    inFlight.current=true;setPending(true);setSubmitError('');
    try{await onSubmit({...draft,scopeKey:initial?.scopeKey||`game:${context.game.id}`,priceVersionId:range.priceVersionId,costBasisRef:range.costBasisRef,reason:draft.reason.trim()});}
    catch{setSubmitError('提交结果未确认，请先查看审批记录。');}
    finally{inFlight.current=false;setPending(false);}
  }}>
    {error||submitError?<p className="membership-admin-form-error" role="alert">{error||submitError}</p>:null}
    {capabilityText?<p className="membership-admin-form-warning" role="status">{capabilityText}</p>:null}
    <div className="membership-admin-form-grid">
      <div className="membership-admin-control"><span>礼遇类型</span><Select value={draft.kind} disabled={locked||!!initial} onValueChange={value=>{if(value)update({kind:value as EntitlementKind,payableRatio:''});}}><SelectTrigger aria-label="礼遇类型"><SelectValue>{{FRIEND:'挚友礼遇',PRESTIGE:'尊享礼遇'}[draft.kind]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="FRIEND">挚友礼遇</SelectItem><SelectItem value="PRESTIGE">尊享礼遇</SelectItem></SelectContent></Select></div>
      <div className="membership-admin-control"><span>计价模式</span><Select value={draft.pricingMode} disabled={locked||!modes.length} onValueChange={value=>{if(value)update({pricingMode:value as EntitlementMode,payableRatio:''});}}><SelectTrigger aria-label="计价模式"><SelectValue>{ENTITLEMENT_MODE_LABELS[draft.pricingMode]}</SelectValue></SelectTrigger><SelectContent>{modes.map(mode=><SelectItem key={mode} value={mode} disabled={context.ranges?.[draft.kind]?.byMode[mode]?.status!=='CONFIGURED'}>{ENTITLEMENT_MODE_LABELS[mode]}</SelectItem>)}</SelectContent></Select></div>
      <label className="membership-admin-control"><span>实际应付比例</span><Input aria-label="礼遇应付比例" inputMode="decimal" disabled={locked||!rangeReady} value={draft.payableRatio} placeholder="如 0.9" aria-invalid={!!ratioError} onChange={event=>update({payableRatio:event.target.value})}/></label>
      <div className="membership-admin-wide membership-admin-range-hint"><Badge variant={context.rangeSource==='INDEPENDENT'?'secondary':'outline'}>{context.rangeSource==='INDEPENDENT'?'独立配置':context.rangeSource==='LEGACY_TIER_CAP'?'沿用旧政策':'范围待配置'}</Badge><span>{rangeReady?`可设 ${formatEntitlementDiscount(range!.minPayableRatio)}${min===max?'':`–${formatEntitlementDiscount(range!.maxPayableRatio)}`}，0.9 表示九折。`:'该类型或模式暂无可用折扣范围。'}</span></div>
      {ratioError?<p className="membership-admin-form-error membership-admin-wide" role="alert">{ratioError}</p>:null}
      <MembershipDateTimeField label="开始" value={draft.startsAtUtc} disabled={locked} onChange={value=>update({startsAtUtc:value})}/>
      <MembershipDateTimeField label="结束" value={draft.endsAtUtc} disabled={locked} onChange={value=>update({endsAtUtc:value})}/>
      <div className="membership-admin-control"><span>押金权益</span><div className="membership-admin-checkbox"><Checkbox id={depositId} checked={draft.depositWaived} disabled={locked} onCheckedChange={checked=>update({depositWaived:checked===true})} aria-label="独立授予免押"/><label htmlFor={depositId}>独立授予免押</label></div></div>
      {draft.startsAtUtc&&draft.endsAtUtc&&windowError?<p className="membership-admin-form-error membership-admin-wide" role="alert">{windowError}</p>:null}
      <label className="membership-admin-control membership-admin-wide"><span>申请原因</span><Textarea aria-label="礼遇原因" value={draft.reason} disabled={locked} maxLength={500} placeholder="说明本次礼遇的办理原因" onChange={event=>update({reason:event.target.value})}/></label>
    </div>
    <div className="membership-admin-action-row"><Button type="submit" disabled={!canSubmit}>{locked?'正在提交…':'提交礼遇审批'}</Button><span className="membership-admin-muted">单次最多90天，批准后需执行才会生效。</span></div>
  </form>;
}
