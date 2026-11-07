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
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "../components/ui/item";
import { formatFundingCents } from "./supply-review/model";
import { SupplyWriteLockError, withSupplyWriteLock } from "../lib/supply-write-lock";
import {
  buildFulfillmentIntent,
  readOrderSettlement,
  readSupportCancel,
  readSupportUnpaidCancel,
  sendFulfillmentIntent,
  sendManualClose,
  sendSupportCancel,
  sendSupportUnpaidCancel,
  type ManualCloseResult,
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
  DISCOUNT_OWNER_FUNDING_INSUFFICIENT:"折后实际消耗不足以覆盖号主应得，请核对会员折扣和本单价格。",
  INSUFFICIENT_PREPAYMENT:"本单实付不足以覆盖结算费用，请核对数量并与双方沟通。",
  SETTLEMENT_PRICING_INVALID:"本单冻结价格资料无法核实，请联系维护人员。",
  ORDER_PARTY_UNAVAILABLE:"订单一方账号当前不可用，请核实身份和资金状态后处理。",
};

const AMOUNT_LABELS: Record<string, string> = {
  haffConsumedBuyer: "哈夫币消耗（租客侧）",
  haffConsumedOwner: "哈夫币消耗（号主侧）",
  itemConsumedBuyer: "物品消耗（租客侧）",
  itemConsumedOwner: "物品消耗（号主侧）",
  unusedItemRefund: "未消耗物资预付款（扣费前）",
  unusedHaffRefund: "未消耗哈夫币预付款（扣费前）",
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

/**
 * Admin-only fulfillment section. Writes are frozen intents persisted by
 * (admin subject, order): an unknown result keeps its responsibility across
 * unmounts and only a receipt for the SAME key resolves it (same-key replay or
 * an accepted write's readback). A plain GET only observes the current state.
 * Frozen order inventory arrives through the authorized IM slot projection;
 * the section never computes money and never writes an order/ledger row.
 */
export function OrderFulfillmentSection({ orderId, displayNo, viewerId, orderStatus, frozenInventory, canManualClose }: { orderId: string; displayNo: string; viewerId: string; orderStatus?: string; frozenInventory?: InventoryLine[]; canManualClose?: boolean }) {
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
  const [finalizeTarget,setFinalizeTarget]=useState<{id:string;hash:string;versionNo:number|undefined;amounts:Record<string,unknown>|null}|null>(null);
  const [openingTarget,setOpeningTarget]=useState<{id:string;versionNo:number;party:"RENTER"|"OWNER"}|null>(null);
  const [openingReason,setOpeningReason]=useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generationRef = useRef(0);
  const intentRef = useRef<FulfillmentIntent | null>(null);
  intentRef.current = intent;
  const scopeRef = useRef("");
  scopeRef.current = `${viewerId}:${orderId}`;
  const scope = scopeRef.current;

  /** Session loss hides every private projection immediately; the intent/phase survive. */
  const hidePrivate = () => {
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
            value:actual?recorded?.consumedQuantity??"":recorded?.remainingQuantity??line.quantity??"" };
        });
      const extra=actual?(next.extraResources??[]).filter(line=>!declared.some(item=>item.itemId===line.itemId))
        .map(line=>({itemId:line.itemId,name:line.name,unit:line.unit,value:saved.get(line.itemId)?.consumedQuantity??"0"})):[];
      setLines([...declared,...extra]);
      return;
    }
    if (frozenInventory && frozenInventory.length > 0) {
      setLines(frozenInventory.map((line) => ({ itemId: line.itemId, name: line.name, unit: line.unit, value: line.quantity })));
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

  const linesForOpening = () => lines.map((line) => ({ itemId: line.itemId, quantity: line.value }));
  const linesForRemaining = () => lines.map((line) => view?.consumptionMode==="ACTUAL"
    ?{ itemId:line.itemId,consumedQuantity:line.value }:{ itemId:line.itemId,remainingQuantity:line.value });

  const latestOpening = view?.openings?.[view.openings.length - 1];
  const openingConfirmed = Boolean(view?.openings?.some((opening) => opening.status === "CONFIRMED"));
  const current = view?.settlement ?? null;
  const posting = view?.posting ?? null;
  const partyConfirmed = Boolean(current?.decisions?.some((d) => d.party === "RENTER" && d.action === "CONFIRM")
    && current?.decisions?.some((d) => d.party === "OWNER" && d.action === "CONFIRM"));
  const supportReviewed = Boolean(current?.decisions?.some((d) => d.party === "SUPPORT" && d.action === "REVIEW"));

  const stage = useMemo(() => {
    if (posting) return { key: "posted", label: "已生效" } as const;
    if (!openingConfirmed && latestOpening) return { key: "opening-pending", label: "等待双方确认期初" } as const;
    if (!openingConfirmed) return { key: "needs-opening", label: "待期初代录" } as const;
    if (view?.currentRequest?.kind === "INTAKE") return { key: "intake-pending", label: "有结算申请待处理" } as const;
    if (!current) return { key: "needs-settlement", label: "履约中 · 待结算" } as const;
    if (current.early && !partyConfirmed) return { key: "awaiting-decision", label: "等待双方确认结算" } as const;
    if (current.early && partyConfirmed && !supportReviewed) return { key: "needs-review", label: "待客服复核" } as const;
    if (current.early) return { key: "reviewed", label: "已复核" } as const;
    return { key: "normal-version", label: "正常结算版本" } as const;
  }, [posting, openingConfirmed, latestOpening, view?.currentRequest?.kind, current, partyConfirmed, supportReviewed]);

  const task = useMemo(() => {
    switch (stage.key) {
      case "needs-opening": return { title: "待核对期初", action: "核对并录入期初" };
      case "opening-pending": return { title: "等待双方确认期初", action: "查看期初清单" };
      case "intake-pending": return { title: "有结束申请待处理", action: "打开核对面板" };
      case "needs-settlement": return { title: "履约中 · 等待结算", action: "打开核对面板" };
      case "awaiting-decision": return { title: "等待双方确认结算", action: "查看本版明细" };
      case "needs-review": return { title: "待客服复核", action: "打开复核面板" };
      case "reviewed": return { title: "已复核，等待生效", action: "查看结算明细" };
      case "normal-version": return { title: "正常结算版本", action: "查看结算明细" };
      default: return { title: "已过账", action: "查看过账明细" };
    }
  }, [stage.key]);

  // 确认状态只认同一版本上的 ack/decision：新版本会让旧确认失效。
  const partyFacts = useMemo(() => {
    if (stage.key === "opening-pending") {
      return { version: `期初清单 v${latestOpening?.versionNo ?? "?"}`, rows: (["RENTER", "OWNER"] as const).map((party) => {
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
  const finalizationAmountsReady=isSettlementMoney(currentAmounts?.ownerNet)&&isSettlementMoney(currentAmounts?.renterRefund);
  const currentInputLines = (current?.inputSnapshot?.lines ?? []) as Array<{ itemId?: string; openingQuantity?: string; remainingQuantity?: string; consumedQuantity?:string }>;
  const postingRows = amountRows((posting?.amounts ?? null) as Record<string, unknown> | null);

  const recordOpening = () => {
    if (lines.length === 0 || lines.some((line) => !/^(0|[1-9]\d{0,18})$/.test(line.value))) {
      setError("请填写有效的期初数量（非负整数）。");
      return;
    }
    void beginIntent({ kind: "record-opening", lines: linesForOpening() });
  };
  const previewSettlement = () => {
    if (lines.length === 0 || lines.some((line) => !/^(0|[1-9]\d{0,18})$/.test(line.value))) {
      setError(view?.consumptionMode==="ACTUAL"?"请填写有效的实际消耗数量（非负整数）。":"请填写有效的剩余数量（非负整数）。");
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

  const renderInventory = (mode: "opening" | "remaining") => lines.length > 0 ? <div className="im-support-fulfillment-lines" role="group" aria-label={mode === "opening" ? "期初库存" : view?.consumptionMode==="ACTUAL"?"实际消耗":"剩余库存"}>
    {lines.map((line, index) => <label key={line.itemId}><span>{line.name ?? "物资"}{line.unit ? ` · ${UNIT_LABELS[line.unit] ?? line.unit}` : ""}</span><Input value={line.value} inputMode="numeric" disabled={locked} onChange={(event) => setLineValue(index, event.target.value)} aria-label={`${line.name ?? line.itemId} ${mode === "opening" ? "期初数量" : view?.consumptionMode==="ACTUAL"?"实际消耗数量":"剩余数量"}`} /></label>)}
  </div> : <p className="im-support-fulfillment-empty">服务端未返回订单冻结库存投影，无法代录期初；请核对订单状态。</p>;

  const renderCurrentFacts = () => current ? <div className="im-support-fulfillment-preview" aria-label="当前结算版本事实">
    <strong>当前结算版本 v{current.versionNo ?? "?"}{current.early ? " · 提前" : ""}（双方核对依据）</strong>
    {currentInputLines.length > 0 ? <div className="im-support-fulfillment-lines" role="group" aria-label="当前版本数量">
      {currentInputLines.map((line) => {
        const facts = line.itemId ? inventoryName(line.itemId) : { name: null, unit: "" };
        return <label key={line.itemId ?? "line"}><span>{facts.name ?? "物资"}{facts.unit ? ` · ${UNIT_LABELS[facts.unit] ?? facts.unit}` : ""}{line.consumedQuantity===undefined?" · 期末剩余":" · 实际消耗"}</span><output>{line.consumedQuantity??line.remainingQuantity ?? line.openingQuantity ?? "—"}</output></label>;
      })}
    </div> : null}
    {amountRows(currentAmounts).length > 0 ? <dl>{amountRows(currentAmounts).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : <small>暂无金额明细。</small>}
  </div> : null;

  const statusMessages = <>
    {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert variant="info" role="status"><Info /><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {storageBlocked ? <Alert variant="destructive"><CircleAlert /><AlertTitle>本地暂存不可用</AlertTitle><AlertDescription>{phase === "ACCEPTED_READBACK_PENDING" ? ACCEPTED_STORAGE_WARNING : "本地无法保存操作记录，已阻止新操作；请刷新后重试。"}</AlertDescription></Alert> : null}
    {phase !== "IDLE" ? <Alert role="status" variant="warning"><TriangleAlert /><AlertTitle>{phase === "SENDING" ? "本次操作正在发送" : phase === "AUTH" ? "登录状态已变化，原责任仍保留" : phase === "ACCEPTED_READBACK_PENDING" ? "操作已受理，等待最新状态" : "本次操作结果未确认"}</AlertTitle><AlertDescription>
      {phase === "SENDING" ? "请求尚未返回，请勿重复提交。" : phase === "AUTH" ? "原操作记录仍保留。" : phase === "ACCEPTED_READBACK_PENDING" ? "操作已受理，等待读取最新状态；不会重复提交。" : "原操作记录与责任已保留。"}
    </AlertDescription><AlertAction>
      <Button variant="outline" size="xs" onClick={() => void observeCurrent()} disabled={loading || busy}>查看当前状态</Button>
      {phase !== "SENDING" && phase !== "ACCEPTED_READBACK_PENDING" ? <Button variant="outline" size="xs" onClick={() => void replay()} disabled={busy || loading}>按原请求重放</Button> : null}
    </AlertAction></Alert> : null}
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
  return <><Card className="im-support-fulfillment im-order-card" data-stage={stage.key} aria-label="本单当前任务">
    <CardContent className="grid gap-2.5 p-4">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <CardTitle className="flex items-start gap-2 text-sm"><ClipboardList className="mt-0.5 size-4 shrink-0 text-primary" />履约核对</CardTitle>
          <CardDescription className="text-xs leading-relaxed">在此核对开租清单和结算金额。聊天记录不会自动改变订单状态。</CardDescription>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-1.5">
          <Button size="sm" data-action="open-fulfillment-panel" onClick={() => setPanelOpen(true)}>{task.action}</Button>
          {readButton}
        </div>
      </div>
      {panelOpen ? null : statusMessages}
    </CardContent>

    <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
      <DialogContent className="im-order-panel" aria-label={task.title} showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><strong>{task.title}</strong><span>订单 {displayNo} · {stage.label}</span></div><Button type="button" variant="ghost" size="icon" onClick={() => setPanelOpen(false)} aria-label="关闭核对面板"><X size={14} /></Button></div>
        {statusMessages}
        {partyFacts ? <div className="im-order-parties overflow-hidden rounded-lg border">
          <div className="bg-muted/60 px-3 py-2 text-xs font-semibold text-muted-foreground">双方确认 · {partyFacts.version}</div>
          <ItemGroup className="divide-y divide-border">
            {partyFacts.rows.map((row) => <Item key={row.party} size="sm" className="gap-2 px-3 py-2">
              <ItemContent><ItemTitle className="text-sm">{partyLabel(row.party)}</ItemTitle></ItemContent>
              <ItemActions><Badge variant={row.confirmed ? "secondary" : "destructive"} data-state={row.confirmed ? "confirmed" : "pending"}>{row.confirmed ? row.source === "ON_BEHALF" ? "客服协助确认" : row.source === "AUTO" ? "自动确认" : "已确认" : "待确认"}</Badge></ItemActions>
            </Item>)}
          </ItemGroup>
          <p className="px-3 py-2 text-xs text-muted-foreground">{supportReviewed ? "客服已复核本版本。" : "当事人无法操作时，客服可在核实后协助处理并记录原因。"}</p>
        </div> : null}

      {stage.key === "needs-opening" ? <div className="im-support-fulfillment-stage-panel">
        <strong>第一步：期初代录</strong>
        <small>按订单冻结库存填写期初数量；数量必须与已付款订单的报价一致。</small>
        {renderInventory("opening")}
        <div className="im-support-fulfillment-actions"><Button type="button" onClick={recordOpening} disabled={primaryDisabled || lines.length === 0}>期初代录</Button></div>
      </div> : null}

      {stage.key === "opening-pending" ? <div className="im-support-fulfillment-stage-panel">
        <strong>等待买卖双方确认期初</strong>
        <small>期初 v{latestOpening?.versionNo ?? "?"} · {latestOpening?.acks?.map((ack) => partyLabel(ack.party)).join("、") || "暂无确认"}</small>
        {renderInventory("opening")}
        <p className="im-support-fulfillment-empty">双方确认后进入履约；客服可在核实后协助未确认的一方。</p>
        {canManualClose && latestOpening?.status === "DRAFT" && latestOpening.id && Number.isInteger(latestOpening.versionNo) ? <div className="im-support-fulfillment-actions">
          {(["RENTER","OWNER"] as const).filter(party=>!latestOpening.acks?.some(ack=>ack.party===party)).map(party=><Button key={party} type="button" variant="outline" disabled={primaryDisabled} onClick={()=>{setOpeningReason("");setOpeningTarget({id:latestOpening.id!,versionNo:latestOpening.versionNo!,party});}}>协助{partyLabel(party)}确认</Button>)}
        </div> : null}
        <Dialog open={openingTarget!==null} onOpenChange={open=>{if(!open)setOpeningTarget(null);}}><DialogContent>
          <div className="space-y-4"><div><DialogTitle>协助{partyLabel(openingTarget?.party)}确认期初</DialogTitle><DialogDescription>请先核实该方及期初清单。操作记录为客服协助，不会显示为当事人本人确认。</DialogDescription></div>
            {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="协助确认期初原因" value={openingReason} maxLength={500} onChange={e=>setOpeningReason(e.target.value)} /></label>
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpeningTarget(null)}>返回核对</Button><Button type="button" disabled={primaryDisabled||openingReason.trim().length<3} onClick={confirmOpeningForParty}>确认协助</Button></div>
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
          {preview && !preview.adjustArmed && preview.versionHash ? <Button type="button" onClick={classify} disabled={primaryDisabled}>生成结算方案</Button> : null}
        </div>
      </div> : null}

      {stage.key === "awaiting-decision" ? <div className="im-support-fulfillment-stage-panel">
        <strong>等待买卖双方确认结算</strong>
        <small>{current?.decisions?.filter((d) => d.party !== "SUPPORT").map(decisionLabel).join(" · ") || "暂无确认记录"}</small>
        {renderCurrentFacts()}
        <p className="im-support-fulfillment-empty">双方确认后由客服复核；拒绝或争议走人工调整。</p>
      </div> : null}

      {stage.key === "needs-review" ? <div className="im-support-fulfillment-stage-panel">
        <strong>待客服复核</strong>
        <small>双方已确认；请核对本版本数量与金额后复核。</small>
        {renderCurrentFacts()}
        <div className="im-support-fulfillment-actions"><Button type="button" onClick={review} disabled={primaryDisabled || !current?.id || !current.versionHash}>确认复核</Button></div>
      </div> : null}

      {stage.key === "reviewed" || stage.key === "normal-version" || stage.key === "posted" ? <div className="im-support-fulfillment-stage-panel">
        <strong>{stage.key === "posted" ? "已生效" : stage.key === "reviewed" ? "已复核，等待生效" : "正常结算版本"}</strong>
        <small>{current ? `结算版本 v${current.versionNo ?? "?"}${current.early ? " · 提前" : ""}` : posting ? `过账 ${posting.postedAt ?? ""}` : ""}</small>
        {renderCurrentFacts()}
        {posting ? <p className="im-support-fulfillment-empty">已过账；退款到期 {posting.refundDueAt ?? "按规则"}。应退不代表渠道退款已到账。</p> : null}
      </div> : null}

      {canManualClose&&current?.kind==="SYSTEM"&&current.id&&current.versionHash&&!posting&&view?.currentRequest?.kind!=="INTAKE"?<div className="im-support-fulfillment-stage-panel">
        <strong>客服处理</strong><small>核实双方情况后，可按当前方案直接结算并记录原因。</small>
        {!finalizationAmountsReady?<Alert variant="warning"><AlertTitle>结算金额尚未完整读取</AlertTitle><AlertDescription>请刷新并核对号主净额与租客应退后再处理。</AlertDescription></Alert>:null}
        <Button type="button" variant="outline" disabled={primaryDisabled||!finalizationAmountsReady} onClick={()=>{setFinalizeReason("");setFinalizeTarget({id:current.id!,hash:current.versionHash!,versionNo:current.versionNo,amounts:currentAmounts});setFinalizeOpen(true);}}>客服确认结算</Button>
        <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}><DialogContent>
          <div className="space-y-4"><div><DialogTitle>确认按当前方案结算</DialogTitle><DialogDescription>请核对第 {finalizeTarget?.versionNo} 版金额。结算后将登记本单应退责任，退款到账以渠道结果为准。</DialogDescription></div>
            <dl>{amountRows(finalizeTarget?.amounts??null).filter(row=>row.key==="ownerNet"||row.key==="renterRefund").map(row=><div key={row.key} className="flex justify-between gap-4"><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>
            <label className="block space-y-2"><span>处理原因</span><Textarea value={finalizeReason} maxLength={500} disabled={locked||busy} onChange={event=>setFinalizeReason(event.target.value)} placeholder="说明与双方核实的情况" /></label>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setFinalizeOpen(false)} disabled={busy}>返回</Button><Button onClick={finalize} disabled={primaryDisabled||finalizeReason.trim().length<3}>确认结算</Button></div>
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

      <div className="im-support-fulfillment-adjust">
        <Button type="button" variant="ghost" className="im-support-quiet-action" aria-expanded={adjustOpen} onClick={() => setAdjustOpen((value) => !value)}>人工调整（例外）</Button>
        {adjustOpen ? <div className="im-support-fulfillment-controls">
          <label>号主拟净额<input value={ownerNet} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setOwnerNet(event.target.value); }} placeholder="元，如 123.45" /></label>
          <label>租客拟退款<input value={renterRefund} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setRenterRefund(event.target.value); }} placeholder="元，如 12.00" /></label>
          <label>原因说明<input value={reason} maxLength={500} disabled={locked} onChange={(event) => { invalidate(); setReason(event.target.value); }} placeholder="不少于3字" /></label>
        </div> : null}
        {adjustOpen ? <div className="im-support-fulfillment-actions">
          <Button type="button" onClick={previewAdjustment} disabled={primaryDisabled}>生成调整预览</Button>
          {preview?.adjustArmed && preview.versionHash ? <Button type="button" onClick={adjust} disabled={primaryDisabled}>提交人工调整</Button> : null}
        </div> : null}
      </div>

      <p className="im-support-fulfillment-hint">聊天和已读不会改变订单状态；金额以系统结果为准，"应退"不等于退款已到账。</p>
      </DialogContent>
    </Dialog>
  </Card>
  {canManualClose && orderStatus === "PAID" ? <ManualCloseCard orderId={orderId} displayNo={displayNo} onSettlement={() => { void load(); setPanelOpen(true); }} /> : null}
  {canManualClose && orderStatus === "PAID" ? <SupportCancelCard orderId={orderId} displayNo={displayNo} /> : null}
  </>;
}

/** The pending-order path never creates a refund or claims the channel is closed. */
export function SupportUnpaidCancelCard({ orderId, displayNo, onReviewPayment }: { orderId: string; displayNo: string; onReviewPayment?: () => void }) {
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
  return <Card className="im-support-fulfillment im-order-card" data-support-unpaid-cancel="true">
    <CardContent className="grid gap-2 p-4">
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
  if (!view?.refund || view.refund.integration !== "INTEGRATED" || !view.refund.intents?.length) {
    return "退款责任已登记，等待系统提交原路退款；银行到账未知。";
  }
  const latest = view.refund.intents[view.refund.intents.length - 1]!;
  if (latest.requiresReview || latest.state === "REVIEW_REQUIRED") return "退款需人工复核；银行到账未知。";
  if (latest.state === "SUCCEEDED") return "渠道退款成功（本地核销），银行到账未知。";
  if (latest.state === "FAILED") return "渠道退款失败（未扣款），请转财务处理。";
  if (latest.state === "SUBMITTING" || latest.state === "PROCESSING") return "渠道处理中，结果未确认。";
  if (latest.state === "UNKNOWN") return "渠道结果未确认，不能视为已退款。";
  return "原路退款待提交；银行到账未知。";
}

function SupportCancelCard({ orderId, displayNo }: { orderId: string; displayNo: string }) {
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
      else if (cause instanceof AdminApiError && cause.status === 404) setError("当前无法办理客服取消或读取订单，请核对退款责任。");
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
      setResult(outcome.view);
      setPreview(outcome.view);
      setOpen(false);
      setPhase("IDLE");
      try {
        const fresh = await readSupportCancel(orderId);
        setResult(fresh);
        setPreview(fresh);
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
  return <Card id={`support-cancel-${orderId}`} tabIndex={-1} className="im-support-fulfillment im-order-card" data-support-cancel="true" aria-label="客服取消订单退款">
    <CardContent className="grid gap-2 p-4">
      <CardTitle className="flex items-center gap-2 text-sm"><TriangleAlert className="size-4 shrink-0 text-destructive" />取消订单（全额原路退款）</CardTitle>
      <CardDescription className="text-xs leading-relaxed">仅限尚未确认开租的订单，核实未使用且无争议后登记全额原路退款。已开租订单请使用正常或提前结算；退款是否到账需另行核对。</CardDescription>
      {result ? <Alert><ShieldCheck /><AlertTitle>已取消并登记全额退款</AlertTitle><AlertDescription>
        退款金额 {formatFundingCents(refundCents)}（原支付金额）。{supportCancelRefundText(result)} 订单已取消，群聊保留；退款处理结果以渠道与财务核对为准。
      </AlertDescription></Alert>
        : <div className="im-support-fulfillment-actions">
          <Button variant="outline" size="sm" data-action="support-cancel-open" onClick={() => void openDialog()}>取消订单</Button>
        </div>}
      {error && !open ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </CardContent>
    <ConfirmAlertDialog open={open} onOpenChange={(next) => { if (!next && (phase === "SENDING" || phase === "UNKNOWN")) return; setOpen(next); }}
      contentLabel="取消订单确认" title="确认取消订单并全额原路退款？"
      description={`订单 ${displayNo}。提交后订单立即取消，并登记原支付金额的全额退款责任；渠道提交结果和银行到账状态未知。`}
      confirmLabel={phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : "确认取消并退款"}
      onConfirm={() => void submit()} busy={phase === "SENDING"} confirmDisabled={!preview?.eligibility.allowed || !valid}>
      {phase === "LOADING" ? <p className="im-wb-dialog-hint">正在读取退款资格与金额…</p> : null}
      {preview ? <div className="grid gap-2">
        <p className="text-sm"><strong>退款金额：{formatFundingCents(preview.eligibility.refundCents ?? preview.supportCancellation?.refundCents)}</strong>（原支付金额，原路退回）</p>
        <p className="im-wb-dialog-hint">{preview.openingConfirmed ? "订单已确认开租，请使用现有结算与退款流程。" : "订单尚未确认开租；核实未使用且无争议后登记全额应退。"} 渠道提交结果与银行到账状态未知，不能把本地退款责任当成已到账。</p>
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

function ManualCloseCard({ orderId, displayNo, onSettlement }: { orderId: string; displayNo: string; onSettlement: () => void }) {
  const [open, setOpen] = useState(false);
  const [remark, setRemark] = useState("");
  const [phase, setPhase] = useState<"IDLE" | "SENDING" | "UNKNOWN">("IDLE");
  const [result, setResult] = useState<ManualCloseResult | null>(null);
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState<"PRESTART_REFUND_REQUIRED" | "SETTLEMENT_REQUIRED" | null>(null);
  const keyRef = useRef("");
  const valid = remark.trim().length >= 3 && remark.trim().length <= 200
    && ![...remark].some((ch) => { const code = ch.codePointAt(0)!; return code < 32 || code === 127; });
  const submit = async () => {
    if (!valid || phase === "SENDING" || result) return;
    if (!keyRef.current) keyRef.current = `manual_close_${orderId}_${crypto.randomUUID()}`;
    setPhase("SENDING"); setError("");
    try {
      const closed = await sendManualClose(orderId, remark.trim(), keyRef.current);
      setResult(closed); setPhase("IDLE"); setOpen(false);
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 409 && (cause.reason === "PRESTART_REFUND_REQUIRED" || cause.reason === "SETTLEMENT_REQUIRED")) {
        setResolution(cause.reason); setPhase("IDLE"); setOpen(false); setError(""); return;
      }
      if (cause instanceof AdminApiError && (cause.status === 0 || cause.status === 429 || cause.status >= 500)) {
        setPhase("UNKNOWN");
        setError("结果未确认，请刷新订单核对；不要用新备注重复提交，可保留本页重试同一请求。");
      } else {
        setPhase("IDLE");
        const code = cause instanceof AdminApiError ? cause.code : "";
        setError(code === "ORDER_NOT_CLOSABLE" ? "订单已不是可手动结单的状态；请刷新后核对。"
          : cause instanceof AdminApiError && cause.status === 403 ? "当前账号不是本单客服，或没有订单结算写权限。"
          : friendlyError(cause));
      }
    }
  };
  return <Card className="im-support-fulfillment im-order-card" data-manual-close="true" aria-label="异常处理">
    <CardContent className="grid gap-2 p-4">
      <CardTitle className="flex items-center gap-2 text-sm"><TriangleAlert className="size-4 shrink-0 text-destructive" />异常处理</CardTitle>
      <CardDescription className="text-xs leading-relaxed">结束订单不能跳过结算与退款。请提交实际情况，系统核对后引导到适用的正式流程；原人工关闭记录仍须核对资金。</CardDescription>
      {resolution ? <Alert variant="warning"><TriangleAlert /><AlertTitle>订单未关闭，请完成正式处理</AlertTitle><AlertDescription>{resolution === "PRESTART_REFUND_REQUIRED" ? "本单尚未确认开租，请核实未使用与无争议后办理未开租取消。" : "本单已确认开租，请核对实际消耗，通过正常或提前结算处理应收应退。"}</AlertDescription><AlertAction>{resolution === "PRESTART_REFUND_REQUIRED" ? <a className="text-sm underline underline-offset-4" href={`#${encodeURIComponent(`support-cancel-${orderId}`)}`}>前往未开租取消</a> : <Button type="button" variant="outline" size="sm" onClick={onSettlement}>前往结算处理</Button>}</AlertAction></Alert>
        : result ? <Alert><ShieldCheck /><AlertTitle>已手动结单（原办理记录）</AlertTitle><AlertDescription>原记录未自动结算或退款，资金处理待核实；沟通权限以订单群当前提示为准。</AlertDescription></Alert>
        : <div className="im-support-fulfillment-actions">
          <Button variant="outline" size="sm" data-action="manual-close-open" onClick={() => { setError(""); setOpen(true); }}>核对结束方式</Button>
        </div>}
      {error && !open ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </CardContent>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="im-wb-dialog" aria-label="手动结单" showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><strong>核对结束方式</strong><span>订单 {displayNo}</span></div><Button type="button" variant="ghost" size="icon" onClick={() => setOpen(false)} disabled={phase === "SENDING"} aria-label="关闭手动结单"><X size={14} /></Button></div>
        <Alert variant="warning"><TriangleAlert /><AlertTitle>先核对本单办理路径</AlertTitle><AlertDescription>未开租取消与已开租结算是不同流程，本入口不会跳过应收应退责任。提交后请按系统返回的办理路径继续；不代表订单已关闭或退款到账。</AlertDescription></Alert>
        <label className="im-wb-dialog-note"><span>处理备注（必填，3–200 字）<em>{remark.length}/200</em></span>
          <Textarea value={remark} maxLength={200} rows={3} aria-label="手动结单处理备注" placeholder="说明异常原因与后续资金处理方式" disabled={phase === "SENDING" || phase === "UNKNOWN"} onChange={(event) => { setRemark(event.target.value); setError(""); }} />
        </label>
        {error ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
        <div className="im-wb-dialog-actions">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={phase === "SENDING"}>取消</Button>
          <Button variant="outline" size="sm" data-action="manual-close-submit" onClick={() => void submit()} disabled={!valid || phase === "SENDING" || Boolean(result)}>{phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : "核对办理路径"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </Card>;
}
