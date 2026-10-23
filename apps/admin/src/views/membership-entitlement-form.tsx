import { useEffect, useRef, useState, type CSSProperties, type ComponentProps, type ReactNode } from 'react';
import { beijingCalendarDate } from '@/workspace/beijing-time';
import { CalendarIcon, CircleHelp, Clock, FileText, ShieldCheck, Sparkles } from 'lucide-react';
import { zhCN } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { UnifiedRangeProjection } from './membership-unified-contract';
import './membership-growth-view.css';

export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" aria-label={label} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}
        >
          <CircleHelp size={13} aria-hidden />
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export type EntitlementMode = 'ordinary' | 'custom' | 'fast';
export type EntitlementKind = 'FRIEND' | 'PRESTIGE';
export type AdminEntitlementRange = {status:'CONFIGURED';kind:'TOTAL_DISCOUNT_RANGE';mode:EntitlementMode;priceVersionId:string;minPayableRatio:string;maxPayableRatio:string;costBasisRef:string};
export type AdminEntitlementRanges = Record<EntitlementKind,{byMode:Partial<Record<EntitlementMode,AdminEntitlementRange | {status:'NOT_PRICED';reason:string}>>}>;
export type AdminEntitlementDraft = {
  kind: EntitlementKind;
  scopeKey: string;
  startsAtUtc: string;
  endsAtUtc: string;
  /** Legacy compatibility only; unified grants never submit a mode. */
  pricingMode?: EntitlementMode;
  priceVersionId: string;
  payableRatio: string;
  costBasisRef: string;
  depositWaived: boolean;
  depositAllowanceCents?: string;
  reason: string;
};
export type MembershipEntitlementContext = {
  schema:'membership-entitlement-context.v1';
  pricingScope?:'ALL_ENABLED_RENTAL_MODES';
  subject:{userId:string;name:string|null;image:string|null;maskedPhone:string|null};
  game:{id:string;name:string};
  approvedMeta:{id:string;version:string;effectiveAtUtc:string;ruleReleaseId:string;priceVersionId:string;payloadHash:string;sourceRef:string}|null;
  ranges:AdminEntitlementRanges|null;
  unifiedRanges?:Record<EntitlementKind,UnifiedRangeProjection>;
  rangeSource:'INDEPENDENT'|'LEGACY_TIER_CAP'|null;
  capability:{canRequest:boolean;reasonCode:'OK'|'FEATURE_DISABLED'|'POLICY_UNAVAILABLE'|'RANGE_UNAVAILABLE'|'UNIFIED_RANGE_REQUIRED';unifiedPricingSupported?:boolean;requiresUnifiedPricing?:boolean};
  existingEntitlements:Array<{id:string;userId:string;userSummary:{name:string;image:string|null;maskedPhone:string|null}|null;gameId:string;gameName:string|null;kind:EntitlementKind;scopeKey:string;startsAtUtc:string;endsAtUtc:string;status:'PENDING'|'APPROVED_PENDING_EXECUTION'|'EXECUTED_PENDING_START'|'ACTIVE'|'EXPIRED'|'REPLACED'|'REVOKED';depositWaived:boolean;depositAllowanceCents?:string;approvedPolicyId:string;approvalRequestId:string;pricingSummary:{knowledge:'KNOWN';kind:'TOTAL_DISCOUNT';scope?:'ALL_ENABLED_RENTAL_MODES';mode?:EntitlementMode;payableRatio:string}|{knowledge:'LEGACY';kind:'LEGACY'}|{knowledge:'UNKNOWN';kind:'UNKNOWN'}}>;
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
  if(ratio===RATIO_SCALE)return '原价';
  const discount=ratio*10n,fraction=(discount%RATIO_SCALE).toString().padStart(8,'0').replace(/0+$/,'');
  return `${discount/RATIO_SCALE}${fraction?'.'+fraction:''}折`;
}
export function formatDiscountLabel(payableRatio?:string):string {
  return formatEntitlementDiscount(payableRatio);
}
export function formatDiscountRangeLabel(min?:string,max?:string):string {
  const left=formatDiscountLabel(min),right=formatDiscountLabel(max);
  return left==='原价'&&right==='原价'?'原价':`${left} – ${right}`;
}
/** Strict RMB yuan string to integer cents string without float: "200" -> "20000", "0" -> "0". */
export function parseYuanToCents(yuan: string | undefined): string | null {
  if (typeof yuan !== 'string') return null;
  const trimmed = yuan.trim();
  if (!trimmed || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents.toString();
}
/** Strict integer cents string to yuan text: "20000" -> "200", "0" -> "0". */
export function formatCentsToYuan(cents: string | undefined): string {
  if (!cents || !/^(0|[1-9]\d*)$/.test(cents)) return '0';
  const val = BigInt(cents);
  const whole = val / 100n;
  const rem = val % 100n;
  if (rem === 0n) return whole.toString();
  const frac = rem.toString().padStart(2, '0').replace(/0$/, '');
  return `${whole}.${frac}`;
}
export function formatDepositBenefitText(depositWaived: boolean, depositAllowanceCents?: string): string {
  if (depositWaived) return '完全免除押金';
  if (depositAllowanceCents && depositAllowanceCents !== '0' && /^[1-9]\d*$/.test(depositAllowanceCents)) {
    return `减免押金 ¥${formatCentsToYuan(depositAllowanceCents)} 元`;
  }
  return '不减免押金';
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
export function membershipCalendarToday(now = new Date()): Date {
  return new Date(`${beijingCalendarDate(now)}T00:00:00`);
}
export function MembershipDateTimeField({label,value,onChange,disabled=false}:{label:string;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[clock,setClock]=useState(utcToBeijingInput(value).slice(11)||'00:00');
  const local=utcToBeijingInput(value),day=local.slice(0,10);
  const selected=day?new Date(`${day}T00:00:00`):undefined;
  const today=membershipCalendarToday();
  useEffect(()=>setClock(utcToBeijingInput(value).slice(11)||'00:00'),[value]);
  return (
    <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}（北京时间）</span>
      <div className="relative">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={`${label}日期`}
              className={cn(
                "h-9 w-full justify-between text-xs font-normal bg-background hover:bg-muted/40 border-input px-3",
                !day && "text-muted-foreground"
              )}
            />
          }>
            <div className="flex items-center gap-2">
              <CalendarIcon size={14} className="text-muted-foreground/80 shrink-0" />
              <span className="tabular-nums font-mono">{day || '选择日期'}</span>
            </div>
            <div className="flex items-center gap-1.5 pl-2.5 border-l border-border/80 text-foreground font-mono">
              <Clock size={13} className="shrink-0 text-muted-foreground" />
              <span className="tabular-nums">{clock || '00:00'}</span>
            </div>
          </PopoverTrigger>
          <PopoverContent className="membership-datetime-popover w-auto p-0 shadow-xl border border-border" align="start">
            <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-border">
              <div className="p-1">
                <Calendar
                  mode="single"
                  selected={selected}
                  defaultMonth={selected ?? today}
                  today={today}
                  locale={zhCN}
                  disabled={disabled}
                  style={{ "--cell-size": "2.5rem" } as CSSProperties}
                  onSelect={date => {
                    if (!disabled && date) {
                      const dateText = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                      onChange(beijingInputToUtc(`${dateText}T${clock}`));
                    }
                  }}
                />
              </div>
              <div className="p-3.5 flex flex-col justify-between w-48 bg-muted/20">
                <div className="space-y-3">
                  <div className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                    <Clock size={13} className="text-primary" />
                    <span>选择时间</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">时</span>
                      <Select
                        value={clock.slice(0, 2) || '00'}
                        disabled={disabled}
                        onValueChange={h => {
                          const newClock = `${h}:${clock.slice(3, 5) || '00'}`;
                          setClock(newClock);
                          if (day) onChange(beijingInputToUtc(`${day}T${newClock}`));
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs font-mono bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-48 min-w-20">
                          {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(h => (
                            <SelectItem key={h} value={h} className="text-xs font-mono">{h}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">分</span>
                      <Select
                        value={clock.slice(3, 5) || '00'}
                        disabled={disabled}
                        onValueChange={m => {
                          const newClock = `${clock.slice(0, 2) || '00'}:${m}`;
                          setClock(newClock);
                          if (day) onChange(beijingInputToUtc(`${day}T${newClock}`));
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs font-mono bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-48 min-w-20">
                          {['00', '15', '30', '45', '59'].map(m => (
                            <SelectItem key={m} value={m} className="text-xs font-mono">{m}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border/60">
                    <span className="text-[10px] text-muted-foreground block mb-1.5">常用时段快捷</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { label: '00:00 (起点)', val: '00:00' },
                        { label: '12:00 (正午)', val: '12:00' },
                        { label: '18:00 (晚间)', val: '18:00' },
                        { label: '23:59 (终点)', val: '23:59' },
                      ].map(preset => (
                        <Button
                          key={preset.val}
                          type="button"
                          variant={clock === preset.val ? 'secondary' : 'ghost'}
                          size="xs"
                          disabled={disabled}
                          className="h-6 text-[10px] font-mono justify-center"
                          onClick={() => {
                            setClock(preset.val);
                            if (day) onChange(beijingInputToUtc(`${day}T${preset.val}`));
                          }}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="w-full mt-3 h-7 text-xs"
                  onClick={() => setOpen(false)}
                >
                  确定
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <input
          type="time"
          aria-label={`${label}时间`}
          disabled={disabled}
          value={clock}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={event => {
            setClock(event.target.value);
            if (day) onChange(beijingInputToUtc(`${day}T${event.target.value}`));
          }}
        />
      </div>
    </div>
  );
}

function initialDraft(context:MembershipEntitlementContext,initial?:AdminEntitlementDraft):AdminEntitlementDraft {
  return initial?{...initial}:{kind:'FRIEND',scopeKey:`game:${context.game.id}`,startsAtUtc:'',endsAtUtc:'',priceVersionId:'',payableRatio:'',costBasisRef:'',depositWaived:false,reason:''};
}
export function MembershipEntitlementForm({context,initial,onSubmit,busy=false,error}:{context:MembershipEntitlementContext;initial?:AdminEntitlementDraft;onSubmit:(draft:AdminEntitlementDraft)=>void|Promise<void>;busy?:boolean;error?:string|null}) {
  const identity=JSON.stringify([context.subject.userId,context.game.id,context.approvedMeta?.id,context.approvedMeta?.payloadHash,context.rangeSource,context.pricingScope,context.unifiedRanges?.FRIEND,context.unifiedRanges?.PRESTIGE,context.capability.unifiedPricingSupported,initial]);
  return <EntitlementFields key={identity} context={context} initial={initial} onSubmit={onSubmit} busy={busy} error={error}/>;
}
function EntitlementFields({context,initial,onSubmit,busy,error}:ComponentProps<typeof MembershipEntitlementForm>) {
  const [draft,setDraft]=useState(()=>initialDraft(context,initial)),[pending,setPending]=useState(false),[submitError,setSubmitError]=useState('');
  const [depositMode, setDepositMode] = useState<'none' | 'allowance' | 'waived'>(() =>
    draft.depositWaived ? 'waived' : (draft.depositAllowanceCents && draft.depositAllowanceCents !== '0' ? 'allowance' : 'none')
  );
  const [allowanceYuan, setAllowanceYuan] = useState(() => draft.depositAllowanceCents && draft.depositAllowanceCents !== '0' ? formatCentsToYuan(draft.depositAllowanceCents) : '');
  const inFlight=useRef(false),locked=busy||pending;
  const unifiedRange=context.unifiedRanges?.[draft.kind];
  const range=unifiedRange?.knowledge==='KNOWN'?unifiedRange:null;
  const ratio=parsePayableRatio(draft.payableRatio),min=range?parsePayableRatio(range.minPayableRatio??''):null,max=range?parsePayableRatio(range.maxPayableRatio??''):null;
  const unifiedPending=context.capability.unifiedPricingSupported===false||!context.unifiedRanges;
  const rangeReady=!!range&&min!==null&&max!==null&&min<=max&&!!range.priceVersionId&&!!range.costBasisRef&&range.priceVersionId===context.approvedMeta?.priceVersionId&&!unifiedPending;
  const outsideRange=ratio!==null&&min!==null&&max!==null&&(ratio<min||ratio>max);
  const ratioError=draft.payableRatio?(ratio===null?'应付比例须大于0且不超过1，最多8位小数':rangeReady&&outsideRange?'应付比例超出允许范围':''):'';
  const windowError=entitlementWindowError(draft.startsAtUtc,draft.endsAtUtc);
  const allowanceValid = depositMode !== 'allowance' || (/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(allowanceYuan.trim()) && parseYuanToCents(allowanceYuan) !== '0');
  const allowanceError = depositMode === 'allowance' && !allowanceValid ? '押金减免额度须为大于0的合法金额（最多2位小数）' : '';
  const depositConflict = draft.depositWaived && Boolean(draft.depositAllowanceCents && draft.depositAllowanceCents !== '0');
  const canSubmit=context.capability.canRequest&&context.capability.reasonCode==='OK'&&!unifiedPending&&!!context.approvedMeta&&rangeReady&&ratio!==null&&!ratioError&&!windowError&&!allowanceError&&!depositConflict&&draft.reason.trim().length>=2&&draft.reason.trim().length<=500&&!locked&&!submitError;
  const capabilityText={OK:'',FEATURE_DISABLED:'礼遇功能尚未启用',POLICY_UNAVAILABLE:'暂无可用的已批准政策',RANGE_UNAVAILABLE:'礼遇范围未配置',UNIFIED_RANGE_REQUIRED:'当前旧范围尚未统一，请先调整政策并审批'}[context.capability.reasonCode];
  const unifiedPendingText=unifiedPending?'当前礼遇办理暂不可用，请稍后再试。':'';
  const update=(patch:Partial<AdminEntitlementDraft>)=>setDraft(current=>({...current,...patch}));
  return <form className="membership-admin-view membership-entitlement-form" onSubmit={async event=>{
    event.preventDefault();if(!canSubmit||!range||inFlight.current)return;
    inFlight.current=true;setPending(true);setSubmitError('');
    try{
      await onSubmit({
        kind: draft.kind,
        scopeKey: initial?.scopeKey||`game:${context.game.id}`,
        startsAtUtc: draft.startsAtUtc,
        endsAtUtc: draft.endsAtUtc,
        priceVersionId: range.priceVersionId!,
        payableRatio: draft.payableRatio,
        costBasisRef: range.costBasisRef!,
        depositWaived: draft.depositWaived,
        depositAllowanceCents: draft.depositWaived ? '0' : (draft.depositAllowanceCents ?? '0'),
        reason: draft.reason.trim()
      });
    }
    catch{setSubmitError('提交结果未确认，请先查看审批记录。');}
    finally{inFlight.current=false;setPending(false);}
  }}>
    {error||submitError?<p className="membership-admin-form-error" role="alert">{error||submitError}</p>:null}
    {unifiedPendingText?<p className="membership-admin-form-warning" role="status">{unifiedPendingText}</p>:null}
    {capabilityText?<p className="membership-admin-form-warning" role="status">{capabilityText}</p>:null}
    <div className="space-y-3">
      {/* 2x2 Bento Box Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
        {/* Bento 1: 礼遇方案与定价折扣 */}
        <div className="rounded-xl border border-border/70 bg-card/40 p-3 flex flex-col justify-between space-y-3 shadow-none">
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-border/40">
              <div className="size-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                <Sparkles className="size-3.5" />
              </div>
              <span className="text-xs font-semibold text-foreground">礼遇方案与定价</span>
              <InfoHint label="礼遇折扣说明">统一总价折扣，适用于全部已启用租赁方式；0.95 = 实付 95%，1 = 原价。</InfoHint>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                <span>礼遇类型</span>
                <Select value={draft.kind} disabled={locked || !!initial} onValueChange={value => { if (value) update({ kind: value as EntitlementKind, payableRatio: '' }); }}>
                  <SelectTrigger aria-label="礼遇类型" className="h-9 w-full text-xs font-normal bg-background">
                    <SelectValue>{{ FRIEND: '挚友礼遇', PRESTIGE: '尊享礼遇' }[draft.kind]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="min-w-44">
                    <SelectItem value="FRIEND">挚友礼遇</SelectItem>
                    <SelectItem value="PRESTIGE">尊享礼遇</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                <span className="flex items-center gap-1">折扣（实付比例）<InfoHint label="折扣输入说明">输入 0–1 的小数：0.8 表示实付 80%（8 折）。</InfoHint></span>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="礼遇应付比例"
                    inputMode="decimal"
                    disabled={locked || !rangeReady}
                    value={draft.payableRatio}
                    placeholder="如 0.8"
                    aria-invalid={!!ratioError}
                    onChange={event => update({ payableRatio: event.target.value })}
                    className="h-9 flex-1 text-xs font-mono font-medium bg-background"
                  />
                  <Badge
                    variant={draft.payableRatio && !ratioError ? "secondary" : "outline"}
                    className={cn(
                      "text-xs font-mono shrink-0 px-2.5 py-1",
                      draft.payableRatio && !ratioError && "bg-primary/15 text-primary border-primary/25 font-semibold"
                    )}
                  >
                    {draft.payableRatio ? formatDiscountLabel(draft.payableRatio) : "待填写"}
                  </Badge>
                </div>
              </div>
            </div>

            {ratioError ? (
              <p className="text-xs text-destructive font-medium" role="alert">{ratioError}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {rangeReady ? `可选 ${min === max ? formatDiscountLabel(range!.minPayableRatio ?? '') : formatDiscountRangeLabel(range!.minPayableRatio ?? '', range!.maxPayableRatio ?? '')}` : unifiedPending ? '统一范围待 API 接入' : '该礼遇类型尚未统一，请先调整政策并审批'}
              </p>
            )}
          </div>
        </div>

        {/* Bento 2: 押金减免与策略 */}
        <div className="rounded-xl border border-border/70 bg-card/40 p-3 flex flex-col justify-between space-y-3 shadow-none">
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-border/40">
              <div className="size-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                <ShieldCheck className="size-3.5" />
              </div>
              <span className="text-xs font-semibold text-foreground">押金减免策略</span>
              <InfoHint label="押金减免说明">按账号原押金减免，最高有效额度不累加；完全免押优先。</InfoHint>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                <span>减免方式</span>
                <Select value={depositMode} disabled={locked} onValueChange={value => {
                  const mode = (value ?? 'none') as 'none' | 'allowance' | 'waived';
                  setDepositMode(mode);
                  if (mode === 'waived') {
                    update({ depositWaived: true, depositAllowanceCents: '0' });
                    setAllowanceYuan('');
                  } else if (mode === 'allowance') {
                    const cents = parseYuanToCents(allowanceYuan) ?? '0';
                    update({ depositWaived: false, depositAllowanceCents: cents });
                  } else {
                    update({ depositWaived: false, depositAllowanceCents: '0' });
                    setAllowanceYuan('');
                  }
                }}>
                  <SelectTrigger aria-label="押金减免方式" className="h-9 w-full text-xs font-normal bg-background">
                    <SelectValue>{{ none: '不减免', allowance: '按额度减免', waived: '完全免押' }[depositMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="min-w-44">
                    <SelectItem value="none">不减免</SelectItem>
                    <SelectItem value="allowance">按额度减免</SelectItem>
                    <SelectItem value="waived">完全免押</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {depositMode === 'allowance' ? (
                <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                  <span>最高减免额度（元）</span>
                  <div className="relative flex items-center">
                    <span className="absolute left-2.5 text-xs text-muted-foreground">￥</span>
                    <Input
                      aria-label="押金减免额度"
                      inputMode="decimal"
                      disabled={locked}
                      value={allowanceYuan}
                      placeholder="如 200"
                      onChange={event => {
                        const text = event.target.value;
                        setAllowanceYuan(text);
                        const cents = parseYuanToCents(text);
                        update({ depositAllowanceCents: cents ?? '0', depositWaived: false });
                      }}
                      className="h-9 pl-7 text-xs font-mono font-medium bg-background"
                    />
                  </div>
                  {allowanceError ? (
                    <p className="text-xs text-destructive font-medium mt-0.5" role="alert">{allowanceError}</p>
                  ) : null}
                </div>
              ) : (
                <p className="self-center text-[11px] text-muted-foreground">
                  {depositMode === 'waived' ? '租客押金全免；实缴以报价为准。' : '按账号原押金全额收取。'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Bento 3: 期限与生效时段 */}
        <div className="rounded-xl border border-border/70 bg-card/40 p-3 flex flex-col justify-between space-y-3 shadow-none">
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-border/40">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                  <Clock className="size-3.5" />
                </div>
                <span className="text-xs font-semibold text-foreground">期限与生效时段</span>
              </div>
            </div>

            <div className="space-y-3">
              <MembershipDateTimeField label="开始" value={draft.startsAtUtc} disabled={locked} onChange={value => update({ startsAtUtc: value })} />
              <MembershipDateTimeField label="结束" value={draft.endsAtUtc} disabled={locked} onChange={value => update({ endsAtUtc: value })} />
              {draft.startsAtUtc && draft.endsAtUtc && windowError ? (
                <p className="text-xs text-destructive font-medium" role="alert">{windowError}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground pt-0.5">
                  北京时间 · 单次生效上限 90 天
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Bento 4: 申请原因与合规留痕 */}
        <div className="rounded-xl border border-border/70 bg-card/40 p-3 flex flex-col justify-between space-y-3 shadow-none">
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-border/40">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                  <FileText className="size-3.5" />
                </div>
                <label className="text-xs font-semibold text-foreground">申请原因（必填）</label>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{draft.reason.trim().length} / 500 字</span>
            </div>

            <Textarea
              aria-label="礼遇原因"
              value={draft.reason}
              disabled={locked}
              maxLength={500}
              placeholder="说明本次礼遇的办理原因与业务背景..."
              onChange={event => update({ reason: event.target.value })}
              className="min-h-[72px] text-xs leading-relaxed bg-background resize-none"
            />
          </div>
        </div>
      </div>
    </div>
    <div className="membership-admin-action-row flex items-center justify-between pt-2 border-t border-border/80">
      <Button type="submit" disabled={!canSubmit} className="h-9 px-6 font-medium shadow-sm">
        {locked ? '正在提交…' : '提交礼遇审批'}
      </Button>
      {error && /状态|冲突|刷新/.test(error) ? <span className="text-xs text-destructive">请关闭并重新打开办理窗口后重试。</span> : null}
    </div>
  </form>;
}
