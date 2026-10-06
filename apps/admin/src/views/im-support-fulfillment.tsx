"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ClipboardList, RefreshCw } from "lucide-react";
import { AdminApiError, friendlyError } from "../api";
import {
  buildFulfillmentIntent,
  readOrderSettlement,
  sendFulfillmentIntent,
  type EarlyEndReason,
  type FulfillmentIntent,
  type SettlementReadView,
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
type PersistedIntent = { subject: string; intent: FulfillmentIntent; accepted?: boolean };
const ACCEPTED_STORAGE_WARNING = "操作已受理，但本地无法保存恢复状态；不会重复提交。请勿刷新或离开页面，先查看当前状态或联系维护处理。";

function isAuthFailure(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 401 || error.status === 423);
}

const AMOUNT_LABELS: Record<string, string> = {
  haffConsumedBuyer: "哈夫币消耗（租客侧）",
  haffConsumedOwner: "哈夫币消耗（号主侧）",
  itemConsumedBuyer: "物品消耗（租客侧）",
  itemConsumedOwner: "物品消耗（号主侧）",
  unusedItemRefund: "未耗物品退款",
  unusedHaffRefund: "未耗哈夫币退款",
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
const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" };

function amountText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { amount?: unknown; unit?: unknown };
    if (typeof record.amount === "string" && record.amount.trim()) return `${record.amount} ${typeof record.unit === "string" && record.unit === "yuan" ? "元" : record.unit ?? ""}`.trim();
  }
  return null;
}
function amountRows(amounts: Record<string, unknown> | null | undefined): Array<{ key: string; label: string; text: string }> {
  if (!amounts) return [];
  return AMOUNT_ORDER.filter((key) => amountText(amounts[key]) !== null).map((key) => ({ key, label: AMOUNT_LABELS[key]!, text: amountText(amounts[key])! }));
}
function partyLabel(party: string | undefined): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return "相关方";
}
function decisionLabel(decision: { party?: string; action?: string }): string {
  const action = decision.action === "CONFIRM" ? "已确认" : decision.action === "REJECT" ? "已拒绝" : decision.action === "REVIEW" ? "已复核" : "待处理";
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
export function OrderFulfillmentSection({ orderId, displayNo, viewerId, frozenInventory }: { orderId: string; displayNo: string; viewerId: string; frozenInventory?: InventoryLine[] }) {
  const [view, setView] = useState<SettlementReadView | null>(null);
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
    return { name: line?.name ?? null, unit: line?.unit ?? "" };
  };

  const invalidate = () => {
    generationRef.current += 1;
    setPreview(null);
  };

  const seed = useCallback((next: SettlementReadView) => {
    const opening = [...(next.openings ?? [])].reverse().find((item) => Array.isArray(item.lines) && item.lines.length > 0);
    if (opening?.lines) {
      setLines(opening.lines
        .filter((line): line is { itemId: string; quantity?: string; unit?: string } => Boolean(line) && typeof line.itemId === "string")
        .map((line) => {
          const frozen = inventoryByName.get(line.itemId);
          return { itemId: line.itemId, name: frozen?.name ?? null, unit: line.unit ?? frozen?.unit ?? "", value: line.quantity ?? "" };
        }));
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
  const clearIntent = () => {
    try { window.localStorage.removeItem(storageKeyFor(viewerId, orderId)); } catch { /* removal is best effort */ }
    intentRef.current = null;
    setIntent(null);
    setPhase("IDLE");
  };

  const applyView = (next: SettlementReadView) => {
    setView(next);
    seed(next);
    invalidate();
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await readOrderSettlement(orderId);
      if (scopeRef.current !== scope) return;
      applyView(next);
    } catch (cause) {
      if (scopeRef.current !== scope) return;
      if (isAuthFailure(cause)) hidePrivate();
      setError(friendlyError(cause));
    } finally {
      if (scopeRef.current === scope) setLoading(false);
    }
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
      setNotice("检测到上次未确认的履约操作；请查看当前状态或按原请求重放（同一幂等键）。");
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
    try {
      const next = await readOrderSettlement(orderId);
      if (scopeRef.current !== scope) return;
      applyView(next);
      clearIntent();
      setNotice((current) => current || "操作已受理，最新状态已读取。");
      setError("");
    } catch (cause) {
      if (scopeRef.current !== scope) return;
      setPhase("ACCEPTED_READBACK_PENDING");
      if (isAuthFailure(cause)) {
        hidePrivate();
        setError("操作已受理；登录状态已变化，订单私有投影已隐藏。重新确认同一管理员身份后请查看当前状态。");
      } else {
        setError("操作已受理，但读取最新状态失败；仅可查看当前状态，不会重复提交。");
      }
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
        classify: "已生成提前结算版本，等待买卖双方确认。",
        review: "已完成客服复核。",
        adjust: "人工调整已提交，进入既有审批流程。",
      };
      setNotice(target.kind === "preview" ? "" : success[target.kind] ?? "操作已受理。");
      if (target.kind === "preview") {
        const body = outcome.body;
        const amounts = (body.amounts ?? body.settlement?.computation?.amounts ?? null) as Record<string, unknown> | null;
        const versionHash = typeof body.versionHash === "string" ? body.versionHash : body.settlement?.versionHash ?? null;
        const armed = target.body.proposedOwnerNet !== undefined || target.body.proposedRenterRefund !== undefined;
        clearIntent();
        setPreview({ amounts, versionHash, early: typeof body.early === "boolean" ? body.early : body.settlement?.early ?? null, adjustArmed: armed });
        setNotice(armed ? "已生成人工调整预览；确认后提交调整申请。" : "已生成服务端预览；确认后提交分类。");
      } else {
        // The accepted receipt must survive unmount: only a GET may clear it.
        persistIntent(target, true);
        await readbackAccepted();
      }
    } else if (outcome.kind === "blocked") {
      clearIntent();
      setError(`服务端未接受：${outcome.reasons.join(" / ")}`);
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
    setBusy(false);
  };

  const beginIntent = async (command: Parameters<typeof buildFulfillmentIntent>[1]) => {
    if (locked || storageBlocked) return;
    const built = buildFulfillmentIntent(orderId, command);
    if (!persistIntent(built)) {
      setError("无法持久化本次操作意图，已阻止新写入；请刷新后重试。");
      return;
    }
    intentRef.current = built;
    setIntent(built);
    setPhase("SENDING");
    await dispatch(built);
  };

  const observeCurrent = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await readOrderSettlement(orderId);
      if (scopeRef.current !== scope) return;
      applyView(next);
      if (phase === "ACCEPTED_READBACK_PENDING") {
        clearIntent();
        setNotice("操作已受理，最新状态已读取。");
      } else {
        setNotice("已查看当前状态；该读取不构成原请求回执，未决操作仍保留。");
      }
    } catch (cause) {
      if (scopeRef.current !== scope) return;
      if (isAuthFailure(cause)) {
        hidePrivate();
        setError("登录状态已变化，订单私有投影已隐藏；请重新确认同一管理员身份后重试。");
      } else {
        setError(friendlyError(cause));
      }
    } finally {
      if (scopeRef.current === scope) setLoading(false);
    }
  };

  const replay = async () => {
    if (!intent || phase === "SENDING" || phase === "ACCEPTED_READBACK_PENDING") return;
    await dispatch(intent, true);
  };

  const linesForOpening = () => lines.map((line) => ({ itemId: line.itemId, quantity: line.value }));
  const linesForRemaining = () => lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.value }));

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

  const primaryDisabled = busy || loading || locked || storageBlocked;
  const previewAmounts = preview?.amounts ?? null;
  const currentAmounts = (current?.computation?.amounts ?? null) as Record<string, unknown> | null;
  const currentInputLines = (current?.inputSnapshot?.lines ?? []) as Array<{ itemId?: string; openingQuantity?: string; remainingQuantity?: string }>;
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
      setError("请填写有效的剩余数量（非负整数）。");
      return;
    }
    if (!endReason) {
      setError("提前结算需要选择结束原因；正常结算由买卖双方提交，客服仅处理提前分类。");
      return;
    }
    void beginIntent({ kind: "preview", lines: linesForRemaining(), endReason });
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
    if (!preview?.versionHash || !endReason) return;
    void beginIntent({ kind: "classify", lines: linesForRemaining(), endReason, acceptedHash: preview.versionHash });
  };
  const review = () => {
    if (!current?.id || !current.versionHash) return;
    void beginIntent({ kind: "review", versionId: current.id, versionHash: current.versionHash });
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

  const renderInventory = (mode: "opening" | "remaining") => lines.length > 0 ? <div className="im-support-fulfillment-lines" role="group" aria-label={mode === "opening" ? "期初库存" : "剩余库存"}>
    {lines.map((line, index) => <label key={line.itemId}><span>{line.name ?? "物资"}{line.unit ? ` · ${UNIT_LABELS[line.unit] ?? line.unit}` : ""}</span><input value={line.value} inputMode="numeric" disabled={locked} onChange={(event) => setLineValue(index, event.target.value)} aria-label={`${line.name ?? line.itemId} ${mode === "opening" ? "期初数量" : "剩余数量"}`} /></label>)}
  </div> : <p className="im-support-fulfillment-empty">服务端未返回订单冻结库存投影，无法代录期初；请核对订单状态。</p>;

  const renderCurrentFacts = () => current ? <div className="im-support-fulfillment-preview" aria-label="当前结算版本事实">
    <strong>当前结算版本 v{current.versionNo ?? "?"}{current.early ? " · 提前" : ""}（双方核对依据）</strong>
    {currentInputLines.length > 0 ? <div className="im-support-fulfillment-lines" role="group" aria-label="当前版本数量">
      {currentInputLines.map((line) => {
        const facts = line.itemId ? inventoryName(line.itemId) : { name: null, unit: "" };
        return <label key={line.itemId ?? "line"}><span>{facts.name ?? "物资"}{facts.unit ? ` · ${UNIT_LABELS[facts.unit] ?? facts.unit}` : ""}</span><output>{line.remainingQuantity ?? line.openingQuantity ?? "—"}</output></label>;
      })}
    </div> : null}
    {amountRows(currentAmounts).length > 0 ? <dl>{amountRows(currentAmounts).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : <small>服务端未返回金额明细。</small>}
  </div> : null;

  return <section className="im-support-fulfillment" aria-label="订单履约操作">
    <div className="im-support-fulfillment-heading"><ClipboardList size={15} /><strong>履约操作</strong><small>订单 {displayNo}</small><span className="im-support-fulfillment-stage" data-stage={stage.key}>{stage.label}</span><button type="button" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={12} />{loading ? "读取中…" : "读取结算"}</button></div>
    {error ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    {notice ? <p className="im-support-fulfillment-notice" role="status">{notice}</p> : null}
    {storageBlocked ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{phase === "ACCEPTED_READBACK_PENDING" ? ACCEPTED_STORAGE_WARNING : "本地无法保存操作意图，已阻止新写入；请刷新后重试。"}</p> : null}
    {phase !== "IDLE" ? <div className="im-support-fulfillment-pending" role="status">
      <CircleAlert size={14} />
      <span>{phase === "SENDING" ? "本次操作正在发送…" : phase === "AUTH" ? "登录状态已变化，原操作责任仍保留（同一幂等键）。" : phase === "ACCEPTED_READBACK_PENDING" ? "操作已受理，等待读取最新状态；不会重复提交。" : "本次操作结果未确认，原幂等键与责任已保留。"}</span>
      <button type="button" onClick={() => void observeCurrent()} disabled={loading || busy}>查看当前状态</button>
      {phase !== "SENDING" && phase !== "ACCEPTED_READBACK_PENDING" ? <button type="button" onClick={() => void replay()} disabled={busy || loading}>按原请求重放</button> : null}
    </div> : null}

    {view ? <>
      <div className="im-support-fulfillment-chips">
        <span>{view.rentalStarted === true ? "已开租" : view.rentalStarted === false ? "未开租" : "开租状态未知"}</span>
        {view.currentRequest?.kind === "INTAKE" ? <span data-tone="warn">有结算申请待客服处理</span> : null}
        {posting ? <span data-tone="good">已过账{posting.early ? " · 提前" : ""}</span> : null}
      </div>

      {stage.key === "needs-opening" ? <div className="im-support-fulfillment-stage-panel">
        <strong>第一步：期初代录</strong>
        <small>按订单冻结库存填写期初数量；数量必须与已付款订单的报价一致。</small>
        {renderInventory("opening")}
        <div className="im-support-fulfillment-actions"><button type="button" onClick={recordOpening} disabled={primaryDisabled || lines.length === 0}>期初代录</button></div>
      </div> : null}

      {stage.key === "opening-pending" ? <div className="im-support-fulfillment-stage-panel">
        <strong>等待买卖双方确认期初</strong>
        <small>期初 v{latestOpening?.versionNo ?? "?"} · {latestOpening?.acks?.map((ack) => partyLabel(ack.party)).join("、") || "暂无确认"}</small>
        {renderInventory("opening")}
        <p className="im-support-fulfillment-empty">双方确认后进入履约；客服不能替双方确认。</p>
      </div> : null}

      {stage.key === "needs-settlement" || stage.key === "intake-pending" ? <div className="im-support-fulfillment-stage-panel">
        <strong>履约中 · 结算</strong>
        <small>正常结算由买卖双方提交并互相确认；客服处理提前分类或人工调整。</small>
        {renderInventory("remaining")}
        <div className="im-support-fulfillment-controls">
          <label>提前原因<select value={endReason} disabled={locked} onChange={(event) => { invalidate(); setEndReason(event.target.value as "" | EarlyEndReason); }}><option value="">不选择（正常结算无需客服）</option><option value="TENANT_VOLUNTARY_EARLY">租客自愿提前</option><option value="OWNER_OR_ACCOUNT_EARLY">号主/账号原因提前</option></select></label>
        </div>
        <div className="im-support-fulfillment-actions">
          <button type="button" onClick={previewSettlement} disabled={primaryDisabled || lines.length === 0 || endReason === ""}>生成提前结算预览</button>
          {preview && !preview.adjustArmed && preview.versionHash ? <button type="button" onClick={classify} disabled={primaryDisabled}>确认分类</button> : null}
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
        <div className="im-support-fulfillment-actions"><button type="button" onClick={review} disabled={primaryDisabled || !current?.id || !current.versionHash}>确认复核</button></div>
      </div> : null}

      {stage.key === "reviewed" || stage.key === "normal-version" || stage.key === "posted" ? <div className="im-support-fulfillment-stage-panel">
        <strong>{stage.key === "posted" ? "已生效" : stage.key === "reviewed" ? "已复核，等待生效" : "正常结算版本"}</strong>
        <small>{current ? `结算版本 v${current.versionNo ?? "?"}${current.early ? " · 提前" : ""}` : posting ? `过账 ${posting.postedAt ?? ""}` : ""}</small>
        {renderCurrentFacts()}
        {posting ? <p className="im-support-fulfillment-empty">已过账；退款到期 {posting.refundDueAt ?? "按规则"}。应退不代表渠道退款已到账。</p> : null}
      </div> : null}

      {preview ? <div className="im-support-fulfillment-preview" aria-label="服务端预览结果">
        <strong>服务端预览{preview.adjustArmed ? "（人工调整）" : "（提前结算）"}</strong>
        {amountRows(previewAmounts).length > 0 ? <dl>{amountRows(previewAmounts).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl> : <small>服务端未返回金额明细。</small>}
        <small>{preview.early === true ? "按提前结算计算" : preview.early === false ? "按正常结算计算" : ""}</small>
      </div> : null}

      {postingRows.length > 0 ? <div className="im-support-fulfillment-preview" aria-label="已生效金额">
        <strong>已生效金额</strong>
        <dl>{postingRows.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>
      </div> : null}

      <div className="im-support-fulfillment-adjust">
        <button type="button" className="im-support-quiet-action" aria-expanded={adjustOpen} onClick={() => setAdjustOpen((value) => !value)}>人工调整（例外）</button>
        {adjustOpen ? <div className="im-support-fulfillment-controls">
          <label>号主拟净额<input value={ownerNet} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setOwnerNet(event.target.value); }} placeholder="元，如 123.45" /></label>
          <label>租客拟退款<input value={renterRefund} inputMode="decimal" disabled={locked} onChange={(event) => { invalidate(); setRenterRefund(event.target.value); }} placeholder="元，如 12.00" /></label>
          <label>原因说明<input value={reason} maxLength={500} disabled={locked} onChange={(event) => { invalidate(); setReason(event.target.value); }} placeholder="不少于3字" /></label>
        </div> : null}
        {adjustOpen ? <div className="im-support-fulfillment-actions">
          <button type="button" onClick={previewAdjustment} disabled={primaryDisabled}>生成调整预览</button>
          {preview?.adjustArmed && preview.versionHash ? <button type="button" onClick={adjust} disabled={primaryDisabled}>提交人工调整</button> : null}
        </div> : null}
      </div>

      <p className="im-support-fulfillment-hint">消息、已读与群状态不会改变订单；所有金额以服务端权威结果为准，应退不代表渠道退款已到账。</p>
    </> : <p className="im-support-fulfillment-empty">尚未读取结算。读取后按当前阶段执行期初代录、提前分类与复核。</p>}
  </section>;
}
