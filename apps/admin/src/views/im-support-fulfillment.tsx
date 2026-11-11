"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ClipboardList, Info, RefreshCw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { AdminApiError, friendlyError } from "../api";
import { formatDateTime } from "./im-support-format";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { ConfirmAlertDialog } from "../components/ui/alert-dialog";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardDescription, CardTitle } from "../components/ui/card";
import { SupportPoststartCancelCard } from "./support-poststart-cancel";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "../components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { formatFundingCents } from "./supply-review/model";
import { SupplyWriteLockError, withSupplyWriteLock } from "../lib/supply-write-lock";
import {
  buildFulfillmentIntent,
  readOrderSettlement,
  readSupportCancel,
  readSupportUnpaidCancel,
  retryAutomaticOpening,
  sendFulfillmentIntent,
  sendProgressReminder,
  sendSupportCancel,
  sendSupportUnpaidCancel,
  type EarlyEndReason,
  type FulfillmentIntent,
  type SettlementReadView,
  type SupportCancelView,
  type SupportUnpaidCancelView,
} from "../lib/order-fulfillment-client";

type InventoryLine = { itemId: string; quantity: string; unit: string; pricingKind: string; name: string | null };
type LineDraft = { itemId: string; name: string | null; unit: string; value: string };
type PreviewState = {
  amounts: Record<string, unknown> | null;
  versionHash: string | null;
  early: boolean | null;
  adjustArmed: boolean;
};
type IntentPhase = "IDLE" | "SENDING" | "UNKNOWN" | "AUTH" | "ACCEPTED_READBACK_PENDING";
type FulfillmentReadState = "idle" | "ok" | "unavailable" | "forbidden" | "auth" | "unknown";
type PersistedIntent = { subject: string; intent: FulfillmentIntent; accepted?: boolean };
const ACCEPTED_STORAGE_WARNING = "操作已受理，但本地无法保存恢复状态；不会重复提交。请勿刷新或离开页面，先查看当前状态或联系维护处理。";
const SETTLEMENT_REASON_LABELS:Record<string,string>={
  DISCOUNT_OWNER_FUNDING_INSUFFICIENT:"折后实际消耗不足以覆盖号主应得，暂不能结算；请联系双方线下协调并记录处理情况。",
  INSUFFICIENT_PREPAYMENT:"本单实付不足以覆盖结算费用，请核对数量并与双方沟通。",
  SETTLEMENT_PRICING_INVALID:"本单冻结价格资料无法核实，请联系维护人员。",
  ORDER_PARTY_UNAVAILABLE:"订单一方账号当前不可用，请核实身份和资金状态后处理。",
};
/** 自动开租资料不足时只解释原因，不提供伪造清单的入口。 */
const OPENING_REVIEW_REASONS:Record<string,string>={
  PAYMENT_BASIS_MISSING:"付款接纳依据缺失，不能据此生成开租清单。",
  ORDER_NOT_PAID:"订单当前不是已付款可开租状态。",
  QUOTE_BASIS_INVALID:"本单冻结报价或资源清单不完整。",
  LEGACY_V1_QUOTE_REVIEW:"旧版建单缺少个性化资金/包赔依据，不能自动生成开租清单；请按未开租取消退款或使用新版下单。",
  GENERATION_FAILED:"自动生成开租清单时发生数据库错误，付款已保留，请核对后重试或按未开租处理。",
  GENERATION_RECORD_MISSING:"自动开租记录写入失败，付款已保留；请重新核对开租依据，或按未开租取消退款。",
  "42P01":"自动开租表未安装，付款已保留；请完成迁移后重新核对。",
  "42501":"自动开租权限不足，付款已保留；请核对运行角色权限后重新核对。",
  "55P03":"自动开租遇到锁冲突，付款已保留；请稍后重新核对。",
  FULL_PAYOUT_UNKNOWN:"全额包赔或资金依据不完整。",
  SETTLEMENT_PRICING_INVALID:"冻结价格资料无法核实。",
  OPENING_QUANTITY_MISMATCH:"开租数量与冻结报价不一致。",
  AUTO_CONFIRM_POLICY_UNAVAILABLE:"自动确认配置暂不可用。",
};
function openingReviewText(reason:string|null|undefined):string{
  return reason&&OPENING_REVIEW_REASONS[reason]?OPENING_REVIEW_REASONS[reason]!:"开租资料待人工核对，暂不能生成清单。";
}
const REMINDER_REASON_TEXT:Record<string,string>={
  ORDER_NOT_ACTIVE:"订单已结束或不在可提醒阶段，未发送消息。",
  OPENING_MISSING:"本单尚无开租清单，请先核对付款与开租资料。",
  OPENING_REVIEW_REQUIRED:"本单开租资料待核对，暂不能发送开租提醒。",
  INTAKE_PENDING:"本单已有结算申请待客服处理，暂不需要提醒双方。",
  PARTIES_CONFIRMED:"双方已完成当前阶段的确认，暂不需要提醒。",
  DECISION_REJECTED:"结算方案已被一方拒绝，请先协调或重新发起，不再提醒另一方确认原方案。",
  STAGE_CHANGED:"原提醒对应的阶段已变化，已结束旧请求；请按当前订单状态重新发起提醒。",
  SETTLEMENT_POSTED:"本单结算已生效，不再发送阶段提醒。",
  TEAM_NOT_READY:"订单群尚未就绪，暂不能发送提醒；订单页不受影响。",
  REMINDER_IN_PROGRESS:"上一条提醒仍在发送中，请稍后查看本单状态。",
  REMINDER_UNKNOWN:"上一条提醒结果未知；请先在订单群核对是否已发送，确认未发送后再新建提醒。",
};

const AMOUNT_LABELS: Record<string, string> = {
  haffConsumedBuyer: "哈夫币消耗（租客侧）",
  haffConsumedOwner: "哈夫币消耗（号主侧）",
  itemConsumedBuyer: "物品消耗（租客侧）",
  itemConsumedOwner: "物品消耗（号主侧）",
  unusedItemRefund: "未消耗物资预付款（按下单时分配）",
  unusedHaffRefund: "未消耗哈夫币预付款（按下单时分配）",
  earlyMakeup: "提前结束补足",
  feeBase: "包赔费基数",
  feeRate: "包赔费率",
  feeAmount: "包赔费",
  feePayer: "包赔费承担方",
  ownerGross: "号主毛额",
  ownerNet: "号主净额",
  renterCharge: "租客应收",
  renterRefund: "租客应退",
  depositRefund: "押金退款",
};
const AMOUNT_ORDER = Object.keys(AMOUNT_LABELS);
const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" };

function quantityForDisplay(value:string,unit:string):string {
  if(unit!=="HAFF_BASE"||!/^(0|[1-9]\d{0,18})$/.test(value))return value;
  const n=BigInt(value),whole=n/1000000n,fraction=(n%1000000n).toString().padStart(6,"0").replace(/0+$/,"");
  return fraction?`${whole}.${fraction}`:String(whole);
}
function quantityForSubmit(value:string,unit:string):string|null {
  if(unit!=="HAFF_BASE")return /^(0|[1-9]\d{0,18})$/.test(value)?value:null;
  const match=/^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/.exec(value);
  if(!match)return null;
  const n=BigInt(match[1]!)*1000000n+BigInt((match[2]??"").padEnd(6,"0"));
  return n<=9999999999999999999n?n.toString():null;
}

function amountText(value: unknown, monetary: boolean): string | null {
  if (monetary) {
    const raw = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value)
      ? (value as { amount?: unknown }).amount : null;
    const text = formatReferenceYuan(raw);
    return text ? `${text.replace("¥", "")} 元` : null;
  }
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { amount?: unknown; unit?: unknown };
    if (typeof record.amount === "string" && record.amount.trim()) return `${record.amount} ${typeof record.unit === "string" && record.unit === "yuan" ? "元" : record.unit ?? ""}`.trim();
  }
  return null;
}
function amountRows(amounts: Record<string, unknown> | null | undefined): Array<{ key: string; label: string; text: string }> {
  if (!amounts) return [];
  return AMOUNT_ORDER.flatMap(key => {
    const text = amountText(amounts[key], key !== "feeRate" && key !== "feePayer");
    return text === null ? [] : [{ key, label: AMOUNT_LABELS[key]!, text }];
  });
}
function isSettlementMoney(value:unknown):boolean{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const money=value as {currency?:unknown;unit?:unknown;scale?:unknown;amount?:unknown};
  return money.currency==="CNY"&&money.unit==="yuan"&&money.scale===2&&typeof money.amount==="string"&&/^(0|[1-9]\d*)\.\d{2}$/.test(money.amount);
}
function partyLabel(party: string | undefined): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return "相关方";
}
function decisionLabel(decision: { party?: string; action?: string }): string {
  const action = decision.action === "CONFIRM" ? "已确认" : decision.action === "REJECT" ? "已拒绝" : decision.action === "REVIEW" ? "已复核" : decision.action === "FINALIZE" ? "已确认结算" : "状态待核";
  return `${partyLabel(decision.party)}${action}`;
}
function storageKeyFor(viewerId: string, orderId: string): string {
  return `zzsh.im-support.fulfillment.${viewerId}.${orderId}`;
}
function reminderKeyFor(viewerId: string, orderId: string): string {
  return `zzsh.im-support.reminder.${viewerId}.${orderId}`;
}

/**
 * Admin-only fulfillment section. Writes are frozen intents persisted by
 * (admin subject, order): an unknown result keeps its responsibility across
 * unmounts and only a receipt for the SAME key resolves it (same-key replay or
 * an accepted write's readback). A plain GET only observes the current state.
 * Frozen order inventory arrives through the authorized IM slot projection;
 * the section never computes money and never writes an order/ledger row.
 */
/** Standalone review notice: visible even when the settlement read fails or the order has ended. */
export function StageCardAttentionNotice({ stageCards, terminal = false }: {
  stageCards?: Array<{ kind: string; kindLabel?: string; state: string }>;
  terminal?: boolean;
}) {
  const unknown = (stageCards ?? []).filter((card) => card.state === "UNKNOWN");
  if (!unknown.length) return null;
  const labels = unknown.map((card) => card.kindLabel?.trim() || card.kind).join("、");
  return <Alert variant="warning" role="status" data-action="stage-card-unknown">
    <TriangleAlert /><AlertTitle>自动卡发送结果待核对</AlertTitle>
    <AlertDescription>
      {terminal
        ? `${labels}可能已发出。订单已结束，请先在订单群核对；本页不开放补发或写操作。`
        : `${labels}可能已发出。请先在订单群核对；确认未发送后，再按当前阶段使用“发送进度提醒”，不要直接重发。`}
    </AlertDescription>
  </Alert>;
}

export function OrderFulfillmentSection({ orderId, displayNo, viewerId, orderStatus, frozenInventory, canManualClose, compact=false, onViewChange, onOpenPath }: { orderId: string; displayNo: string; viewerId: string; orderStatus?: string; frozenInventory?: InventoryLine[]; canManualClose?: boolean; compact?:boolean; onViewChange?:(view:SettlementReadView|null)=>void; onOpenPath?:(path:string,title?:string)=>void }) {
  const [view, setView] = useState<SettlementReadView | null>(null);
  const [readState, setReadState] = useState<FulfillmentReadState>("idle");
  const [readDetail, setReadDetail] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [endReason, setEndReason] = useState<"" | EarlyEndReason>("");
  const [reason, setReason] = useState("");
  const [ownerNet, setOwnerNet] = useState("");
  const [renterRefund, setRenterRefund] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [intent, setIntent] = useState<FulfillmentIntent | null>(null);
  const [phase, setPhase] = useState<IntentPhase>("IDLE");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [finalizeOpen,setFinalizeOpen]=useState(false);
  const [finalizeReason,setFinalizeReason]=useState("");
  const [finalizeTarget,setFinalizeTarget]=useState<{id:string;hash:string;versionNo:number|undefined;early:boolean;amounts:Record<string,unknown>|null;parties:string[]}|null>(null);
  const [openingTarget,setOpeningTarget]=useState<{id:string;versionNo:number;party:"RENTER"|"OWNER"}|null>(null);
  const [openingReason,setOpeningReason]=useState("");
  const [confirmation, setConfirmation] = useState<{scope:string; generation:number; action:"opening"|"opening-party"|"classify"|"review"|"finalize"|"adjust"|"replay"} | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderPending, setReminderPending] = useState<string | null>(null);
  const [reminderUnknown, setReminderUnknown] = useState(false);
  const [openingRetryBusy, setOpeningRetryBusy] = useState(false);
  const [openingRetryPending, setOpeningRetryPending] = useState<string | null>(null);
  const [openingRetryOpen, setOpeningRetryOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generationRef = useRef(0);
  const intentRef = useRef<FulfillmentIntent | null>(null);
  intentRef.current = intent;
  const scopeRef = useRef("");
  scopeRef.current = `${viewerId}:${orderId}`;
  const scope = scopeRef.current;
  const reportView=useRef(onViewChange),viewOwner=useRef<string|null>(null);reportView.current=onViewChange;
  useEffect(()=>{reportView.current?.(viewOwner.current===scope?view:null);},[scope,view]);

  /** Session loss hides every private projection immediately; the intent/phase survive. */
  const hidePrivate = () => {
    viewOwner.current=null;
    setView(null);
    setLines([]);
    setPreview(null);
  };

  const locked = phase !== "IDLE";
  const inventoryByName = useMemo(() => {
    const map = new Map<string, InventoryLine>();
    for (const line of frozenInventory ?? []) map.set(line.itemId, line);
    return map;
  }, [frozenInventory]);
  const inventoryName = (itemId: string): { name: string | null; unit: string } => {
    const line = inventoryByName.get(itemId);
    const extra=view?.extraResources?.find(item=>item.itemId===itemId);
    return { name: line?.name ?? extra?.name ?? null, unit: line?.unit ?? extra?.unit ?? "" };
  };

  const invalidate = () => {
    generationRef.current += 1;
    setPreview(null);
  };

  const seed = useCallback((next: SettlementReadView) => {
    const opening = [...(next.openings ?? [])].reverse().find((item) => Array.isArray(item.lines) && item.lines.length > 0);
    if (opening?.lines) {
      const actual=next.consumptionMode==="ACTUAL";
      const pending=[...(next.intakes??[])].reverse().find(item=>item.status==="OPEN");
      const saved=new Map((pending?.lines??[]).map(line=>[line.itemId,line]));
      const declared=opening.lines
        .filter((line): line is { itemId: string; quantity?: string; unit?: string } => Boolean(line) && typeof line.itemId === "string")
        .map((line) => {
          const frozen = inventoryByName.get(line.itemId);
          const recorded=saved.get(line.itemId);
          return { itemId: line.itemId, name: frozen?.name ?? null, unit: line.unit ?? frozen?.unit ?? "",
            value:quantityForDisplay(actual?recorded?.consumedQuantity??"":recorded?.remainingQuantity??line.quantity??"",line.unit ?? frozen?.unit ?? "") };
        });
      const extra=actual?(next.extraResources??[]).filter(line=>!declared.some(item=>item.itemId===line.itemId))
        .map(line=>({itemId:line.itemId,name:line.name,unit:line.unit,value:saved.get(line.itemId)?.consumedQuantity??"0"})):[];
      setLines([...declared,...extra]);
      return;
    }
    if (frozenInventory && frozenInventory.length > 0) {
      setLines(frozenInventory.map((line) => ({ itemId: line.itemId, name: line.name, unit: line.unit, value: quantityForDisplay(line.quantity,line.unit) })));
      return;
    }
    setLines([]);
  }, [frozenInventory, inventoryByName]);

  const persistIntent = (next: FulfillmentIntent, accepted = false): boolean => {
    try {
      window.localStorage.setItem(storageKeyFor(viewerId, orderId), JSON.stringify({ subject: viewerId, intent: next, ...(accepted ? { accepted: true } : {}) } satisfies PersistedIntent));
      setStorageBlocked(false);
      return true;
    } catch {
      setStorageBlocked(true);
      return false;
    }
  };
  const clearIntent = (): boolean => {
    try {
      const raw = window.localStorage.getItem(storageKeyFor(viewerId, orderId));
      const original = raw ? JSON.parse(raw) as PersistedIntent : null;
      if (!original || original.subject !== viewerId || original.intent?.id !== intentRef.current?.id) throw new Error("intent changed");
      window.localStorage.removeItem(storageKeyFor(viewerId, orderId));
    } catch { setStorageBlocked(true); setError("原操作记录无法核对，暂不能发起新操作。"); return false; }
    intentRef.current = null;
    setIntent(null);
    setPhase("IDLE");
    return true;
  };

  const applyView = (next: SettlementReadView) => {
    viewOwner.current=scope;
    setView(next);
    seed(next);
    invalidate();
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setReadDetail("");
    const outcome = await readOrderSettlement(orderId);
    if (scopeRef.current !== scope) return;
    setReadState(outcome.kind);
    if (outcome.kind === "ok") {
      applyView(outcome.view);
    } else if (outcome.kind === "auth") {
      hidePrivate();
    } else if (outcome.kind === "unknown") {
      setReadDetail(friendlyError(outcome.error));
    }
    if (scopeRef.current === scope) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, seed, scope]);

  // Recover this subject's unresolved intent before allowing any new write.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKeyFor(viewerId, orderId));
      if (!raw) { intentRef.current = null; setIntent(null); setPhase("IDLE"); return; }
      const parsed = JSON.parse(raw) as PersistedIntent;
      if (!parsed || parsed.subject !== viewerId || !parsed.intent || parsed.intent.orderId !== orderId) {
        // Another administrator's intent is never consumed by this subject.
        intentRef.current = null;
        setIntent(null);
        setPhase("IDLE");
        return;
      }
      intentRef.current = parsed.intent;
      setIntent(parsed.intent);
      if (parsed.accepted === true) {
        // The accepted receipt is a durable fact: it can only be cleared by a GET, never by replay.
        setPhase("ACCEPTED_READBACK_PENDING");
        setNotice("上次操作已受理，等待读取最新状态；不会重复提交，请查看当前状态。");
        return;
      }
      setPhase("UNKNOWN");
      setNotice("检测到上次未确认的履约操作；请查看当前状态或按原请求重试。");
    } catch {
      setStorageBlocked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId, orderId]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(reminderKeyFor(viewerId, orderId));
      if (raw && /^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
        setReminderPending(raw);
        setReminderUnknown(true);
        setNotice("检测到上次进度提醒结果未确认；请先在订单群核对，或按原请求查看结果。");
      } else {
        setReminderPending(null);
        setReminderUnknown(false);
      }
    } catch {
      setReminderPending(null);
      setReminderUnknown(false);
    }
  }, [viewerId, orderId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const readbackAccepted = async () => {
    const outcome = await readOrderSettlement(orderId);
    if (scopeRef.current !== scope) return;
    if (outcome.kind === "ok") {
      setReadState("ok");
      applyView(outcome.view);
      if (!clearIntent()) return;
      setNotice((current) => current || "操作已受理，最新状态已读取。");
      setError("");
      return;
    }
    setPhase("ACCEPTED_READBACK_PENDING");
    if (outcome.kind === "auth") {
      setReadState("auth");
      hidePrivate();
      setError("操作已受理；登录状态已变化，订单私有投影已隐藏。重新确认同一管理员身份后请查看当前状态。");
    } else {
      setError("操作已受理，但读取最新状态失败；仅可查看当前状态，不会重复提交。");
    }
  };

  const dispatch = async (target: FulfillmentIntent, isReplay = false) => {
    setBusy(true);
    setError("");
    setNotice("");
    const outcome = await sendFulfillmentIntent(target, isReplay);
    if (intentRef.current?.id !== target.id) { setBusy(false); return; }
    if (outcome.kind === "accepted") {
      setPhase("ACCEPTED_READBACK_PENDING");
      const success: Record<string, string> = {
        "record-opening": "期初已提交，等待买卖双方确认。",
        "confirm-opening": "已记录客服协助确认；请查看最新开租状态。",
        classify: "已生成提前结算版本，等待买卖双方确认。",
        review: "已完成客服复核。",
        finalize: "结算已生效；退款处理状态请查看订单资金记录。",
        adjust: "人工调整已提交，进入既有审批流程。",
      };
      setNotice(target.kind === "preview" ? "" : success[target.kind] ?? "操作已受理。");
      if (target.kind === "preview") {
        const body = outcome.body;
        const amounts = (body.amounts ?? body.settlement?.computation?.amounts ?? null) as Record<string, unknown> | null;
        const versionHash = typeof body.versionHash === "string" ? body.versionHash : body.settlement?.versionHash ?? null;
        const armed = target.body.proposedOwnerNet !== undefined || target.body.proposedRenterRefund !== undefined;
        if (!clearIntent()) { setBusy(false); return; }
        setPreview({ amounts, versionHash, early: typeof body.early === "boolean" ? body.early : body.settlement?.early ?? null, adjustArmed: armed });
        setNotice(armed ? "已生成人工调整预览；确认后提交调整申请。" : "结算方案已生成，请核对金额后提交。");
      } else {
        // The accepted receipt must survive unmount: only a GET may clear it.
        persistIntent(target, true);
        await readbackAccepted();
      }
    } else if (outcome.kind === "blocked") {
      if (!clearIntent()) { setBusy(false); return; }
      setError(`服务端未接受：${outcome.reasons.map(reason=>SETTLEMENT_REASON_LABELS[reason]??reason).join(" / ")}`);
    } else if (outcome.kind === "auth") {
      // Private projections disappear with the session; the original responsibility stays.
      hidePrivate();
      setPhase("AUTH");
      setError("登录状态已变化，订单私有投影已隐藏；重新确认同一管理员身份后可查看当前状态或按原请求重放。");
    } else if (outcome.kind === "unresolved") {
      setError(`服务端当前拒绝本次重放（${outcome.reasons[0] ?? outcome.message}），但这不能证明原请求未执行；责任保留，请人工核对后再处理。`);
    } else {
      setPhase("UNKNOWN");
      setError("操作结果未确认，本次操作责任已保留（同一幂等键）；查看当前状态仅为观察，不会解除。");
    }
    if(target.kind==="finalize")setFinalizeOpen(false);
    if(target.kind==="confirm-opening"&&outcome.kind==="accepted")setOpeningTarget(null);
    setBusy(false);
  };

  const beginIntent = async (command: Parameters<typeof buildFulfillmentIntent>[1]) => {
    if (locked || storageBlocked) return;
    try {
      await withSupplyWriteLock(storageKeyFor(viewerId, orderId), async () => {
        const raw = window.localStorage.getItem(storageKeyFor(viewerId, orderId));
        if (raw !== null) {
          const existing = JSON.parse(raw) as PersistedIntent;
          if (existing.subject !== viewerId || !existing.intent || existing.intent.orderId !== orderId || typeof existing.intent.id !== "string") throw new Error("intent unreadable");
          intentRef.current = existing.intent; setIntent(existing.intent);
          setPhase(existing.accepted === true ? "ACCEPTED_READBACK_PENDING" : "UNKNOWN");
          setNotice("另一页面已有本单操作，请先查看原操作状态。");
          return;
        }
        const built = buildFulfillmentIntent(orderId, command);
        if (!persistIntent(built)) { setError("无法持久化本次操作意图，已阻止新写入；请刷新后重试。"); return; }
        intentRef.current = built; setIntent(built); setPhase("SENDING");
        await dispatch(built);
      });
    } catch (error) {
      if (!(error instanceof SupplyWriteLockError)) setStorageBlocked(true);
      setError(error instanceof SupplyWriteLockError && error.code === "LOCK_BUSY" ? "另一页面正在处理本单，请先查看原操作。" : "无法安全保存或锁定本次操作，请检查浏览器后重试。");
    }
  };

  const observeCurrentUnlocked = async () => {
    setLoading(true);
    setError("");
    const outcome = await readOrderSettlement(orderId);
    if (scopeRef.current !== scope) return;
    setLoading(false);
    if (outcome.kind === "ok") {
      setReadState("ok");
      applyView(outcome.view);
      if (phase === "ACCEPTED_READBACK_PENDING") {
        if (!clearIntent()) return;
        setNotice("操作已受理，最新状态已读取。");
      } else {
        setNotice("已查看当前状态；该读取不构成原请求回执，未决操作仍保留。");
      }
      return;
    }
    setReadState(outcome.kind);
    if (outcome.kind === "auth") {
      hidePrivate();
      setError("登录状态已变化，订单私有投影已隐藏；请重新确认同一管理员身份后重试。");
    } else if (outcome.kind === "unavailable") {
      setError("本环境未启用结算记录，无法查看当前状态；原请求责任仍保留。");
    } else if (outcome.kind === "forbidden") {
      setError("当前账号无权查看本单结算记录；原请求责任仍保留。");
    } else {
      setError(friendlyError(outcome.error));
    }
  };
  const observeCurrent = async () => {
    if (phase !== "ACCEPTED_READBACK_PENDING") return observeCurrentUnlocked();
    try { await withSupplyWriteLock(storageKeyFor(viewerId, orderId), observeCurrentUnlocked); }
    catch { setError("另一页面正在处理本单，请稍后查看原操作。"); }
  };

  const replay = async () => {
    if (!intent || phase === "SENDING" || phase === "ACCEPTED_READBACK_PENDING") return;
    try {
      await withSupplyWriteLock(storageKeyFor(viewerId, orderId), async () => {
        const raw = window.localStorage.getItem(storageKeyFor(viewerId, orderId));
        const saved = raw ? JSON.parse(raw) as PersistedIntent : null;
        if (!saved || saved.subject !== viewerId || saved.intent?.id !== intent.id || saved.accepted === true) throw new Error("intent changed");
        await dispatch(intent, true);
      });
    } catch (error) {
      if (!(error instanceof SupplyWriteLockError)) setStorageBlocked(true);
      setError(error instanceof SupplyWriteLockError && error.code === "LOCK_BUSY" ? "另一页面正在处理本单，请先查看原操作。" : "原操作记录无法核对，请保留记录并联系技术人员。");
    }
  };

  const linesForOpening = () => lines.map((line) => ({ itemId: line.itemId, quantity: quantityForSubmit(line.value,line.unit) ?? "" }));
  const linesForRemaining = () => lines.map((line) => view?.consumptionMode==="ACTUAL"
    ?{ itemId:line.itemId,consumedQuantity:quantityForSubmit(line.value,line.unit) ?? "" }:{ itemId:line.itemId,remainingQuantity:quantityForSubmit(line.value,line.unit) ?? "" });

  const latestOpening = view?.openings?.[view.openings.length - 1];
  const openingConfirmed = Boolean(view?.openings?.some((opening) => opening.status === "CONFIRMED"));
  const openingRecoveryRequired = view?.openingGenerationRecoveryRequired === true;
  const openingReview = view?.openingGeneration?.state === "REVIEW_REQUIRED"
    ? view.openingGeneration
    : openingRecoveryRequired
      ? { state: "REVIEW_REQUIRED" as const, reason: "GENERATION_RECORD_MISSING" }
      : null;
  // 旧接口或迁移前已付款、没有任何自动生成结论的订单保留手工兜底；有恢复标记的新单走重新核对。
  const legacyOpeningEntry = view?.openingGeneration == null && !openingRecoveryRequired;
  const current = view?.settlement ?? null;
  const posting = view?.posting ?? null;
  const partyConfirmed = Boolean(current?.decisions?.some((d) => d.party === "RENTER" && d.action === "CONFIRM")
    && current?.decisions?.some((d) => d.party === "OWNER" && d.action === "CONFIRM"));
  const supportReviewed = Boolean(current?.decisions?.some((d) => d.party === "SUPPORT" && d.action === "REVIEW"));

  const stage = useMemo(() => {
    if (posting) return { key: "posted", label: "已生效" } as const;
    if (!openingConfirmed && latestOpening) return { key: "opening-pending", label: "等待双方确认开租" } as const;
    if (!openingConfirmed) return { key: "needs-opening", label: openingReview ? "开租资料待客服核对" : legacyOpeningEntry ? "待发起开租确认" : "待系统生成开租清单" } as const;
    if (view?.currentRequest?.kind === "INTAKE") return { key: "intake-pending", label: "有结算申请待处理" } as const;
    if (!current) return { key: "needs-settlement", label: "履约中 · 待结算" } as const;
    if (current.decisions?.some(d=>d.action==="REJECT"&&d.versionHash===current.versionHash)) return {key:"decision-rejected",label:"结算方案有争议"} as const;
    if (current.early && !partyConfirmed) return { key: "awaiting-decision", label: "等待双方确认结算" } as const;
    if (current.early && partyConfirmed && !supportReviewed) return { key: "needs-review", label: "待客服复核" } as const;
    if (current.early) return { key: "reviewed", label: "已复核" } as const;
    return { key: "normal-version", label: "正常结算版本" } as const;
  }, [posting, openingConfirmed, latestOpening, openingReview, legacyOpeningEntry, view?.currentRequest?.kind, current, partyConfirmed, supportReviewed]);

  const task = useMemo(() => {
    switch (stage.key) {
      case "needs-opening": return legacyOpeningEntry
        ? { title: "发起开租确认", action: "发起开租确认" }
        : { title: "开租资料待客服核对", action: "查看核对说明" };
      case "opening-pending": return { title: "等待双方确认开租", action: "查看开租清单" };
      case "intake-pending": return { title: "有结束申请待处理", action: "打开核对面板" };
      case "needs-settlement": return { title: "履约中 · 等待结算", action: "打开核对面板" };
      case "awaiting-decision": return { title: "等待双方确认结算", action: "查看本版明细" };
      case "decision-rejected": return { title: "结算方案有争议", action: "处理结算方案" };
      case "needs-review": return { title: "待客服复核", action: "打开复核面板" };
      case "reviewed": return { title: "已复核，等待生效", action: "查看结算明细" };
      case "normal-version": return { title: "正常结算版本", action: "查看结算明细" };
      default: return { title: "已过账", action: "查看过账明细" };
    }
  }, [stage.key, legacyOpeningEntry]);

  // 确认状态只认同一版本上的 ack/decision：新版本会让旧确认失效。
  const partyFacts = useMemo(() => {
    if (stage.key === "opening-pending") {
      return { version: `开租清单 v${latestOpening?.versionNo ?? "?"}`, rows: (["RENTER", "OWNER"] as const).map((party) => {
        const ack=latestOpening?.acks?.find(item=>item.party===party);
        return { party, confirmed: Boolean(ack), source: ack?.source };
      }) };
    }
    if (current?.decisions) {
      return { version: `结算版本 v${current.versionNo ?? "?"}${current.early ? " · 提前" : ""}`, rows: (["RENTER", "OWNER"] as const).map((party) => ({ party, confirmed: current.decisions!.some((decision) => decision.party === party && decision.action === "CONFIRM" && decision.versionHash === current.versionHash), source: undefined })) };
    }
    return null;
  }, [stage.key, latestOpening?.acks, latestOpening?.versionNo, current?.decisions, current?.versionHash, current?.versionNo, current?.early]);


  const primaryDisabled = busy || loading || locked || storageBlocked || view?.consumptionMode==="UNAVAILABLE";
  const previewAmounts = preview?.amounts ?? null;
  const currentAmounts = (current?.computation?.amounts ?? null) as Record<string, unknown> | null;
  const finalizationAmountsReady=isSettlementMoney(currentAmounts?.ownerNet)&&isSettlementMoney(currentAmounts?.renterRefund)
    && typeof current?.early==="boolean" && (!current.early || isSettlementMoney(currentAmounts?.earlyMakeup));
  const currentInputLines = (current?.inputSnapshot?.lines ?? []) as Array<{ itemId?: string; openingQuantity?: string; remainingQuantity?: string; consumedQuantity?:string }>;
  const postingRows = amountRows((posting?.amounts ?? null) as Record<string, unknown> | null);

  const recordOpening = () => {
    if (lines.length === 0 || lines.some((line) => quantityForSubmit(line.value,line.unit)===null)) {
      setError("请核对资源数量；哈夫币按 M 填写，其他资源填写非负整数。");
      return;
    }
    void beginIntent({ kind: "record-opening", lines: linesForOpening() });
  };
  const clearReminderKey = () => {
    try { window.sessionStorage.removeItem(reminderKeyFor(viewerId, orderId)); } catch { /* state still clears */ }
    setReminderPending(null);
    setReminderUnknown(false);
  };
  const deliverReminder = async (key: string | null) => {
    if (reminderBusy) return;
    const requestKey = key ?? `support_reminder_${crypto.randomUUID()}`;
    if (key === null) {
      try { window.sessionStorage.setItem(reminderKeyFor(viewerId, orderId), requestKey); }
      catch { setError("无法保存提醒请求键，已阻止发送；请检查浏览器存储。"); return; }
    }
    setReminderPending(requestKey); setReminderBusy(true); setError(""); setNotice("");
    const outcome = await sendProgressReminder(orderId, requestKey);
    if (scopeRef.current !== scope) return;
    if (outcome.kind === "accepted") {
      clearReminderKey();
      setNotice(`已发送进度提醒（${outcome.receipt.stage}）。提醒不会创建清单或替人确认。`);
    } else if (outcome.kind === "blocked") {
      if (outcome.reason === "REMINDER_UNKNOWN" || outcome.reason === "REMINDER_IN_PROGRESS") {
        setReminderUnknown(outcome.reason === "REMINDER_UNKNOWN");
        setError(REMINDER_REASON_TEXT[outcome.reason] ?? "请先核对提醒状态。");
      } else {
        clearReminderKey();
        setError(REMINDER_REASON_TEXT[outcome.reason] ?? "当前阶段暂不能发送提醒，请刷新后核对。");
      }
    } else if (outcome.kind === "auth") {
      setError("登录状态已变化；原提醒请求仍保留，重新确认身份后可查看结果。");
    } else {
      setReminderPending(requestKey);
      setReminderUnknown(true);
      setError("提醒投递结果未确认；请先在订单群核对是否已发送，再决定是否新建提醒。");
    }
    setReminderBusy(false);
  };
  const retryOpeningGeneration = async () => {
    if (openingRetryBusy) return;
    const key = openingRetryPending ?? `support_opening_retry_${crypto.randomUUID()}`;
    setOpeningRetryPending(key); setOpeningRetryBusy(true); setError(""); setNotice("");
    const outcome = await retryAutomaticOpening(orderId, key);
    if (scopeRef.current !== scope) return;
    if (outcome.kind === "accepted") {
      setOpeningRetryPending(null);
      if (outcome.state === "REVIEW_REQUIRED") {
        setError(`重新核对后仍不能生成开租清单：${openingReviewText(outcome.reason)}（原因：${outcome.reason ?? "UNKNOWN"}）`);
      } else {
        setNotice(outcome.state === "CREATED" ? "已重新核对并生成开租清单。" : "开租清单已存在，已刷新当前状态。");
        await load();
      }
    } else if (outcome.kind === "blocked") {
      setOpeningRetryPending(null);
      setError(outcome.reason === "PAYMENT_BASIS_MISSING" ? "未找到已接纳的付款依据，暂不能重新生成。" : "当前不能重新核对开租依据，请刷新后查看。");
    } else if (outcome.kind === "auth") {
      setError("登录状态已变化；原核对请求仍保留，重新确认身份后可重试。");
    } else {
      setError("重新核对结果未确认；请按原请求重试，不会换键重复创建。");
    }
    setOpeningRetryBusy(false);
  };
  const sendReminder = () => deliverReminder(reminderPending);
  const restartReminder = () => { clearReminderKey(); void deliverReminder(null); };
  const previewSettlement = () => {
    if (lines.length === 0 || lines.some((line) => quantityForSubmit(line.value,line.unit)===null)) {
      setError("请核对资源数量；哈夫币按 M 填写，其他资源填写非负整数。");
      return;
    }
    void beginIntent({ kind: "preview", lines: linesForRemaining(), ...(endReason?{endReason}:{}) });
  };
  const previewAdjustment = () => {
    if (ownerNet.trim() === "" || renterRefund.trim() === "" || reason.trim().length < 3) {
      setError("人工调整需要填写号主拟净额、租客拟退款和不少于3字的原因。");
      return;
    }
    void beginIntent({
      kind: "preview",
      lines: linesForRemaining(),
      ...(endReason === "" ? {} : { endReason }),
      proposedOwnerNet: ownerNet.trim(),
      proposedRenterRefund: renterRefund.trim(),
      reason: reason.trim(),
    });
  };
  const classify = () => {
    if (!preview?.versionHash) return;
    void beginIntent({ kind: "classify", lines: linesForRemaining(), endReason:endReason||"NORMAL", acceptedHash: preview.versionHash });
  };
  const review = () => {
    if (!current?.id || !current.versionHash) return;
    void beginIntent({ kind: "review", versionId: current.id, versionHash: current.versionHash });
  };
  const finalize = () => {
    if(!finalizeTarget||finalizeReason.trim().length<3)return;
    void beginIntent({kind:"finalize",versionId:finalizeTarget.id,versionHash:finalizeTarget.hash,reason:finalizeReason.trim()});
  };
  const confirmOpeningForParty = () => {
    if(!openingTarget || openingReason.trim().length<3)return;
    void beginIntent({kind:"confirm-opening",openingId:openingTarget.id,versionNo:openingTarget.versionNo,party:openingTarget.party,reason:openingReason.trim()});
  };
  const adjust = () => {
    if (!preview?.versionHash || ownerNet.trim() === "" || renterRefund.trim() === "" || reason.trim().length < 3) return;
    void beginIntent({
      kind: "adjust",
      lines: linesForRemaining(),
      ...(endReason === "" ? {} : { endReason }),
      proposedOwnerNet: ownerNet.trim(),
      proposedRenterRefund: renterRefund.trim(),
      reason: reason.trim(),
      acceptedHash: preview.versionHash,
    });
  };

  const setLineValue = (index: number, value: string) => {
    if (locked) return;
    invalidate();
    setLines((currentLines) => currentLines.map((line, itemIndex) => itemIndex === index ? { ...line, value } : line));
  };

  const renderInventory = (mode: "opening" | "remaining") => lines.length > 0 ? <div className="im-support-fulfillment-lines overflow-x-auto rounded-lg border" role="group" aria-label={mode === "opening" ? "开租资源清单" : view?.consumptionMode==="ACTUAL"?"实际消耗":"剩余库存"}>
    <Table><TableHeader><TableRow><TableHead>资源</TableHead><TableHead>{mode==="opening"?"下单冻结数量":"开租数量"}</TableHead><TableHead>{mode==="opening"?"清单数量":view?.consumptionMode==="ACTUAL"?"实际消耗":"剩余数量"}</TableHead></TableRow></TableHeader><TableBody>
    {lines.map((line,index)=>{const reference=mode==="opening"?inventoryByName.get(line.itemId)?.quantity:latestOpening?.lines?.find(item=>item.itemId===line.itemId)?.quantity;const unit=line.unit==="HAFF_BASE"?"M":UNIT_LABELS[line.unit]??line.unit;
      return <TableRow key={line.itemId}><TableCell>{line.name??"资源未记录"}</TableCell><TableCell className="tabular-nums">{reference===undefined?"未记录":`${quantityForDisplay(reference,line.unit)} ${unit}`}</TableCell><TableCell><div className="flex items-center gap-2"><Input value={line.value} inputMode={line.unit==="HAFF_BASE"?"decimal":"numeric"} disabled={locked} onChange={(event)=>setLineValue(index,event.target.value)} aria-label={`${line.name??line.itemId} ${mode==="opening"?"期初数量":view?.consumptionMode==="ACTUAL"?"实际消耗数量":"剩余数量"}`} /><span className="shrink-0 text-muted-foreground">{unit}</span></div></TableCell></TableRow>;})}
    </TableBody></Table>
  </div> : <p className="im-support-fulfillment-empty">未取得本单冻结资源清单，暂不能发起开租确认。</p>;

  const renderCurrentFacts = () => current ? <div className="im-support-fulfillment-preview" aria-label="当前结算版本事实">
    <strong>当前结算版本 v{current.versionNo ?? "?"}{current.early ? " · 提前" : ""}（双方核对依据）</strong>
    {currentInputLines.length > 0 ? <div className="im-support-fulfillment-lines" role="group" aria-label="当前版本数量">
      {currentInputLines.map((line) => {
        const facts = line.itemId ? inventoryName(line.itemId) : { name: null, unit: "" };
        const quantity=line.consumedQuantity??line.remainingQuantity??line.openingQuantity;
        return <label key={line.itemId ?? "line"}><span>{facts.name ?? "物资"}{facts.unit ? ` · ${facts.unit==="HAFF_BASE"?"M":UNIT_LABELS[facts.unit] ?? facts.unit}` : ""}{line.consumedQuantity===undefined?" · 期末剩余":" · 实际消耗"}</span><output>{quantity===undefined?"—":quantityForDisplay(quantity,facts.unit)}</output></label>;
      })}
    </div> : null}
    {amountRows(currentAmounts).length > 0 ? <dl>{amountRows(currentAmounts).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : <small>暂无金额明细。</small>}
    {currentAmounts?.unusedItemRefund || currentAmounts?.unusedHaffRefund ? <small>未消耗预付款按下单时分配计算；实际应退会重新计算会员折扣和费用。</small> : null}
  </div> : null;

  const action = confirmation?.scope === scope ? confirmation.action : null;
  const armConfirmation = (action: NonNullable<typeof confirmation>["action"]) => setConfirmation({scope, generation:generationRef.current, action});
  const confirmationTitle = { opening:"发起开租确认", "opening-party":"协助确认开租", classify:"生成结算方案", review:"复核结算方案", finalize:"按当前方案结算", adjust:"提交人工调整", replay:"重试原请求" } as const;
  const confirmAction = () => {
    if (!action || busy || loading) return;
    setConfirmation(null);
    if (confirmation?.generation !== generationRef.current) { setError("订单资料已变化，请重新核对后再操作。"); return; }
    if ((action === "opening-party" || action === "finalize") && !canManualClose) { setError("当前账号无权执行此操作，请联系有权限的同事。"); return; }
    if (action === "opening") recordOpening();
    else if (action === "opening-party") confirmOpeningForParty();
    else if (action === "classify") classify();
    else if (action === "review") review();
    else if (action === "finalize") finalize();
    else if (action === "adjust") adjust();
    else void replay();
  };
  const statusMessages = <>
    {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert variant="info" role="status"><Info /><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {storageBlocked ? <Alert variant="destructive"><CircleAlert /><AlertTitle>本地暂存不可用</AlertTitle><AlertDescription>{phase === "ACCEPTED_READBACK_PENDING" ? ACCEPTED_STORAGE_WARNING : "本地无法保存操作记录，已阻止新操作；请刷新后重试。"}</AlertDescription></Alert> : null}
    {phase !== "IDLE" ? <Alert role="status" variant="warning"><TriangleAlert /><AlertTitle>{phase === "SENDING" ? "本次操作正在发送" : phase === "AUTH" ? "登录状态已变化，原责任仍保留" : phase === "ACCEPTED_READBACK_PENDING" ? "操作已受理，等待最新状态" : "本次操作结果未确认"}</AlertTitle><AlertDescription>
      {phase === "SENDING" ? "请求尚未返回，请勿重复提交。" : phase === "AUTH" ? "原操作记录仍保留。" : phase === "ACCEPTED_READBACK_PENDING" ? "操作已受理，等待读取最新状态；不会重复提交。" : "原操作记录与责任已保留。"}
    </AlertDescription><AlertAction>
      <Button variant="outline" size="xs" onClick={() => void observeCurrent()} disabled={loading || busy}>查看当前状态</Button>
      {phase !== "SENDING" && phase !== "ACCEPTED_READBACK_PENDING" ? <Button variant="outline" size="xs" onClick={() => armConfirmation("replay")} disabled={busy || loading}>按原请求重放</Button> : null}
    </AlertAction></Alert> : null}
    <ConfirmAlertDialog open={action !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}
      title={action ? `确认${confirmationTitle[action]}？` : "确认操作"} contentLabel="确认订单操作"
      description={action === "replay" ? "只会重试同一笔原请求；请先核对当前状态，重试不代表上一次未执行。" : action === "finalize" ? "确认后将按本版结算并登记应退责任，退款到账以渠道结果为准。" : "请核对本次处理内容，确认后才会提交并记录经办人。"}
      confirmLabel={action ? `确认${confirmationTitle[action]}` : "确认"} cancelLabel="返回核对" confirmVariant="default"
      busy={busy} confirmDisabled={loading} onConfirm={confirmAction}>
      {action === "opening-party" ? <p className="text-sm">确认方：{partyLabel(openingTarget?.party)} · 原因：{openingReason.trim()}</p> : null}
      {action === "finalize" ? <><p className="text-sm">{finalizeTarget?.parties.join(" · ")} · {finalizeTarget?.early ? "提前结算" : "正常结算"}</p><dl className="text-sm">{amountRows(finalizeTarget?.amounts??null).filter(row=>row.key==="ownerNet"||row.key==="renterRefund"||finalizeTarget?.early&&row.key==="earlyMakeup").map(row=><div key={row.key} className="flex justify-between gap-4"><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl><p className="text-sm">处理原因：{finalizeReason.trim()}</p></> : null}
      {(action === "classify" || action === "adjust") && preview ? <dl className="text-sm">{amountRows(previewAmounts).map(row=><div key={row.key} className="flex justify-between gap-4"><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : null}
    </ConfirmAlertDialog>
  </>;

  const readButton = <Button variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading || busy} aria-label="重新读取本单进度"><RefreshCw /></Button>;

  const ended = orderStatus === "COMPLETED" || orderStatus === "CANCELLED";
  const endedLabel = orderStatus === "CANCELLED" ? "已取消" : "已完成";

  // 已结束订单是只读事实页：不再提供开租/结算写操作；读取不可用也只做中性说明。
  if (ended) {
    const readNote = readState === "unavailable" ? "本环境未启用结算记录，无法读取本单结算摘要。"
      : readState === "forbidden" ? "当前账号无权读取本单结算摘要。"
      : readState === "auth" ? "登录状态已变化，结算摘要已隐藏。"
      : readState === "unknown" ? `结算摘要暂时不可读。${readDetail ? ` ${readDetail}` : ""}`
      : null;
    return <Card className="im-support-fulfillment im-order-card" data-ended="true" data-stage="ended" data-read-state={readState} aria-label="本单已结束">
      <CardContent className="grid gap-2.5 p-4">
        {statusMessages}
        <div className="flex items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <CardTitle className="flex items-start gap-2 text-sm"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />本单已结束</CardTitle>
            <CardDescription className="text-xs leading-relaxed">{endedLabel}订单的开租与结算操作已关闭；订单群沟通是否仍可用以群内提示为准。</CardDescription>
          </div>
          <Badge variant="secondary">已结束</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{endedLabel}</Badge>
          {posting ? <Badge variant="secondary">已结算</Badge> : view ? <Badge variant="outline">未读到已过账结算</Badge> : null}
          {posting?.refundDueAt ? <span className="text-xs text-muted-foreground">退款应付时间：{formatDateTime(posting.refundDueAt)}</span> : null}
        </div>
        {!view && (loading || readState === "idle") ? <p className="im-support-fulfillment-empty">正在读取结算摘要…</p> : null}
        {!view && readNote ? <p className="im-support-fulfillment-empty">{readNote}</p> : null}
        {!view && readNote ? <div><Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled={loading || busy}>重新读取</Button></div> : null}
      </CardContent>
    </Card>;
  }

  // 读取失败与"读取成功但没有结算投影"是两件事：前者不能默认成待录入，也不影响本单聊天。
  // 404 只说明本环境未启用结算记录，不能宣称无权；403 才是当前账号无权。
  if (!view) {
    const reading = loading || readState === "idle";
    return <Card className="im-support-fulfillment im-order-card" data-available="false" data-read-state={readState} aria-label="本单当前任务">
      <CardContent className="grid gap-2 p-4">
        {statusMessages}
        {reading ? <Alert variant="warning" role="status"><TriangleAlert /><AlertTitle>正在读取本单进度…</AlertTitle><AlertDescription>不影响在这里沟通，稍后自动显示。</AlertDescription><AlertAction>
          <Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled>重新读取</Button>
        </AlertAction></Alert> : null}
        {!reading && readState === "unavailable" ? <Alert variant="info" role="status"><Info /><AlertTitle>本单结算记录不可用</AlertTitle><AlertDescription>本环境未启用结算记录，或该订单的记录不可读；不影响本单沟通。</AlertDescription><AlertAction>
          <Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled={busy}>重新读取</Button>
        </AlertAction></Alert> : null}
        {!reading && readState === "forbidden" ? <Alert variant="destructive" role="alert"><CircleAlert /><AlertTitle>当前账号无权查看本单结算记录</AlertTitle><AlertDescription>不影响本单沟通；如权限刚调整，可重新读取。</AlertDescription><AlertAction>
          <Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled={busy}>重新读取</Button>
        </AlertAction></Alert> : null}
        {!reading && readState === "auth" ? <Alert variant="warning" role="status"><TriangleAlert /><AlertTitle>登录状态已变化，本单私有信息已隐藏</AlertTitle><AlertDescription>重新确认同一管理员身份后再读取。</AlertDescription><AlertAction>
          <Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled={busy}>重新读取</Button>
        </AlertAction></Alert> : null}
        {!reading && readState !== "unavailable" && readState !== "forbidden" && readState !== "auth" ? <Alert variant="warning" role="status"><TriangleAlert /><AlertTitle>本单进度暂时读不到</AlertTitle><AlertDescription>不影响在这里沟通，稍后可重新读取。{readDetail ? ` ${readDetail}` : ""}</AlertDescription><AlertAction>
          <Button variant="outline" size="sm" data-action="fulfillment-reload" onClick={() => void load()} disabled={busy}>重新读取</Button>
        </AlertAction></Alert> : null}
      </CardContent>
    </Card>;
  }

  // 右栏只留任务入口：阶段、订单状态与版本确认由顶部阶段条与本核对面板承担，避免重复。
  return <><Card className={`im-support-fulfillment im-order-card${compact?" oc-action-card":""}`} data-stage={stage.key} aria-label="本单当前任务">
    <CardContent className={compact?"grid gap-2.5 p-0":"grid gap-2.5 p-4"}>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-1">
          <CardTitle className="flex items-start gap-2 text-sm"><ClipboardList className="mt-0.5 size-4 shrink-0 text-primary" />{compact?task.title:"履约核对"}</CardTitle>
          <CardDescription className="text-xs leading-relaxed">{stage.key==="needs-opening"?"付款已接纳；系统未生成清单时显示待核对原因。":"核对本单履约进度及结算方案。"}</CardDescription>
        </div>
        {readButton}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" data-action="open-fulfillment-panel" onClick={() => setPanelOpen(true)}>{task.action}</Button>
        {canManualClose !== false && ["opening-pending","needs-settlement","awaiting-decision"].includes(stage.key)
          ? <Button size="sm" variant="outline" data-action="send-progress-reminder" disabled={reminderBusy || busy || loading}
              onClick={() => void sendReminder()}>{reminderBusy ? "发送中…" : reminderPending ? "核对原提醒" : "发送进度提醒"}</Button>
          : null}
        {reminderUnknown && reminderPending
          ? <Button size="sm" variant="ghost" data-action="restart-progress-reminder" disabled={reminderBusy || busy || loading}
              onClick={restartReminder}>已在群内核对未发送，重新发送</Button>
          : null}
      </div>
      {panelOpen ? null : statusMessages}
    </CardContent>

    <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
      <DialogContent size="lg" className="im-order-panel" aria-label={task.title} showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><DialogTitle>{task.title}</DialogTitle><DialogDescription>订单 {displayNo} · {stage.label}</DialogDescription></div><Button type="button" variant="ghost" size="icon" onClick={() => setPanelOpen(false)} aria-label="关闭核对面板"><X size={14} /></Button></div>
        {statusMessages}
        {partyFacts ? <div className="im-order-parties overflow-hidden rounded-lg border">
          <div className="bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground">双方确认 · {partyFacts.version}</div>
          <ItemGroup className="divide-y divide-border">
            {partyFacts.rows.map((row) => <Item key={row.party} size="sm" className="gap-2 px-3 py-2">
              <ItemContent><ItemTitle className="text-sm">{partyLabel(row.party)}</ItemTitle></ItemContent>
              <ItemActions><Badge variant={row.confirmed ? "secondary" : "destructive"} data-state={row.confirmed ? "confirmed" : "pending"}>{row.confirmed ? row.source === "ON_BEHALF" ? "客服协助确认" : row.source === "AUTO" ? "自动确认" : "已确认" : "待确认"}</Badge></ItemActions>
            </Item>)}
          </ItemGroup>
          <p className="px-3 py-2 text-xs text-muted-foreground">{supportReviewed ? "客服已复核本版本。" : canManualClose ? "当事人无法操作时，客服可在核实后协助处理并记录原因。" : "请等待双方确认。"}</p>
        </div> : null}

      {stage.key === "needs-opening" ? (legacyOpeningEntry ? <div className="im-support-fulfillment-stage-panel">
        <strong>核对开租资源</strong>
        <small>历史已付款订单尚无自动生成结论。请按本单冻结清单核对后提交，等待租客和号主确认；新订单由系统在付款接纳后自动生成。</small>
        {renderInventory("opening")}
        <div className="im-support-fulfillment-actions"><Button type="button" onClick={() => armConfirmation("opening")} disabled={primaryDisabled || lines.length === 0}>提交开租清单</Button></div>
      </div> : <div className="im-support-fulfillment-stage-panel">
        <strong>开租资料待客服核对</strong>
        <small>付款事实已保留；系统依据本单冻结报价自动生成清单。资料不足时不会伪造数量、金额或当事人确认。</small>
        <Alert variant="warning" role="status"><TriangleAlert /><AlertTitle>尚未生成开租清单</AlertTitle><AlertDescription>{openingReview ? openingReviewText(openingReview.reason) : "本单没有可读取的自动生成结论，请核对付款与订单资料。"}{openingReview?.reason ? `（原因：${openingReview.reason}）` : ""}</AlertDescription></Alert>
        {canManualClose !== false ? <div className="im-support-fulfillment-actions">
          <Button type="button" variant="outline" data-action="retry-opening-generation" disabled={openingRetryBusy}
            onClick={() => setOpeningRetryOpen(true)}>{openingRetryBusy ? "核对中…" : openingRetryPending ? "按原请求重试核对" : "重新核对开租依据"}</Button>
        </div> : null}
        <ConfirmAlertDialog open={openingRetryOpen} onOpenChange={setOpeningRetryOpen}
          title="重新核对开租依据？" contentLabel="确认重新核对开租依据"
          description="系统只会在原付款和本单冻结报价可核实时生成清单；仍不足时保持待客服核对，不会伪造数量、金额或当事人确认。"
          confirmLabel={openingRetryBusy ? "核对中…" : "确认重新核对"} cancelLabel="返回核对" confirmVariant="default" busy={openingRetryBusy}
          onConfirm={() => { setOpeningRetryOpen(false); void retryOpeningGeneration(); }}>
          <p className="text-sm">操作会记录当前客服、原付款绑定和审计；不会替双方确认。</p>
        </ConfirmAlertDialog>
        <p className="im-support-fulfillment-empty">核对仍不能证明依据时必须保持待处理；如确认无法交付，请使用下方“取消未开租订单”或既有退款流程，不能凭猜测生成清单。</p>
      </div>) : null}

      {stage.key === "opening-pending" ? <div className="im-support-fulfillment-stage-panel">
        <strong>等待双方确认开租</strong>
        <small>开租清单 v{latestOpening?.versionNo ?? "?"} · {latestOpening?.acks?.map((ack) => partyLabel(ack.party)).join("、") || "暂无确认"}</small>
        {renderInventory("opening")}
        <p className="im-support-fulfillment-empty">双方确认后进入履约；客服可在核实后协助未确认的一方。</p>
        {canManualClose && latestOpening?.status === "DRAFT" && latestOpening.id && Number.isInteger(latestOpening.versionNo) ? <div className="im-support-fulfillment-actions">
          {(["RENTER","OWNER"] as const).filter(party=>!latestOpening.acks?.some(ack=>ack.party===party)).map(party=><Button key={party} type="button" variant="outline" disabled={primaryDisabled} onClick={()=>{setOpeningReason("");setOpeningTarget({id:latestOpening.id!,versionNo:latestOpening.versionNo!,party});}}>协助{partyLabel(party)}确认</Button>)}
        </div> : null}
        <Dialog open={openingTarget!==null} onOpenChange={open=>{if(!open)setOpeningTarget(null);}}><DialogContent>
          <div className="space-y-4"><div><DialogTitle>协助{partyLabel(openingTarget?.party)}确认开租</DialogTitle><DialogDescription>请先核实该方及开租清单。操作记录为客服协助，不会显示为当事人本人确认。</DialogDescription></div>
            {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="协助确认期初原因" value={openingReason} maxLength={500} onChange={e=>setOpeningReason(e.target.value)} /></label>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpeningTarget(null)}>返回核对</Button><Button type="button" disabled={primaryDisabled||openingReason.trim().length<3} onClick={()=>armConfirmation("opening-party")}>核对并继续</Button></div>
          </div>
        </DialogContent></Dialog>
      </div> : null}

      {stage.key === "needs-settlement" || stage.key === "intake-pending" ? <div className="im-support-fulfillment-stage-panel">
        <strong>履约中 · 结算</strong>
        <small>核对数量并预览结算方案；提前结束需要选择原因。</small>
        {view?.consumptionMode==="ACTUAL"?<small>核对实际消耗；期初未申报的物资默认 0。</small>:null}
        {view?.consumptionMode==="UNAVAILABLE"?<Alert variant="destructive"><AlertTitle>结算价格资料暂不可用</AlertTitle><AlertDescription>请先核实本单的冻结价格。</AlertDescription></Alert>:null}
        {renderInventory("remaining")}
        <div className="im-support-fulfillment-controls">
          <label className="space-y-1 block text-xs">
            <span>提前原因</span>
            <div className="relative">
              <Select
                value={endReason || "NONE"}
                disabled={locked}
                onValueChange={(val) => {
                  invalidate();
                  setEndReason(val === "NONE" ? "" : (val as EarlyEndReason));
                }}
                items={[
                  { value: "NONE", label: "正常结算" },
                  { value: "TENANT_VOLUNTARY_EARLY", label: "租客自愿提前" },
                  { value: "OWNER_OR_ACCOUNT_EARLY", label: "号主/账号原因提前" },
                ]}
              >
                <SelectTrigger aria-label="提前原因" className="h-9 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">正常结算</SelectItem>
                  <SelectItem value="TENANT_VOLUNTARY_EARLY">租客自愿提前</SelectItem>
                  <SelectItem value="OWNER_OR_ACCOUNT_EARLY">号主/账号原因提前</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </label>
        </div>
        <div className="im-support-fulfillment-actions">
          <Button type="button" onClick={previewSettlement} disabled={primaryDisabled || lines.length === 0}>预览结算方案</Button>
          {preview && !preview.adjustArmed && preview.versionHash ? <Button type="button" onClick={()=>armConfirmation("classify")} disabled={primaryDisabled}>生成结算方案</Button> : null}
        </div>
      </div> : null}

      {stage.key === "awaiting-decision" || stage.key === "decision-rejected" ? <div className="im-support-fulfillment-stage-panel">
        <strong>{stage.key==="decision-rejected"?"结算方案有争议":"等待买卖双方确认结算"}</strong>
        <small>{current?.decisions?.filter((d) => d.party !== "SUPPORT").map(decisionLabel).join(" · ") || "暂无确认记录"}</small>
        {renderCurrentFacts()}
        <p className="im-support-fulfillment-empty">双方确认后由客服复核；拒绝或争议走人工调整。</p>
      </div> : null}

      {stage.key === "needs-review" ? <div className="im-support-fulfillment-stage-panel">
        <strong>待客服复核</strong>
        <small>双方已确认；请核对本版本数量与金额后复核。</small>
        {renderCurrentFacts()}
        <div className="im-support-fulfillment-actions"><Button type="button" onClick={()=>armConfirmation("review")} disabled={primaryDisabled || !current?.id || !current.versionHash}>确认复核</Button></div>
      </div> : null}

      {stage.key === "reviewed" || stage.key === "normal-version" || stage.key === "posted" ? <div className="im-support-fulfillment-stage-panel">
        <strong>{stage.key === "posted" ? "已生效" : stage.key === "reviewed" ? "已复核，等待生效" : "正常结算版本"}</strong>
        <small>{current ? `结算版本 v${current.versionNo ?? "?"}${current.early ? " · 提前" : ""}` : posting ? `过账 ${posting.postedAt ?? ""}` : ""}</small>
        {renderCurrentFacts()}
        {posting ? <p className="im-support-fulfillment-empty">已过账；退款到期 {posting.refundDueAt ?? "按规则"}。应退不代表渠道退款已到账。</p> : null}
      </div> : null}

      {canManualClose&&current?.kind==="SYSTEM"&&current.id&&current.versionHash&&!posting&&view?.currentRequest?.kind!=="INTAKE"?<div className="im-support-fulfillment-stage-panel">
        <strong>客服处理</strong><small>核实双方情况后，可按当前方案直接结算并记录原因。</small>
        {!finalizationAmountsReady?<Alert variant="warning"><AlertTitle>结算信息尚未完整读取</AlertTitle><AlertDescription>请刷新并核对结算方式、提前结束费用、号主净额与租客应退后再处理。</AlertDescription></Alert>:null}
        <Button type="button" variant="outline" disabled={primaryDisabled||!finalizationAmountsReady} onClick={()=>{
          const parties=(["RENTER","OWNER"] as const).map(party=>{
            const decision=current.decisions?.find(item=>item.party===party && item.versionHash===current.versionHash && (item.action==="CONFIRM"||item.action==="REJECT"));
            return decision ? decisionLabel(decision) : `${partyLabel(party)}未确认`;
          });
          setFinalizeReason("");setFinalizeTarget({id:current.id!,hash:current.versionHash!,versionNo:current.versionNo,early:current.early===true,amounts:currentAmounts,parties});setFinalizeOpen(true);
        }}>客服确认结算</Button>
        <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}><DialogContent>
          <div className="space-y-4"><div><DialogTitle>确认按当前方案结算</DialogTitle><DialogDescription>请核对第 {finalizeTarget?.versionNo} 版金额。结算后将登记本单应退责任，退款到账以渠道结果为准。</DialogDescription></div>
            <p className="text-sm text-muted-foreground">{finalizeTarget?.parties.join(" · ")} · {finalizeTarget?.early ? "提前结算" : "正常结算"}</p>
            <dl>{amountRows(finalizeTarget?.amounts??null).filter(row=>row.key==="ownerNet"||row.key==="renterRefund"||finalizeTarget?.early&&row.key==="earlyMakeup").map(row=><div key={row.key} className="flex justify-between gap-4"><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>
            <label className="block space-y-2"><span>处理原因</span><Textarea value={finalizeReason} maxLength={500} disabled={locked||busy} onChange={event=>setFinalizeReason(event.target.value)} placeholder="说明与双方核实的情况" /></label>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setFinalizeOpen(false)} disabled={busy}>返回</Button><Button onClick={()=>armConfirmation("finalize")} disabled={primaryDisabled||finalizeReason.trim().length<3}>核对并继续</Button></div>
          </div>
        </DialogContent></Dialog>
      </div>:null}

      {preview ? <div className="im-support-fulfillment-preview" aria-label="结算预览结果">
        <strong>{preview.adjustArmed ? "人工调整预览" : "结算方案预览"}</strong>
        {amountRows(previewAmounts).length > 0 ? <dl>{amountRows(previewAmounts).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : <small>服务端未返回金额明细。</small>}
        <small>{preview.early === true ? "按提前结算计算" : preview.early === false ? "按正常结算计算" : ""}</small>
      </div> : null}

      {postingRows.length > 0 ? <div className="im-support-fulfillment-preview" aria-label="已生效金额">
        <strong>已生效金额</strong>
        <dl>{postingRows.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>
      </div> : null}

      {canManualClose&&openingConfirmed&&!posting?<div className="im-support-fulfillment-adjust">
        <Button type="button" variant="ghost" className="im-support-quiet-action" aria-expanded={adjustOpen} onClick={() => setAdjustOpen((value) => !value)}>人工调整（例外）</Button>
        {adjustOpen ? <><p className="text-sm text-muted-foreground">双方对系统方案有争议时，填写协商后的拟结算金额；提交后仍须按现有流程审批与确认。</p><div className="im-support-fulfillment-controls">
          <label>拟结给号主<Input value={ownerNet} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setOwnerNet(event.target.value); }} placeholder="元，如 123.45" /></label>
          <label>拟退给租客<Input value={renterRefund} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setRenterRefund(event.target.value); }} placeholder="元，如 12.00" /></label>
          <label>原因说明<Input value={reason} maxLength={500} disabled={locked} onChange={(event) => { invalidate(); setReason(event.target.value); }} placeholder="不少于3字" /></label>
        </div></> : null}
        {adjustOpen ? <div className="im-support-fulfillment-actions">
          <Button type="button" onClick={previewAdjustment} disabled={primaryDisabled}>生成调整预览</Button>
          {preview?.adjustArmed && preview.versionHash ? <Button type="button" onClick={()=>armConfirmation("adjust")} disabled={primaryDisabled}>提交人工调整</Button> : null}
          {onOpenPath ? <Button type="button" variant="ghost" className="im-support-quiet-action" onClick={() => onOpenPath("/approvals", "审批中心")}>查看申请</Button> : null}
        </div> : null}
      </div>:null}

      <p className="im-support-fulfillment-hint">聊天和已读不会改变订单状态；金额以系统结果为准，"应退"不等于退款已到账。</p>
      </DialogContent>
    </Dialog>
  </Card>
  {canManualClose && orderStatus === "PAID" && view.rentalStarted===false ? <SupportCancelCard orderId={orderId} displayNo={displayNo} compact={compact} /> : null}
  {canManualClose && orderStatus === "PAID" && view.rentalStarted===true ? <SupportPoststartCancelCard orderId={orderId} displayNo={displayNo} viewerId={viewerId} compact={compact} /> : null}
  </>;
}

/** The pending-order path never creates a refund or claims the channel is closed. */
export function SupportUnpaidCancelCard({ orderId, displayNo, onReviewPayment, compact=false }: { orderId: string; displayNo: string; onReviewPayment?: () => void; compact?:boolean }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [error, setError] = useState("");
  const [phase, setPhase] = useState<"IDLE" | "LOADING" | "SENDING" | "UNKNOWN">("IDLE");
  const [view, setView] = useState<SupportUnpaidCancelView | null>(null), [done, setDone] = useState(false);
  const key = useRef("");
  const valid = reason.trim().length >= 3 && new TextEncoder().encode(reason.trim()).length <= 600
    && ![...reason].some(ch => { const code = ch.codePointAt(0)!; return code < 32 && code !== 10 && code !== 13 || code === 127; });
  const openDialog = async () => {
    setOpen(true); setError(""); setReason(""); setView(null); setPhase("LOADING"); key.current = "";
    try {
      const result = await readSupportUnpaidCancel(orderId);
      if (result.contractVersion !== "admin-support-unpaid-cancel.v1" || result.orderId !== orderId
        || typeof result.orderRevision !== "string" || !/^[1-9]\d{0,18}$/.test(result.orderRevision) || typeof result.eligibility?.allowed !== "boolean") throw new Error("INVALID_RESPONSE");
      setView(result); setPhase("IDLE");
    } catch { setError("暂时无法核对付款状态，请刷新后重试。"); setPhase("IDLE"); }
  };
  const submit = async () => {
    if (!view?.eligibility.allowed || !valid || phase === "SENDING") return;
    if (!key.current) key.current = `support_unpaid_${crypto.randomUUID()}`;
    setPhase("SENDING"); setError("");
    const outcome = await sendSupportUnpaidCancel(orderId, view.orderRevision, reason.trim(), key.current);
    if (outcome.kind === "accepted") { setDone(true); setOpen(false); setPhase("IDLE"); return; }
    if (outcome.kind === "unknown") { setPhase("UNKNOWN"); setError("取消结果尚未确认，请按原请求重试或核对订单状态。"); return; }
    setPhase("IDLE"); setView(null);
    setError(outcome.reason === "PAYMENT_REVIEW_REQUIRED" ? "发现付款记录或请求，请先核对付款情况。" : "订单状态已变化或当前无权处理，请刷新后核对。");
  };
  const blocked = view && !view.eligibility.allowed;
  return <Card className={`im-support-fulfillment im-order-card${compact?" oc-action-card":""}`} data-support-unpaid-cancel="true">
    <CardContent className={compact?"grid gap-2 p-0":"grid gap-2 p-4"}>
      <CardTitle className="text-sm">取消待付款订单</CardTitle>
      <CardDescription className="text-xs leading-relaxed">仅可处理尚未发起付款的订单。若已有付款请求或付款记录，请先核对资金状态。</CardDescription>
      {done ? <Alert><ShieldCheck /><AlertTitle>订单已取消</AlertTitle><AlertDescription>账号占用已解除；此操作未向支付渠道发送关单请求。</AlertDescription></Alert>
        : <div><Button type="button" variant="outline" size="sm" onClick={() => void openDialog()}>取消待付款订单</Button></div>}
    </CardContent>
    <ConfirmAlertDialog open={open} onOpenChange={next => { if (!next && (phase === "SENDING" || phase === "UNKNOWN")) return; setOpen(next); }}
      contentLabel="取消待付款订单" title="确认取消待付款订单？" description={`订单 ${displayNo}。系统会再次核查本站付款记录并记录处理人和原因；此操作不请求渠道关单。`}
      confirmLabel={phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : "确认取消"}
      onConfirm={() => void submit()} busy={phase === "SENDING"} confirmDisabled={!view?.eligibility.allowed || !valid}>
      {phase === "LOADING" ? <p role="status">正在核对付款记录…</p> : null}
      {blocked ? <Alert variant="warning"><TriangleAlert /><AlertTitle>暂不能直接取消</AlertTitle><AlertDescription>{view.eligibility.reason === "PAYMENT_REVIEW_REQUIRED" ? "本单已有付款请求或记录，请先核对付款情况。" : "订单状态已变化，请刷新后查看。"}</AlertDescription>{view.eligibility.reason === "PAYMENT_REVIEW_REQUIRED" && onReviewPayment ? <AlertAction><Button variant="outline" size="sm" onClick={() => { setOpen(false); onReviewPayment(); }}>查看资金与退款</Button></AlertAction> : null}</Alert> : null}
      <label className="im-wb-dialog-note"><span>取消原因（必填）</span><Textarea value={reason} maxLength={150} rows={3} aria-label="待付款订单取消原因"
        placeholder="说明与双方核实的情况" disabled={phase === "SENDING" || phase === "UNKNOWN" || !view?.eligibility.allowed}
        onChange={event => setReason(event.target.value)} /></label>
      {error ? <p role="alert" className="im-wb-dialog-error"><CircleAlert size={14}/>{error}</p> : null}
    </ConfirmAlertDialog>
  </Card>;
}

const SUPPORT_CANCEL_REASON_TEXT: Record<string, string> = {
  ORDER_COMPLETED: "结算已生成或订单已完成，不能在这里取消；请走财务/售后退款。",
  ORDER_NOT_PAID: "订单当前不是已付款可取消状态；请刷新后核对。",
  PAYMENT_BASIS_UNAVAILABLE: "原支付单不可用，不能安全发起原路退款。",
  OPENING_ALREADY_CONFIRMED: "订单已确认开租，请使用现有结算与退款流程；不能按未开租全额取消。",
  SETTLEMENT_ALREADY_POSTED: "结算已落账，不能在这里取消；请走财务/售后退款。",
  SETTLEMENT_DRAFT_EXISTS: "存在结算草稿或受理单，请先处理或关闭结算后再取消。",
  MANUAL_ADJUSTMENT_REVIEW: "存在待处理金额调整，请先处理后再取消。",
  DISTRIBUTION_RECONCILIATION_REQUIRED: "存在待核对的佣金/分销收益，请先转财务核对。",
  REFUND_PENDING: "本单已有未完成的退款申请，请先处理退款。",
  TERMINATION_PENDING: "本单已有未处理的终止申请，请先处理。",
  ALREADY_CANCELLED: "订单已取消。",
  ORDER_CHANGED: "订单已变化，请刷新后重新核对退款资格。",
};
const SUPPORT_CANCEL_UNKNOWN = "取消结果未确认。请先刷新订单核对；不要用新原因重复提交，可在本页按原请求重试。";

function supportCancelReasonText(reason: string | null | undefined): string {
  return reason && SUPPORT_CANCEL_REASON_TEXT[reason] ? SUPPORT_CANCEL_REASON_TEXT[reason]! : "当前状态不满足客服取消条件，请刷新后核对。";
}

function supportCancelRefundText(view: SupportCancelView | null): string {
  if (view?.simulationScope) {
    const latest = view.refund?.intents?.at(-1);
    if (latest?.requiresReview || latest?.state === "REVIEW_REQUIRED") return "模拟退款需要核对，不会实际退回款项。";
    if (latest?.state === "SUCCEEDED") return "模拟退款已完成，不会实际退回款项。";
    if (latest?.state === "FAILED") return "模拟退款未完成，不会实际退回款项。";
    return "模拟退款待处理，不会实际退回款项。";
  }
  if (!view?.refund || view.refund.integration !== "INTEGRATED" || !view.refund.intents?.length) {
    return "退款责任已登记，退款进度尚未记录；银行到账未知。";
  }
  const latest = view.refund.intents[view.refund.intents.length - 1]!;
  if (latest.requiresReview || latest.state === "REVIEW_REQUIRED") return "退款需人工复核；银行到账未知。";
  if (latest.state === "SUCCEEDED") return "本站已记录退款处理结果，银行到账未知。";
  if (latest.state === "FAILED") return "退款处理未完成，请核对记录。";
  if (latest.state === "SUBMITTING" || latest.state === "PROCESSING") return "退款处理中，结果未确认。";
  if (latest.state === "UNKNOWN") return "退款结果未确认，不能视为已退款。";
  return "退款待处理；银行到账未知。";
}

function SupportCancelCard({ orderId, displayNo, compact=false }: { orderId: string; displayNo: string; compact?:boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<"IDLE" | "LOADING" | "SENDING" | "UNKNOWN">("IDLE");
  const [preview, setPreview] = useState<SupportCancelView | null>(null);
  const [result, setResult] = useState<SupportCancelView | null>(null);
  const [error, setError] = useState("");
  const keyRef = useRef("");
  const trimmed = reason.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 600
    && ![...reason].some((ch) => { const code = ch.codePointAt(0)!; return code < 32 && code !== 10 && code !== 13 || code === 127; });

  const openDialog = async () => {
    if (phase !== "UNKNOWN") keyRef.current = "";
    setError("");
    setReason("");
    setPreview(null);
    setPhase("LOADING");
    setOpen(true);
    try {
      const view = await readSupportCancel(orderId);
      setPreview(view);
      if (view.supportCancellation) setResult(view);
      setPhase("IDLE");
    } catch (cause) {
      setPhase("IDLE");
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 423)) setError("登录状态已变化；请重新确认管理员身份后核对。");
      else if (cause instanceof AdminApiError && cause.status === 403) setError("当前账号不是本单客服，或没有订单结算写权限。");
      else if (cause instanceof AdminApiError && cause.status === 404) setError("当前无法办理客服取消或读取订单，请核对订单和付款信息。");
      else setError(friendlyError(cause));
    }
  };

  const submit = async () => {
    if (!valid || phase === "SENDING" || !preview?.eligibility.allowed) return;
    if (!keyRef.current) keyRef.current = `support_cancel_${orderId}_${crypto.randomUUID()}`;
    setPhase("SENDING");
    setError("");
    const outcome = await sendSupportCancel(orderId, preview.orderRevision, trimmed, keyRef.current);
    if (outcome.kind === "accepted") {
      if (outcome.view.simulationScope !== preview.simulationScope) {
        setPhase("UNKNOWN");
        setError(SUPPORT_CANCEL_UNKNOWN);
        return;
      }
      setResult(outcome.view);
      setPreview(outcome.view);
      setOpen(false);
      setPhase("IDLE");
      try {
        const fresh = await readSupportCancel(orderId);
        if (fresh.simulationScope === outcome.view.simulationScope) { setResult(fresh); setPreview(fresh); }
      } catch { /* the accepted receipt is already durable; a failed read must not undo it */ }
      return;
    }
    if (outcome.kind === "unknown") {
      setPhase("UNKNOWN");
      setError(SUPPORT_CANCEL_UNKNOWN);
      return;
    }
    if (outcome.kind === "auth") {
      setPhase("IDLE");
      setError("登录状态已变化；请重新确认管理员身份后核对。");
      return;
    }
    setPhase("IDLE");
    setError(supportCancelReasonText(outcome.reasons[0]));
  };

  const refundCents = result?.supportCancellation?.refundCents ?? preview?.eligibility.refundCents ?? null;
  const blocked = preview !== null && !preview.eligibility.allowed && !preview.supportCancellation;
  const simulated = preview?.simulationScope !== undefined;
  return <Card id={`support-cancel-${orderId}`} tabIndex={-1} className={`im-support-fulfillment im-order-card${compact?" oc-action-card":""}`} data-support-cancel="true" aria-label="客服取消订单退款">
    <CardContent className={compact?"grid gap-2 p-0":"grid gap-2 p-4"}>
      <CardTitle className="flex items-center gap-2 text-sm"><TriangleAlert className="size-4 shrink-0 text-destructive" />取消未开租订单</CardTitle>
      <CardDescription className="text-xs leading-relaxed">仅限尚未确认开租的订单，核实未使用且无争议后登记全额退款责任。已开租订单请使用正常或提前结算。</CardDescription>
      {result ? <Alert><ShieldCheck /><AlertTitle>已取消并登记全额退款</AlertTitle><AlertDescription>
        退款金额 {formatFundingCents(refundCents)}（原支付金额）。{supportCancelRefundText(result)} 订单已取消，群聊保留。
      </AlertDescription></Alert>
        : <div className="im-support-fulfillment-actions">
          <Button variant="outline" size="sm" data-action="support-cancel-open" onClick={() => void openDialog()}>取消订单</Button>
        </div>}
      {error && !open ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </CardContent>
    <ConfirmAlertDialog open={open} onOpenChange={(next) => { if (!next && (phase === "SENDING" || phase === "UNKNOWN")) return; setOpen(next); }}
      contentLabel="取消订单确认" title={simulated?"确认取消订单并模拟退款？":"确认取消订单并登记退款？"}
      description={simulated?`订单 ${displayNo}。提交后订单立即取消，退款仅用于测试，不会实际退回款项。`:`订单 ${displayNo}。提交后订单立即取消，并登记原支付金额的全额退款责任；渠道提交结果和银行到账状态未知。`}
      confirmLabel={phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : simulated?"确认取消并模拟退款":"确认取消并退款"}
      onConfirm={() => void submit()} busy={phase === "SENDING"} confirmDisabled={!preview?.eligibility.allowed || !valid}>
      {phase === "LOADING" ? <p className="im-wb-dialog-hint">正在读取退款资格与金额…</p> : null}
      {preview ? <div className="grid gap-2">
        <p className="text-sm"><strong>退款金额：{formatFundingCents(preview.eligibility.refundCents ?? preview.supportCancellation?.refundCents)}</strong>（原支付金额）</p>
        <p className="im-wb-dialog-hint">{preview.openingConfirmed ? "订单已确认开租，请使用现有结算与退款流程。" : "订单尚未确认开租；核实未使用且无争议后登记全额应退。"} {simulated?"这是模拟退款，不会实际退回款项。":"渠道提交结果与银行到账状态未知，不能把本地退款责任当成已到账。"}</p>
        {blocked ? <Alert variant="warning"><TriangleAlert /><AlertTitle>当前不可取消</AlertTitle><AlertDescription>{supportCancelReasonText(preview.eligibility.reason)}</AlertDescription></Alert> : null}
      </div> : null}
      {preview?.supportCancellation ? <Alert><ShieldCheck /><AlertTitle>已存在客服取消记录</AlertTitle><AlertDescription>{supportCancelRefundText(preview)}</AlertDescription></Alert> : null}
      <label className="im-wb-dialog-note"><span>取消原因（必填，3–600 字）<em>{reason.length}/600</em></span>
        <Textarea value={reason} maxLength={600} rows={3} aria-label="客服取消原因" data-support-cancel-reason="true"
          placeholder="说明取消原因与已与双方沟通的事实" disabled={phase === "SENDING" || phase === "UNKNOWN" || !preview?.eligibility.allowed}
          onChange={(event) => { setReason(event.target.value); setError(""); }} />
      </label>
      {error ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </ConfirmAlertDialog>
  </Card>;
}
