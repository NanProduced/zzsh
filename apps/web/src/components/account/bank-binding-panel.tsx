"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { CreditCard, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/form-controls";
import { FieldGroup, RecoveryAlert, SkeletonBlock, StatusBadge, fieldControlProps } from "@/components/ui/information";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import {
  pendingBankBinding,
  readBankBinding,
  recoverBankBinding,
  saveBankBinding,
  validateBankBindingInput,
  type BankBindingRead,
  type PendingBankBinding,
} from "@/lib/withdrawal-bank-binding-client";
import {
  type IdentityFailure,
  type ReadState,
  type BankDraft,
  emptyBankDraft,
  sameBankPending,
  asError,
  timeLabel,
  errorCopy,
  ErrorDetails,
  useWithdrawalIdentity,
} from "./bank-binding-types";

export function BankChipSvg() {
  return (
    <svg className="bank-chip-svg" width="34" height="26" viewBox="0 0 34 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="34" height="26" rx="4.5" fill="url(#chip-surface-grad)" stroke="#c4a568" strokeWidth="0.8" />
      <path d="M0 9h11a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H0" stroke="#8a6723" strokeWidth="0.75" fill="none" opacity="0.65" />
      <path d="M34 9h-11a3 3 0 0 0-3 3v2a3 3 0 0 0 3 3h11" stroke="#8a6723" strokeWidth="0.75" fill="none" opacity="0.65" />
      <path d="M17 0v26" stroke="#8a6723" strokeWidth="0.75" strokeDasharray="3 2" opacity="0.45" />
      <rect x="12.5" y="9.5" width="9" height="7" rx="1.5" stroke="#8a6723" strokeWidth="0.75" fill="none" opacity="0.6" />
      <defs>
        <linearGradient id="chip-surface-grad" x1="0" y1="0" x2="34" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fef3c7" />
          <stop offset="0.35" stopColor="#fde68a" />
          <stop offset="0.7" stopColor="#f59e0b" stopOpacity="0.85" />
          <stop offset="1" stopColor="#d97706" stopOpacity="0.75" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function ContactlessSvg() {
  return (
    <svg className="bank-contactless-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 16.5a5 5 0 0 1 0-9" />
      <path d="M12 19a8.5 8.5 0 0 0 0-14" />
      <path d="M15.5 21.5a12 12 0 0 0 0-19" />
    </svg>
  );
}

export function BankBindingPanel({ scope, onChanged, onLocked, onIdentityFailure, onBoundChange }: {
  scope: string; onChanged: () => void; onLocked: (locked: boolean) => void; onIdentityFailure?: IdentityFailure; onBoundChange?: (bound: boolean | null) => void;
}) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure), ids = useId();
  const [read, setRead] = useState<ReadState<BankBindingRead>>({ scope, value: null, busy: true, error: null });
  const [draft, setDraft] = useState<BankDraft>(() => emptyBankDraft(scope));
  const [pendingValue, setPending] = useState<PendingBankBinding | null>(null), [storageBlockedValue, setStorageBlocked] = useState(false);
  const [writing, setWriting] = useState(false), [noticeValue, setNotice] = useState("");
  const readTicket = useRef(0), readAbort = useRef<AbortController | null>(null), writeAbort = useRef<AbortController | null>(null);
  const changedRef = useRef(onChanged), lockedRef = useRef(onLocked), writingRef = useRef(false);
  changedRef.current = onChanged; lockedRef.current = onLocked;
  const nameRef = useRef<HTMLInputElement>(null);
  const visible = read.scope === scope && identity.ready ? read : { scope, value: null, busy: true, error: null };
  const form = draft.scope === scope && identity.ready ? draft : emptyBankDraft(scope);
  const pending = read.scope === scope && identity.ready ? pendingValue : null;
  const storageBlocked = read.scope === scope && identity.ready && storageBlockedValue;
  const notice = read.scope === scope && identity.ready ? noticeValue : "";
  const selectedRecovery = form.context?.kind === "recovery" ? form.context.expectedPending : null;
  const activeRecovery = selectedRecovery ?? pending;
  const isLocked = Boolean(activeRecovery) || storageBlocked || (read.scope === scope && writing);
  useEffect(() => { lockedRef.current(isLocked); }, [isLocked, scope]);
  useEffect(() => { onBoundChange?.(visible.busy || visible.error || visible.value?.integration !== "INTEGRATED" ? null : Boolean(visible.value.binding)); }, [visible.busy, visible.error, visible.value, onBoundChange]);
  const syncPending = () => {
    if (!identity.current() || !identity.userId) return null;
    try { const p = pendingBankBinding(identity.userId); setPending(p); setStorageBlocked(false); return p; }
    catch { setStorageBlocked(true); lockedRef.current(true); return undefined; }
  };
  const load = async () => {
    if (!identity.current()) return;
    readAbort.current?.abort(); const abort = new AbortController(), ticket = ++readTicket.current; readAbort.current = abort;
    setRead({ scope, value: null, busy: true, error: null }); syncPending();
    try { const value = await readBankBinding(identity.userId!, abort.signal); if (identity.current() && !abort.signal.aborted && ticket === readTicket.current) setRead({ scope, value, busy: false, error: null }); }
    catch (error) { if (identity.current() && !abort.signal.aborted && ticket === readTicket.current) { const e = asError(error); setRead({ scope, value: null, busy: false, error: e }); identity.identityFailure(e); } }
  };
  useEffect(() => {
    setDraft(emptyBankDraft(scope)); setPending(null); setStorageBlocked(false); setNotice(""); setWriting(false); writingRef.current = false;
    if (identity.ready) void load();
    return () => { readAbort.current?.abort(); writeAbort.current?.abort(); readTicket.current += 1; };
  // A confirmed identity/scope change discards raw inputs; no draft is persisted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId]);
  useEffect(() => { if (form.open) nameRef.current?.focus(); }, [form.open]);
  const beginEdit = () => {
    if (!identity.current() || writingRef.current || storageBlocked || selectedRecovery) return;
    const original = syncPending();
    if (original === undefined) return;
    if (original) { setNotice("上次保存结果未记录，请先查询，再决定是否重新填写。"); return; }
    setNotice(""); setDraft({ ...emptyBankDraft(scope), open: true, context: { kind: "new" } });
  };
  const beginRecovery = () => {
    if (!identity.current() || writingRef.current || storageBlocked) return;
    const original = selectedRecovery ?? syncPending();
    if (!original) { setNotice("上次保存状态已变化，请重新查询保存结果。"); return; }
    setNotice(""); setDraft({ ...emptyBankDraft(scope), open: true, context: { kind: "recovery", expectedPending: { ...original } } });
  };
  const closeEdit = () => { if (!writingRef.current) setDraft({ ...emptyBankDraft(scope), context: selectedRecovery ? { kind: "recovery", expectedPending: selectedRecovery } : null }); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!identity.current() || !identity.userId || writingRef.current || storageBlocked) return;
    const context = form.context;
    if (!context) return;
    const latestPending = syncPending();
    if (latestPending === undefined) return;
    if (context.kind === "recovery" && !sameBankPending(latestPending, context.expectedPending)) {
      setDraft(d => ({ ...d, error: "上次保存状态已变化，当前填写不会提交。请先查询保存结果。" })); return;
    }
    if (context.kind === "new" && latestPending) {
      setDraft(d => ({ ...d, error: "上次保存结果未记录，本次填写尚未提交。请先查询上次结果。" })); return;
    }
    const expectedRevision = context.kind === "recovery" ? context.expectedPending.expectedRevision : visible.value?.expectedRevision;
    if (!expectedRevision || visible.value?.integration !== "INTEGRATED") return;
    let input;
    try { input = validateBankBindingInput({ name: form.name, cardNo: form.cardNo, expectedRevision }); }
    catch { setDraft(d => ({ ...d, error: "请填写姓名及15–19位数字银行卡号。" })); return; }
    writingRef.current = true; setWriting(true); lockedRef.current(true); setNotice("");
    const abort = new AbortController(); writeAbort.current = abort;
    try {
      const value = await saveBankBinding(identity.userId, input, { ...(context.kind === "recovery" ? { resume: true, expectedPending: context.expectedPending } : { resume: false }), isCurrent: identity.current, signal: abort.signal });
      if (!identity.current()) return;
      setRead({ scope, value, busy: false, error: null }); setDraft(emptyBankDraft(scope)); setNotice("收款资料已保存，后续申请将重新核对提现条件。"); changedRef.current();
    } catch (error) {
      if (!identity.current()) return;
      const e = asError(error); const p = syncPending();
      if (e.code === "BANK_BINDING_CURRENT_READ_UNAVAILABLE" && p === null && !e.uncertain) {
        setDraft(emptyBankDraft(scope));
        setRead({ scope, value: null, busy: false, error: e }); setNotice("上次保存已确认，请刷新查看当前收款资料。"); changedRef.current(); return;
      }
      if (context.kind === "recovery" && ["NO_PENDING_REQUEST", "RECOVERY_CONTEXT_CHANGED"].includes(e.code)) {
        setDraft(d => ({ ...d, error: "上次保存状态已变化，本次填写未提交。请先查询保存结果。" })); return;
      }
      setDraft(d => ({ ...d, error: p ? "上次保存结果尚未确认，请先查询结果。" : errorCopy(e) }));
      identity.identityFailure(e);
    } finally { if (identity.current()) { writingRef.current = false; setWriting(false); syncPending(); } }
  };
  const recover = async () => {
    if (!identity.current() || !identity.userId || writingRef.current || storageBlocked) return;
    const p = selectedRecovery ?? syncPending(); if (!p) return;
    writingRef.current = true; setWriting(true); lockedRef.current(true); setNotice("");
    const abort = new AbortController(); writeAbort.current = abort;
    try {
      const result = await recoverBankBinding(identity.userId, { expectedPending: { ...p }, isCurrent: identity.current, signal: abort.signal });
      if (!identity.current()) return;
      if (result.knowledge === "KNOWN") {
        setRead({ scope, value: result.current, busy: false, error: result.current ? null : new WithdrawalRequestError(503, "BANK_BINDING_CURRENT_READ_UNAVAILABLE") });
        setDraft(emptyBankDraft(scope)); setNotice(result.current ? "上次保存已确认，收款资料已更新。" : "上次保存已确认，请刷新查看当前收款资料。"); changedRef.current();
      } else setNotice("暂未确认上次保存结果，请稍后查询或重新填写当时的资料。");
    } catch (error) { if (identity.current()) { const e = asError(error); setNotice(errorCopy(e)); identity.identityFailure(e); } }
    finally { if (identity.current()) { writingRef.current = false; setWriting(false); syncPending(); } }
  };
  return <section className="account-module-card bank-binding-panel" aria-labelledby={`${ids}-heading`} data-testid="bank-binding-panel">
    <div className="bank-section-heading"><h3 id={`${ids}-heading`}><CreditCard size={19} aria-hidden="true" />收款银行卡</h3><Button variant="tertiary" className="bank-action" isDisabled={visible.busy || writing} onPress={() => void load()} aria-label="重新读取收款资料"><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
    <p className="bank-help">银行卡归属尚未核验。</p>
    {visible.busy ? <SkeletonBlock label="正在读取收款资料" lines={2} /> : visible.error ? <RecoveryAlert tone="error" live title="收款资料暂时无法读取" problem={errorCopy(visible.error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={visible.error} /> }} /> : visible.value?.integration !== "INTEGRATED" ? <RecoveryAlert tone="unknown" title="暂时无法查看收款资料" problem="暂时无法确认是否已绑定，请稍后重试。" /> : visible.value.binding ? <>
      <div className="bank-saved">
        <div className="bank-card-realistic">
          <svg className="bank-card-waves" viewBox="0 0 320 200" fill="none" preserveAspectRatio="none" aria-hidden="true">
            <path d="M-20 130 C 80 80, 160 180, 340 90" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.08" fill="none" />
            <path d="M-10 160 C 90 110, 180 210, 350 120" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.06" fill="none" />
            <circle cx="270" cy="40" r="70" fill="url(#card-glow-workspace)" opacity="0.1" />
            <defs>
              <radialGradient id="card-glow-workspace" cx="50%" cy="50%" r="50%">
                <stop stopColor="#f59e0b" />
                <stop offset="100%" stopColor="transparent" />
              </radialGradient>
            </defs>
          </svg>
          <div className="bank-card-top">
            <div className="bank-card-brand">
              <span className="bank-card-network">收款银行账户</span>
              <ContactlessSvg />
            </div>
            <BankChipSvg />
          </div>
          <div className="bank-card-number">{visible.value.binding.cardMask}</div>
          <div className="bank-card-bottom">
            <div className="bank-card-holder">
              <span className="bank-card-label">持卡人</span>
              <span className="bank-card-name">{visible.value.binding.holderNameMask}</span>
            </div>
            <StatusBadge tone="neutral">资料已保存</StatusBadge>
          </div>
        </div>
        <p className="bank-meta">更新于 {timeLabel(visible.value.binding.updatedAt)}</p>
        {!form.open && !activeRecovery && !storageBlocked ? <Button variant="secondary" className="bank-action" onPress={beginEdit}>修改收款资料</Button> : null}
      </div>
    </> : <div className="bank-empty">
      <div className="bank-empty-visual" aria-hidden="true"><span className="bank-card-ghost"><CreditCard size={32} /></span></div>
      <div className="bank-empty-copy">
        <p className="bank-empty-title">尚未绑定收款银行卡。</p>
        <p className="bank-empty-desc">保存收款资料后，还需核对身份、提现条件和费用。</p>
      </div>
      {!form.open && !activeRecovery && !storageBlocked ? <Button variant="primary" className="bank-action bank-primary bank-bind-cta" onPress={beginEdit}>绑定银行卡</Button> : null}
    </div>}
    {storageBlocked ? <RecoveryAlert tone="unknown" title="上次保存状态未记录" problem="请保留当前页面并联系客服，确认前无法继续操作。" /> : activeRecovery ? <RecoveryAlert tone="unknown" title="上次保存结果未记录" problem="请先查询上次保存结果。" action={<div className="bank-actions"><Button variant="primary" className="bank-action bank-primary" isDisabled={writing} onPress={() => void recover()}>{writing ? "正在核对…" : "查询保存结果"}</Button><Button variant="secondary" className="bank-action" isDisabled={writing || visible.value?.integration !== "INTEGRATED"} onPress={beginRecovery}>重新输入原资料</Button></div>} /> : null}
    {form.open ? <form className="bank-binding-form" onSubmit={save} noValidate>
      <FieldGroup id={`${ids}-name`} label="持卡人姓名" required helper="填写银行账户登记姓名。修改时需要重新填写，不会预填旧资料。"><Input {...fieldControlProps({ id: `${ids}-name`, helper: true })} ref={nameRef} name="bank-holder-name" autoComplete="off" spellCheck={false} maxLength={128} value={form.name} disabled={writing} onChange={e => setDraft(d => ({ ...d, name: e.target.value, error: "" }))} /></FieldGroup>
      <FieldGroup id={`${ids}-card`} label="银行卡号" required helper="15–19位数字，可粘贴带空格的卡号。"><Input {...fieldControlProps({ id: `${ids}-card`, helper: true })} name="bank-card-number" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} value={form.cardNo} disabled={writing} onChange={e => setDraft(d => ({ ...d, cardNo: e.target.value, error: "" }))} /></FieldGroup>
      {selectedRecovery ? <p className="bank-help">请填写当时提交的原姓名和卡号，以核对上次保存。</p> : <p className="bank-help">修改收款资料不会更换已提交提现申请的收款目标。</p>}
      {form.error ? <p className="bank-form-error" role="alert">{form.error}</p> : null}
      <div className="bank-actions"><Button type="submit" variant="primary" className="bank-action bank-primary" isDisabled={writing || storageBlocked || visible.busy || visible.value?.integration !== "INTEGRATED" || (form.context?.kind === "new" && Boolean(pending)) || (selectedRecovery !== null && !sameBankPending(pending, selectedRecovery))}>{writing ? "正在保存…" : selectedRecovery ? "确认并继续保存" : "保存收款资料"}</Button><Button type="button" variant="secondary" className="bank-action" isDisabled={writing} onPress={closeEdit}>取消填写</Button></div>
    </form> : null}
    {notice ? <p className="bank-feedback" role="status">{notice}</p> : null}
  </section>;
}
