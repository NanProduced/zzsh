"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, ChevronUp, CreditCard, FileText, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/form-controls";
import { FieldGroup, RecoveryAlert, SkeletonBlock, StatusBadge, fieldControlProps } from "@/components/ui/information";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { walletMoney } from "@/lib/personal-wallet-client";
import { formatOrderTime } from "@/lib/order-client";
import { historicalWithdrawalStatus, yuanToCents } from "@/lib/controlled-withdrawal-client";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import { pendingBankBinding, readBankBinding, recoverBankBinding, saveBankBinding, validateBankBindingInput, type BankBindingRead, type PendingBankBinding } from "@/lib/withdrawal-bank-binding-client";
import { pendingChannelWithdrawal, quoteChannelWithdrawal, readChannelWithdrawal, readChannelWithdrawalOptions, recoverChannelWithdrawal, submitChannelWithdrawal, type ChannelWithdrawalIntent, type ChannelWithdrawalQuote, type PendingChannelWithdrawal, type WithdrawalOptions } from "@/lib/channel-withdrawal-client";
import { confirmDemoWithdrawal, createDemoTarget, discardDemoTarget, pendingDemoWithdrawal, quoteDemoWithdrawal, readDemoAvailability, readDemoIntent, recoverDemoWithdrawal, type DemoBody, type DemoIntent, type DemoPending, type DemoQuote, type DemoScope, type DemoWithdrawalLimits } from "@/lib/demo-withdrawal-client";
import { readWithdrawalHistory, readWithdrawalHistoryItem, recoverWithdrawalFromHistory, type WithdrawalHistoryDetail, type WithdrawalHistoryRead, type WithdrawalHistoryRecovery, type WithdrawalHistorySource } from "@/lib/withdrawal-history-client";
import { advanceWithdrawalTimeline, emptyWithdrawalTimeline, hasMoreWithdrawalTimeline, removeWithdrawalTimelineSource, WithdrawalTimelineSourceError, type TimelineItem, type TimelineState } from "@/lib/withdrawal-timeline";
import "./bank-binding-workspace.css";

type IdentityFailure = (error: WithdrawalRequestError) => void;
type ReadState<T> = { scope: string; value: T | null; busy: boolean; error: WithdrawalRequestError | null };
type BankFormContext = { kind: "new" } | { kind: "recovery"; expectedPending: PendingBankBinding };
type BankDraft = { scope: string; open: boolean; name: string; cardNo: string; error: string; context: BankFormContext | null };
const emptyBankDraft = (scope: string): BankDraft => ({ scope, open: false, name: "", cardNo: "", error: "", context: null });
const sameBankPending = (a: PendingBankBinding | null | undefined, b: PendingBankBinding) => Boolean(a && a.userId === b.userId && a.key === b.key && a.expectedRevision === b.expectedRevision);
const asError = (error: unknown) => error instanceof WithdrawalRequestError ? error : new WithdrawalRequestError(0, "NETWORK_ERROR");
const timeLabel = (value: string | null | undefined) => value ? formatOrderTime(value, { timeZoneName: false }) : "时间未提供";

function errorCopy(error: WithdrawalRequestError | null) {
  if (!error) return "暂时无法读取，请稍后重试。";
  if (error.code === "RECOVERY_STORAGE_UNAVAILABLE") return "暂时无法确认上次操作，请保留当前页面并联系客服。";
  if (error.code === "PENDING_REQUEST_EXISTS") return "上次申请的结果未记录，请先查看进度。";
  if (error.code === "WRITE_LOCK_UNAVAILABLE") return "当前浏览器无法保护重复提交，请更换受支持的浏览器后重试。";
  if (error.status === 401) return "登录身份已变化，请重新确认登录后继续。";
  if (error.status === 403) return "当前账号暂不能进行此操作，已有记录仍可单独查询。";
  if (error.status === 409) return "资料或费用已变化，请刷新后核对；上次申请仍需先确认结果。";
  if (error.status === 400) return "填写的信息不符合要求，请核对后重试。";
  if (error.status === 503) return "暂时无法查看，请稍后重试。";
  return "本次未能确认处理结果，请稍后重新查询。";
}

function ErrorDetails({ error }: { error: WithdrawalRequestError }) {
  return <span>{error.requestId ? `查询编号：${error.requestId}` : "请稍后重试，或联系客服。"}</span>;
}

function useWithdrawalIdentity(scope: string, onIdentityFailure?: IdentityFailure) {
  const session = useUserSession(), store = useUserSessionStore();
  const userId = session.userId;
  const mounted = useRef(false), liveScope = useRef(scope), failureRef = useRef(onIdentityFailure);
  liveScope.current = scope;
  failureRef.current = onIdentityFailure;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => {
    const latest = store.getSnapshot();
    return mounted.current && Boolean(userId) && latest.status === "authenticated" && latest.userId === userId
      && liveScope.current === scope && `${latest.userId}:${latest.identityVersion}` === scope;
  }, [scope, store, userId]);
  const identityFailure = (error: WithdrawalRequestError) => {
    if (error.status === 401) {
      if (failureRef.current) failureRef.current(error);
      else session.revalidate();
    }
  };
  const ready = session.status === "authenticated" && Boolean(userId) && `${userId}:${session.identityVersion}` === scope;
  return { userId, current, ready, session, identityFailure };
}

function BankChipSvg() {
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

function ContactlessSvg() {
  return (
    <svg className="bank-contactless-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 16.5a5 5 0 0 1 0-9" />
      <path d="M12 19a8.5 8.5 0 0 0 0-14" />
      <path d="M15.5 21.5a12 12 0 0 0 0-19" />
    </svg>
  );
}

function BankBindingPanel({ scope, onChanged, onLocked, onIdentityFailure, onBoundChange }: {
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
      <div className="bank-security-tips" aria-label="提现说明">
        <div className="bank-security-tip-item">
          <span className="bank-security-tip-icon">⚡</span>
          <div>
            <strong>快速审核到账</strong>
            <p>工作日申请由系统自动复核，预计 2 小时内打款至您的银行账户。</p>
          </div>
        </div>
        <div className="bank-security-tip-item">
          <span className="bank-security-tip-icon">🛡️</span>
          <div>
            <strong>实名一致性保障</strong>
            <p>收款卡姓名必须与已认证实名完全一致，杜绝资金错付。</p>
          </div>
        </div>
        <div className="bank-security-tip-item">
          <span className="bank-security-tip-icon">💰</span>
          <div>
            <strong>平台免手续费</strong>
            <p>平台全额补贴结算通道费，提现金额如数到账。</p>
          </div>
        </div>
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

const channelStateLabel: Record<string, string> = { RESERVED: "金额已暂留", SUBMITTING: "提交中", PROCESSING: "处理中", UNKNOWN: "结果未记录", CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "到账未记录", SUCCEEDED: "到账未记录", FAILED: "处理结果未记录", RECONCILIATION_REQUIRED: "需要人工核对" };
const reasonLabel: Record<string, string> = { WITHDRAWAL_CHANNEL_NOT_CONFIGURED: "提现暂不可用，仍可查看收款资料和记录", WITHDRAWAL_REQUESTS_NOT_CONFIGURED: "当前仅支持查看已有记录，尚未开放新的提现申请", BANK_BINDING_REQUIRED: "请先绑定收款银行卡", BANK_BINDING_NOT_INTEGRATED: "暂时无法查看收款资料", BANK_BINDING_UNAVAILABLE: "收款资料暂时无法核对", IDENTITY_NOT_VERIFIED: "身份资料尚未满足提现要求", REAL_IDENTITY_REQUIRED: "身份资料尚未满足提现要求", REAL_IDENTITY_SOURCE_REQUIRED: "实名信息未记录", IDENTITY_PROVIDER_MISMATCH: "实名信息未记录", ADULT_STATUS_REQUIRED: "当前年龄资料不符合提现要求", USER_NOT_ADULT: "当前年龄资料不符合提现要求", IDENTITY_EXPIRED: "实名信息需要更新", IDENTITY_PROOF_EXPIRED_OR_INVALID: "实名信息已过期或无效，请重新认证", NEW_REQUESTS_DISABLED: "当前暂未开放新的提现申请", POLICY_UNAVAILABLE: "提现规则暂时无法读取", WITHDRAWAL_POLICY_UNAVAILABLE: "提现规则暂时无法读取", WITHDRAWAL_QUOTA_UNKNOWN: "今日提现次数暂时无法确认", WITHDRAWAL_QUOTA_EXHAUSTED: "今日提现申请次数已用完" };
/** Only describe what the server returned; unknown values stay unknown instead of becoming eligibility. */
function identityStatusLabel(value: string | undefined): string {
  return value === "VERIFIED" ? "已实名" : value === "UNVERIFIED" ? "未实名" : value === "REJECTED" ? "实名未通过" : "实名状态未记录";
}
function ageStatusLabel(value: string | undefined): string {
  return value === "ADULT" ? "已成年" : value === "MINOR" ? "未成年" : "年龄状态未记录";
}

function IntentFacts({ intent, onRefresh, busy }: { intent: ChannelWithdrawalIntent; onRefresh: () => void; busy: boolean }) {
  return <section className="bank-result" aria-label="原提现申请记录"><div className="bank-section-heading"><h4>申请记录</h4><StatusBadge tone={intent.requiresReview ? "unknown" : "neutral"}>{channelStateLabel[intent.state] ?? "状态未确认"}</StatusBadge></div><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(intent.amountCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(intent.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(intent.netCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{intent.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请时间</dt><dd>{timeLabel(intent.acceptedAt)}</dd></div><div><dt>申请单号</dt><dd>{intent.merchantOrderNo}</dd></div><div><dt>到账情况</dt><dd>未记录</dd></div></dl><p className="bank-help">手续费由你承担，到账情况请以收款记录为准。更换银行卡不会改变本次收款账户。</p><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={onRefresh}>刷新申请记录</Button></section>;
}

function ChannelWithdrawalPanel({ scope, refreshKey, bindingLocked, availableBalance, onWalletChanged, onIdentityFailure }: {
  scope: string; refreshKey: number; bindingLocked: boolean; availableBalance: string | null; onWalletChanged: () => void; onIdentityFailure?: IdentityFailure;
}) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure), id = useId();
  const [read, setRead] = useState<ReadState<WithdrawalOptions>>({ scope, value: null, busy: true, error: null });
  const [amount, setAmount] = useState({ scope, value: "" }), [quote, setQuote] = useState<{ scope: string; value: ChannelWithdrawalQuote } | null>(null);
  const [pendingValue, setPending] = useState<PendingChannelWithdrawal | null>(null), [storageBlockedValue, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [confirmOpen, setConfirmOpen] = useState(false), [noticeValue, setNotice] = useState("");
  const [errorValue, setError] = useState<WithdrawalRequestError | null>(null), [result, setResult] = useState<{ scope: string; value: ChannelWithdrawalIntent } | null>(null);
  const [knownIntent, setKnownIntent] = useState<{ scope: string; id: string } | null>(null);
  const [localRecovery, setLocalRecovery] = useState<{ scope: string; value: WithdrawalHistoryRecovery } | null>(null);
  const request = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null), generation = useRef(0), busyRef = useRef(false), quoteBusyRef = useRef(false), changedRef = useRef(onWalletChanged);
  changedRef.current = onWalletChanged;
  const options = read.scope === scope && identity.ready ? read.value : null;
  const pending = read.scope === scope && identity.ready ? pendingValue : null;
  const storageBlocked = read.scope === scope && identity.ready && storageBlockedValue;
  const notice = read.scope === scope && identity.ready ? noticeValue : "";
  const error = read.scope === scope && identity.ready ? errorValue : null;
  const visibleQuote = quote?.scope === scope && identity.ready ? quote.value : null;
  const visibleResult = result?.scope === scope && identity.ready ? result.value : null;
  const amountText = amount.scope === scope && identity.ready ? amount.value : "";
  const syncPending = () => {
    if (!identity.current() || !identity.userId) return null;
    try { const p = pendingChannelWithdrawal(identity.userId); setPending(p); setStorageBlocked(false); return p; }
    catch { setStorageBlocked(true); return undefined; }
  };
  const load = async () => {
    if (!identity.current()) return;
    if (quoteBusyRef.current) { quoteBusyRef.current = false; busyRef.current = false; setBusy(false); }
    request.current?.abort(); const abort = new AbortController(), ticket = ++generation.current; request.current = abort;
    setRead({ scope, value: null, busy: true, error: null }); setQuote(null); setConfirmOpen(false); syncPending();
    try { const value = await readChannelWithdrawalOptions(identity.userId!, abort.signal); if (identity.current() && !abort.signal.aborted && ticket === generation.current) setRead({ scope, value, busy: false, error: null }); }
    catch (e) { if (identity.current() && !abort.signal.aborted && ticket === generation.current) { const failure = asError(e); setRead({ scope, value: null, busy: false, error: failure }); identity.identityFailure(failure); } }
  };
  useEffect(() => {
    setAmount({ scope, value: "" }); setQuote(null); setConfirmOpen(false); setPending(null); setResult(null); setKnownIntent(null); setLocalRecovery(null); setNotice(""); setError(null); setStorageBlocked(false); setBusy(false); busyRef.current = false; quoteBusyRef.current = false;
    if (identity.ready) void load();
    return () => { generation.current++; request.current?.abort(); write.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId]);
  const priorBindingRefresh = useRef(refreshKey);
  useEffect(() => {
    if (priorBindingRefresh.current === refreshKey) return;
    priorBindingRefresh.current = refreshKey;
    if (identity.ready) void load();
    // Updating the current bank invalidates a draft quote, never the original submitted record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const blocked = !identity.ready || !options?.canQuote || !options.policy || !options.bankBinding.binding || bindingLocked || Boolean(pending) || storageBlocked;

  const preview = async (event?: FormEvent) => {
    if (event) event.preventDefault();
    if (!identity.current() || !identity.userId || blocked || busyRef.current || !options?.policy || !options.bankBinding.binding) return;
    if (syncPending() !== null) return;
    try { if (pendingBankBinding(identity.userId)) { setNotice("请先确认收款资料的上次保存结果，再核对提现费用。"); return; } }
    catch { setStorageBlocked(true); return; }
    let cents: string;
    try { cents = yuanToCents(amountText); if (BigInt(cents) <= 0n) throw new Error(); }
    catch { setNotice("请输入大于0、最多两位小数的提现金额。"); return; }
    busyRef.current = true; quoteBusyRef.current = true; setBusy(true); setError(null); setNotice(""); setQuote(null);
    const abort = new AbortController(), ticket = ++generation.current; request.current?.abort(); request.current = abort;
    try {
      const next = await quoteChannelWithdrawal(identity.userId, { amountCents: cents, destinationId: options.bankBinding.binding.id, policyVersion: options.policy.version }, abort.signal);
      if (identity.current() && !abort.signal.aborted && ticket === generation.current) {
        if (next.destination.revision !== options.bankBinding.binding.revision) {
          busyRef.current = false; setBusy(false); setNotice("收款资料已有更新，请重新读取后核对。"); void load();
        } else {
          setQuote({ scope, value: next });
        }
      }
    }
    catch (e) { if (identity.current() && !abort.signal.aborted && ticket === generation.current) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current() && ticket === generation.current) { busyRef.current = false; quoteBusyRef.current = false; setBusy(false); } }
  };
  const submit = async () => {
    if (!identity.current() || !identity.userId || !visibleQuote || blocked || busyRef.current) return;
    if (syncPending() !== null) { setConfirmOpen(false); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    const abort = new AbortController(); write.current = abort;
    try { const intent = await submitChannelWithdrawal(identity.userId, visibleQuote, { isCurrent: identity.current, signal: abort.signal }); if (identity.current()) { setResult({ scope, value: intent }); setKnownIntent({ scope, id: intent.id }); setQuote(null); setConfirmOpen(false); setAmount({ scope, value: "" }); setNotice("申请已记录，处理及到账情况请以原申请记录为准。"); changedRef.current(); } }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); setConfirmOpen(false); setQuote(null); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); syncPending(); } }
  };
  const recover = async () => {
    if (!identity.current() || !identity.userId || busyRef.current || storageBlocked || !syncPending()) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(""); setLocalRecovery(null);
    const abort = new AbortController(); write.current = abort;
    try { const reply = await recoverChannelWithdrawal(identity.userId, { isCurrent: identity.current, signal: abort.signal }); if (identity.current()) { if (reply.knowledge === "KNOWN" && reply.receipt) { setKnownIntent({ scope, id: reply.receipt.id }); setResult(reply.current ? { scope, value: reply.current } : null); setAmount({ scope, value: "" }); setNotice(reply.current ? "申请已确认，到账情况仍未记录。" : "申请已确认，请刷新查看最新进度。"); changedRef.current(); } else setNotice("暂未确认申请结果，请稍后继续查询。"); } }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); syncPending(); } }
  };
  const readLocalRecovery = async () => {
    if (!identity.current() || !identity.userId || busyRef.current || storageBlocked) return;
    const original = syncPending(); if (!original) return;
    busyRef.current = true; setBusy(true); setError(null);
    const abort = new AbortController(); write.current = abort;
    try { const value = await recoverWithdrawalFromHistory(identity.userId, original.key, abort.signal); if (identity.current()) setLocalRecovery({ scope, value }); }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); } }
  };
  const refreshIntent = async () => {
    if (!identity.current() || !identity.userId || knownIntent?.scope !== scope || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    const abort = new AbortController(); write.current = abort;
    try { const value = await readChannelWithdrawal(identity.userId, knownIntent.id, abort.signal); if (identity.current()) setResult({ scope, value }); }
    catch (e) { if (identity.current()) { const failure = asError(e); setResult(null); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); } }
  };
  const canEditAmount = identity.ready && !busy && !pending && !storageBlocked;

  return <section className="account-module-card channel-withdrawal-panel" data-testid="channel-withdrawal-panel" aria-labelledby={`${id}-title`}>
    <div className="bank-section-heading">
      <h3 id={`${id}-title`} className="sr-only">银行卡提现</h3>
      <Button variant="tertiary" className="bank-action bank-refresh-corner" isDisabled={read.busy || busy} onPress={() => void load()} aria-label="刷新提现资料">
        <RefreshCw size={15} className={read.busy ? "animate-spin" : ""} aria-hidden="true" />
        刷新
      </Button>
    </div>

    {/* Hero 区域：可提现余额（对齐图 2） */}
    <div className="bank-available" aria-label="可提现余额">
      <span className="bank-available-caption">可提现余额</span>
      <strong className="bank-available-sum">{walletMoney(availableBalance)}</strong>
    </div>

    <hr className="bank-metric-divider" />

    {storageBlocked ? <RecoveryAlert tone="unknown" title="原申请信息暂时无法读取" problem="无法确认是否已有提交，已暂停新申请。请保留当前浏览器状态。" /> : pending ? <RecoveryAlert tone="unknown" title="上次提现结果未记录" problem="请先查询处理结果，确认前无法再次申请。" action={<div className="bank-actions"><Button variant="primary" className="bank-action bank-primary" isDisabled={busy} onPress={() => void recover()}>{busy ? "正在查询…" : "查询提现进度"}</Button><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void readLocalRecovery()}>查看申请记录</Button></div>} /> : null}
    {read.busy ? <SkeletonBlock label="正在确认提现条件" lines={2} /> : read.error ? <RecoveryAlert tone="error" title="暂时无法确认提现条件" problem={errorCopy(read.error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={read.error} /> }} /> : options && !options.canQuote ? <>
      {options.bankBinding.integration === "INTEGRATED" && !options.bankBinding.binding ? <div className="bank-onboarding-callout" role="note"><p><strong>请先保存收款银行卡</strong></p><small>保存后仍需核对其他提现条件与费用。</small></div> : null}
      <RecoveryAlert tone="unknown" title="当前暂不可申请提现" problem={[...new Set(options.reasonCodes.map(code => reasonLabel[code] ?? "暂不满足提现条件"))].join("；") || "当前提现条件尚未确认。"} />
    </> : null}

    {options?.policy ? <div className="bank-policy"><span>单笔 {walletMoney(options.policy.minCents)}–{walletMoney(options.policy.maxCents)}</span><span>{options.policy.fee.kind === "FIXED" ? `手续费 ${walletMoney(options.policy.fee.cents)}` : "手续费按比例计算，输入金额后自动核算"}</span><span>每个时段最多 {options.policy.maxIntents} 笔</span></div> : null}

    {/* 表单核心区域：对齐图 2 结构 */}
    <form className="bank-withdraw-form" onSubmit={e => {
      e.preventDefault();
      if (visibleQuote) {
        setConfirmOpen(true);
      } else {
        void preview(e);
      }
    }} noValidate>
      <div className="bank-form-group">
        <label className="bank-form-label" htmlFor={`${id}-amount`}>提现金额</label>
        <div className="bank-amount-input-box">
          <span className="bank-currency-prefix" aria-hidden="true">¥</span>
          <Input
            {...fieldControlProps({ id: `${id}-amount`, helper: false })}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountText}
            disabled={!canEditAmount}
            className="bank-amount-input"
            onChange={e => {
              setAmount({ scope, value: e.target.value });
              setQuote(null);
              setConfirmOpen(false);
              setNotice("");
            }}
          />
          {canEditAmount && availableBalance && BigInt(availableBalance) > 0n ? (
            <Button
              type="button"
              variant="tertiary"
              className="bank-quick-max-btn"
              onPress={() => {
                const cents = BigInt(availableBalance);
                const yuan = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
                setAmount({ scope, value: yuan });
                setQuote(null);
                setConfirmOpen(false);
                setNotice("");
              }}
            >
              全部提现
            </Button>
          ) : null}
        </div>
      </div>

      {/* 收款银行卡行（对齐图 2） */}
      <div className="bank-form-group">
        <span className="bank-form-label">收款银行卡</span>
        <div className="bank-destination-card" role="group" aria-label="当前收款银行卡">
          <div className="bank-destination-left">
            <CreditCard size={18} className="bank-destination-icon" aria-hidden="true" />
            <span className="bank-destination-name">
              {options?.bankBinding?.binding
                ? `银行卡 •••• ${options.bankBinding.binding.cardMask.slice(-4)}`
                : options?.bankBinding?.integration === "INTEGRATED"
                  ? "尚未绑定收款银行卡"
                  : "收款资料未记录"}
            </span>
          </div>
          <ChevronDown size={16} className="bank-destination-chevron" aria-hidden="true" />
        </div>
      </div>

      {/* 手续费与实际到账明细（对齐图 2） */}
      {visibleQuote && !blocked ? (
        <div className="bank-quote bank-fee-summary has-quote" aria-label="提现费用核算">
          <div className="bank-fee-row">
            <span className="bank-fee-name">手续费</span>
            <span className="bank-fee-val">{walletMoney(visibleQuote.feeCents)}</span>
          </div>
          <div className="bank-fee-row">
            <span className="bank-fee-name">实际到账</span>
            <span className="bank-fee-val is-highlight">{walletMoney(visibleQuote.netCents)}</span>
          </div>
          <div className="bank-fee-row bank-quote-destination">
            <span className="bank-fee-name">收款卡号</span>
            <span className="bank-fee-val">{visibleQuote.destination.mask}</span>
          </div>
          <p className="bank-help bank-quote-note">手续费由你承担。确认前不会扣款，到账情况以收款记录为准。</p>
        </div>
      ) : (
        <div className="bank-fee-summary" aria-label="提现费用核算">
          <div className="bank-fee-row">
            <span className="bank-fee-name">手续费</span>
            <span className="bank-fee-val">以确认时为准</span>
          </div>
          <div className="bank-fee-row">
            <span className="bank-fee-name">实际到账</span>
            <span className="bank-fee-val">以确认时为准</span>
          </div>
        </div>
      )}

      {bindingLocked ? <p className="bank-help">请先确认收款资料的保存结果，再核对提现费用。</p> : null}
      {error ? <RecoveryAlert tone={pending ? "unknown" : "error"} live title={pending ? "申请结果尚未确认" : "本次操作未完成"} problem={errorCopy(error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={error} /> }} /> : null}

      {/* 底部右侧主操作按钮（对齐图 2） */}
      <div className="bank-submit-container">
        <Button
          type="submit"
          variant="primary"
          className="bank-action bank-primary bank-main-submit"
          isDisabled={blocked || busy || !amountText}
          onPress={() => {
            if (visibleQuote) {
              setConfirmOpen(true);
            }
          }}
        >
          {busy ? "正在核对…" : visibleQuote ? "确认提现申请" : "核对提现信息"}
        </Button>
      </div>
    </form>

    {options ? <details className="bank-eligibility" aria-label="提现资格与次数"><summary>查看提现条件</summary><dl className="bank-facts">
      <div><dt>实名状态</dt><dd>{identityStatusLabel(options.identity?.identityStatus)}</dd></div>
      <div><dt>年龄状态</dt><dd>{ageStatusLabel(options.identity?.ageStatus)}</dd></div>
      {options.identity?.verifiedAt ? <div><dt>实名核验时间</dt><dd>{timeLabel(options.identity.verifiedAt)}</dd></div> : null}
      {options.quota ? <><div><dt>已申请</dt><dd>{options.quota.used} / {options.quota.maxIntents} 笔</dd></div><div><dt>剩余次数</dt><dd>{options.quota.remaining} 笔</dd></div><div><dt>有效时间</dt><dd>{timeLabel(options.quota.windowStart)} 至 {timeLabel(options.quota.windowEnd)}</dd></div></> : null}
    </dl>{!options.identity ? <p className="bank-help">实名信息未记录。</p> : null}{!options.quota ? <p className="bank-help">提现次数未记录。</p> : null}</details> : null}

    {notice ? <p className="bank-feedback" role="status">{notice}</p> : null}
    {pending && localRecovery?.scope === scope ? <section className="bank-result" aria-label="申请记录"><h4>申请记录</h4>{localRecovery.value.knowledge === "KNOWN" && localRecovery.value.item ? <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(localRecovery.value.item.amountCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{localRecovery.value.item.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>处理状态</dt><dd>{channelStateLabel[localRecovery.value.item.state] ?? "状态未确认"}</dd></div></dl><p className="bank-help">已找到申请记录，但上次提交结果仍未记录。请勿重复申请。</p></> : <p className="bank-help">暂未找到可确认的申请记录，请稍后再查，勿重复申请。</p>}</section> : null}
    {visibleResult ? <IntentFacts intent={visibleResult} onRefresh={() => void refreshIntent()} busy={busy} /> : knownIntent?.scope === scope ? <Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void refreshIntent()}>刷新申请进度</Button> : null}
    <ConfirmAlertDialog open={confirmOpen && Boolean(visibleQuote) && identity.ready} onOpenChange={setConfirmOpen} title="确认这笔提现申请？" description="申请受理后，提现金额将暂留；到账情况以收款记录为准。" confirmLabel={busy ? "正在提交申请…" : "确认提交申请"} cancelLabel="返回核对" onConfirm={() => void submit()} busy={busy} confirmDisabled={blocked || !visibleQuote} className="bank-withdrawal-confirm" consequences={visibleQuote ? <dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(visibleQuote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(visibleQuote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(visibleQuote.netCents)}</dd></div><div><dt>收款银行卡</dt><dd>{visibleQuote.destination.mask}</dd></div></dl> : null} />
  </section>;
}

type WithdrawalPanelProps = {scope:string;refreshKey:number;bindingLocked:boolean;availableBalance:string|null;ledgerRevision:string|null;onWalletChanged:()=>void;onIdentityFailure?:IdentityFailure};
function DemoWithdrawalPanel({scope,refreshKey,bindingLocked,availableBalance,ledgerRevision,onWalletChanged,onIdentityFailure,demoScope,enabled,limits}:{demoScope:DemoScope;enabled:boolean;limits:DemoWithdrawalLimits}&WithdrawalPanelProps) {
  const identity=useWithdrawalIdentity(scope,onIdentityFailure),field=useId(),generation=useRef(0),busyRef=useRef(false);
  const [binding,setBinding]=useState<BankBindingRead|null>(null),[loading,setLoading]=useState(true),[pending,setPending]=useState<DemoPending|null>(null);
  const [amount,setAmount]=useState(""),[quote,setQuote]=useState<{body:DemoBody;quote:DemoQuote}|null>(null),[result,setResult]=useState<DemoIntent|null>(null);
  const [busy,setBusy]=useState(false),[confirmOpen,setConfirmOpen]=useState(false),[message,setMessage]=useState(""),[storageBlocked,setStorageBlocked]=useState(false);
  const sync=()=>{try{const value=pendingDemoWithdrawal(identity.userId!);if(value&&value.scope!==demoScope)throw Error();setPending(value);setStorageBlocked(false);return value;}catch{setStorageBlocked(true);return undefined;}};
  useEffect(()=>{
    if(!identity.ready||!identity.userId)return;
    const controller=new AbortController(),run=++generation.current;setLoading(true);setBinding(null);setQuote(null);setResult(null);setMessage("");
    const original=sync();if(original?.stage==="target-ready"){const n=BigInt(original.body.amountCents);setAmount(`${n/100n}.${(n%100n).toString().padStart(2,"0")}`);}else setAmount("");
    void readBankBinding(identity.userId,controller.signal).then(value=>{if(identity.current()&&!controller.signal.aborted&&run===generation.current)setBinding(value);})
      .catch(error=>{if(identity.current()&&!controller.signal.aborted&&run===generation.current){identity.identityFailure(asError(error));setMessage("收款资料暂时无法读取，请刷新重试。");}})
      .finally(()=>{if(identity.current()&&!controller.signal.aborted&&run===generation.current)setLoading(false);});
    return()=>{generation.current++;controller.abort();};
    // The same identity and bank refresh define this panel's resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope,identity.ready,identity.userId,refreshKey,demoScope]);
  useEffect(()=>{if(quote&&quote.body.expectedWalletVersion!==ledgerRevision){setQuote(null);setConfirmOpen(false);}},[ledgerRevision,quote]);
  const run=async(action:()=>Promise<void>)=>{if(!identity.current()||busyRef.current)return;busyRef.current=true;setBusy(true);setMessage("");
    try{await action();}catch(error){if(identity.current()){const e=asError(error);identity.identityFailure(e);const original=sync(),identityMessage:Record<string,string>={DEMO_WITHDRAW_IDENTITY_REQUIRED:"请先完成本人实名认证。",DEMO_WITHDRAW_ADULT_REQUIRED:"确认已成年后才能提现。",DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED:"实名信息来源暂时无法确认，请联系客服核对。",DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE:`提现金额需在 ${walletMoney(limits.minCents)} 至 ${walletMoney(limits.maxCents)} 之间。`};
      setMessage(e.status===401?"登录状态已变化，请重新进入页面。":original?.stage==="target"||original?.stage==="confirm"?"操作暂未确认，请先查询原申请。":identityMessage[e.code]??"提现信息暂时无法核对，请稍后重试。");}}
    finally{if(identity.current())setBusy(false);busyRef.current=false;}};
  const preview=()=>void run(async()=>{
    if(!identity.userId||!ledgerRevision||!binding?.binding||bindingLocked||!enabled)return;
    try{if(pendingBankBinding(identity.userId)){setMessage("请先确认收款资料的保存结果。");return;}}catch{setMessage("收款资料的保存状态无法确认，请联系客服。");return;}
    let original=sync();if(original===undefined||original?.stage==="target"||original?.stage==="confirm")return;
    if(!original){let amountCents:string;try{amountCents=yuanToCents(amount);if(BigInt(amountCents)<=0n)throw Error();}catch{setMessage("请输入大于 0、最多两位小数的金额。");return;}
      if(BigInt(amountCents)<BigInt(limits.minCents)||BigInt(amountCents)>BigInt(limits.maxCents)){setMessage(`提现金额需在 ${walletMoney(limits.minCents)} 至 ${walletMoney(limits.maxCents)} 之间。`);return;}setResult(null);
      original=await createDemoTarget(identity.userId,demoScope,{bankBindingId:binding.binding.id,bankBindingRevision:binding.binding.revision,amountCents},{isCurrent:identity.current});setPending(original);}
    if(original.stage!=="target-ready")return;
    try {const next=await quoteDemoWithdrawal(identity.userId,demoScope,original.target,ledgerRevision);if(identity.current())setQuote(next);}
    catch(error){if(identity.current()&&asError(error).status===409){setMessage("提现条件已变化，请重新填写金额后核对。");return;}throw error;}
  });
  const recover=()=>void run(async()=>{if(!identity.userId)return;const recovered=await recoverDemoWithdrawal(identity.userId,demoScope,{isCurrent:identity.current});if(!identity.current())return;
    setPending(recovered.pending);if(recovered.knowledge==="UNKNOWN")setMessage("原申请仍未确认，请稍后再次查询，或联系客服。");
    else if(recovered.intent){setResult(recovered.intent);setQuote(null);onWalletChanged();setMessage("已找到原提现申请。");}
    else if(recovered.pending?.stage==="target-ready"){const n=BigInt(recovered.pending.body.amountCents);setAmount(`${n/100n}.${(n%100n).toString().padStart(2,"0")}`);setMessage("已找到原收款目标，请继续核对提现信息。");}});
  const submit=()=>void run(async()=>{if(!identity.userId||!quote)return;try{if(pendingBankBinding(identity.userId)){setMessage("请先确认收款资料的保存结果。");setConfirmOpen(false);return;}}catch{setMessage("收款资料的保存状态无法确认，请联系客服。");setConfirmOpen(false);return;}
    const intent=await confirmDemoWithdrawal(identity.userId,demoScope,quote.body,quote.quote,{isCurrent:identity.current});
    if(identity.current()){setPending(null);setQuote(null);setConfirmOpen(false);setResult(intent);onWalletChanged();}});
  const refresh=()=>void run(async()=>{if(!identity.userId||!result)return;const intent=await readDemoIntent(identity.userId,demoScope,result.id);if(identity.current()){setResult(intent);onWalletChanged();}});
  const resetTarget=()=>void run(async()=>{if(!identity.userId)return;await discardDemoTarget(identity.userId,demoScope);if(identity.current()){setPending(null);setQuote(null);setAmount("");}});
  const readyTarget=pending?.stage==="target-ready"?pending.target:null,unknown=pending?.stage==="target"||pending?.stage==="confirm";
  const blocked=!identity.ready||loading||busy||storageBlocked||bindingLocked||!enabled||!binding?.binding||ledgerRevision===null||availableBalance===null||Boolean(unknown);
  const labels:Record<DemoIntent["state"],string>={RESERVED:"金额已暂留",SUBMITTING:"处理中",PROCESSING:"处理中",UNKNOWN:"结果待确认",SUCCEEDED:"处理完成",FAILED:"提现未完成",RECONCILIATION_REQUIRED:"需要客服核对"};
  return <section className="account-module-card channel-withdrawal-panel" data-testid="demo-withdrawal-panel" aria-labelledby={`${field}-title`}>
    <div className="bank-section-heading"><h3 id={`${field}-title`}>银行卡提现</h3><StatusBadge tone="neutral">测试环境</StatusBadge></div>
    <p className="bank-help">测试环境不会向银行卡打款，余额会按测试记录变动。单笔范围 {walletMoney(limits.minCents)} 至 {walletMoney(limits.maxCents)}。</p>
    <div className="bank-available" aria-label="可提现余额"><span className="bank-available-caption">可提现余额</span><strong className="bank-available-sum">{walletMoney(availableBalance)}</strong></div>
    <hr className="bank-metric-divider" />
    {loading?<SkeletonBlock label="正在读取收款资料" lines={2}/>:null}
    {!enabled?<RecoveryAlert tone="unknown" title="提现暂不可用" problem="请稍后重试或联系客服。"/>:null}
    {!loading&&binding?.integration==="INTEGRATED"&&!binding.binding?<RecoveryAlert tone="info" title="请先绑定收款银行卡" problem="保存收款资料后即可核对提现信息。"/>:null}
    {storageBlocked?<RecoveryAlert tone="unknown" title="原申请信息暂时无法读取" problem="请保留当前浏览器状态并联系客服。"/>:unknown?<RecoveryAlert tone="unknown" title="上次提现结果待确认" problem="请先查询原申请，确认前不能发起新的提现。" action={<Button variant="secondary" className="bank-action" isDisabled={busy} onPress={recover}>查询原申请</Button>}/>:null}
    <form className="bank-withdraw-form" onSubmit={event=>{event.preventDefault();if(quote)setConfirmOpen(true);else preview();}} noValidate>
      <div className="bank-form-group"><label className="bank-form-label" htmlFor={`${field}-amount`}>提现金额</label><div className="bank-amount-input-box">
        <span className="bank-currency-prefix" aria-hidden="true">¥</span><Input {...fieldControlProps({id:`${field}-amount`,helper:false})} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={blocked||Boolean(readyTarget)} className="bank-amount-input" onChange={event=>{setAmount(event.target.value);setQuote(null);setMessage("");}} />
        {!blocked&&!readyTarget&&availableBalance&&BigInt(availableBalance)>0n?<Button type="button" variant="tertiary" className="bank-quick-max-btn" onPress={()=>{const n=BigInt(availableBalance)>BigInt(limits.maxCents)?BigInt(limits.maxCents):BigInt(availableBalance);setAmount(`${n/100n}.${(n%100n).toString().padStart(2,"0")}`);setQuote(null);}}>{BigInt(availableBalance)>BigInt(limits.maxCents)?"本次最多":"全部提现"}</Button>:null}
      </div></div>
      <div className="bank-form-group"><span className="bank-form-label">收款银行卡</span><div className="bank-destination-card" role="group" aria-label="当前收款银行卡"><div className="bank-destination-left"><CreditCard size={18} className="bank-destination-icon" aria-hidden="true"/><span className="bank-destination-name">{readyTarget?`银行卡 •••• ${readyTarget.mask.slice(-4)}`:binding?.binding?`银行卡 •••• ${binding.binding.cardMask.slice(-4)}`:binding?.integration==="INTEGRATED"?"尚未绑定收款银行卡":"收款资料暂时无法确认"}</span></div></div></div>
      {quote?<div className="bank-fee-summary has-quote" aria-label="提现费用核算"><div className="bank-fee-row"><span>手续费</span><span>{walletMoney(quote.quote.feeCents)}</span></div><div className="bank-fee-row"><span>提现净额</span><span>{walletMoney(quote.quote.netCents)}</span></div></div>:null}
      {readyTarget?<Button type="button" variant="tertiary" className="bank-action" isDisabled={busy} onPress={resetTarget}>重新填写金额</Button>:null}
      <div className="bank-submit-container"><Button type="submit" variant="primary" className="bank-action bank-primary bank-main-submit" isDisabled={blocked||!amount}>{busy?"正在核对…":quote?"确认提现申请":"核对提现信息"}</Button></div>
    </form>
    {message?<p className="bank-feedback" role="status">{message}</p>:null}
    {result?<section className="bank-result" aria-label="申请记录"><div className="bank-section-heading"><h4>申请记录</h4><StatusBadge tone="neutral">{labels[result.state]}</StatusBadge></div><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(result.amountCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(result.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(result.netCents)}</dd></div></dl><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={refresh}>刷新处理进度</Button></section>:null}
    <ConfirmAlertDialog open={confirmOpen&&Boolean(quote)&&identity.ready} onOpenChange={setConfirmOpen} title="确认这笔提现申请？" description="测试环境不会实际打款，余额会按测试记录变动。" confirmLabel={busy?"正在提交申请…":"确认提交申请"} cancelLabel="返回核对" onConfirm={submit} busy={busy} confirmDisabled={blocked||!quote} className="bank-withdrawal-confirm" consequences={quote?<dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(quote.quote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(quote.quote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(quote.quote.netCents)}</dd></div><div><dt>收款银行卡</dt><dd>{readyTarget?.mask??"未记录"}</dd></div></dl>:null}/>
  </section>;
}

function WithdrawalPanel(props:WithdrawalPanelProps) {
  const identity=useWithdrawalIdentity(props.scope,props.onIdentityFailure),[state,setState]=useState<{scope:string;mode:"loading"|"channel"|"demo"|"error";demoScope?:DemoScope;enabled?:boolean;limits?:DemoWithdrawalLimits}>({scope:props.scope,mode:"loading"}),[attempt,setAttempt]=useState(0);
  useEffect(()=>{if(!identity.ready||!identity.userId)return;const controller=new AbortController();setState({scope:props.scope,mode:"loading"});
    let original:DemoPending|null;try{original=pendingDemoWithdrawal(identity.userId);}catch{setState({scope:props.scope,mode:"error"});return;}
    void readDemoAvailability(identity.userId,controller.signal).then(value=>{if(identity.current()&&!controller.signal.aborted)setState({scope:props.scope,mode:"demo",demoScope:value.scope,enabled:value.withdrawalEnabled,limits:value.limits});})
      .catch(error=>{if(identity.current()&&!controller.signal.aborted){const e=asError(error);identity.identityFailure(e);setState({scope:props.scope,mode:e.status===404&&!original?"channel":"error"});}});
    return()=>controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[props.scope,identity.ready,identity.userId,attempt]);
  if(state.scope!==props.scope||state.mode==="loading")return <section className="account-module-card"><SkeletonBlock label="正在确认提现方式" lines={2}/></section>;
  if(state.mode==="error")return <section className="account-module-card"><RecoveryAlert tone="unknown" title="暂时无法确认提现方式" problem="如有未完成申请，请保留原浏览器状态。" action={<Button variant="secondary" className="bank-action" onPress={()=>setAttempt(value=>value+1)}>重新读取</Button>}/></section>;
  if(state.mode==="demo"&&state.demoScope&&state.limits)return <DemoWithdrawalPanel {...props} demoScope={state.demoScope} enabled={state.enabled===true} limits={state.limits}/>;
  return <ChannelWithdrawalPanel {...props}/>;
}

type HistorySource = Exclude<WithdrawalHistorySource, "ALL">;
type HistoryRow = TimelineItem & { amount: string; label: string; note: string; mask?: string | null };
type HistoryView = { availability: string; rows: HistoryRow[]; cursor: string | null; snapshot: string | null; asOf: string | null; coverageKnown: boolean };
function historyView(source: HistorySource, reply: WithdrawalHistoryRead): HistoryView {
  if (source === "HISTORICAL") {
    const part = reply.sections.historical, data = part.data;
    return { availability: part.availability, rows: data?.items.map(item => ({ source, id: item.id, amount: item.amountCents, at: item.occurredAt, label: historicalWithdrawalStatus(item.sourceStatus), note: "到账情况未记录" })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, coverageKnown: data?.coverage.knowledge === "KNOWN" };
  }
  if (source === "LOCAL_CONTROLLED") {
    const part = reply.sections.controlled, data = part.data;
    return { availability: part.availability, rows: data?.items.map(item => ({ source, id: `controlled:${item.id}`, amount: item.amountCents, at: item.acceptedAt, label: item.state === "SUCCEEDED" ? "处理完成" : channelStateLabel[item.state] ?? "状态未确认", note: "测试记录，未实际打款" })) ?? [], cursor: data?.pagination?.nextCursor ?? null, snapshot: data?.pagination?.snapshotVersion ?? null, asOf: data?.pagination?.asOf ?? null, coverageKnown: Boolean(data?.pagination) };
  }
  const part = reply.sections.joinpay, data = part.data;
  return { availability: part.availability, rows: data?.items.map(item => ({ source, id: item.id, amount: item.amountCents, at: item.occurredAt, label: item.requiresReview ? "需要人工核对" : channelStateLabel[item.state] ?? "状态未确认", note: "到账情况未记录", mask: item.originalDestination?.cardMask ?? null })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, coverageKnown: Boolean(data) };
}

function HistoryDetail({ value }: { value: WithdrawalHistoryDetail }) {
  const item = value.source === "LOCAL_CONTROLLED" ? value.item.intent : value.source === "JOINPAY" ? value.data.item : value.item;
  const joinpay = value.source === "JOINPAY" ? value.data.item : null;
  const historical = value.source === "HISTORICAL_WITHDRAWAL" ? value.item : null;
  return <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(item.amountCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(item.netCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(item.feeCents)}</dd></div>{historical ? <div><dt>原提现单号</dt><dd>{historical.originalNumber ?? "未记录"}</dd></div> : null}{joinpay ? <><div><dt>原收款银行卡</dt><dd>{joinpay.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请单号</dt><dd>{joinpay.merchantOrderNo}</dd></div><div><dt>交易流水号</dt><dd>{joinpay.platformSerialNo ?? "尚未提供"}</dd></div></> : null}<div><dt>到账情况</dt><dd>未记录</dd></div></dl><p className="bank-help">{value.source === "LOCAL_CONTROLLED" ? "这是测试记录，未向银行卡打款。" : <>{historical ? "金额按原记录展示；" : "金额按申请记录展示；"}到账情况请以收款记录为准。</>}</p></>;
}


function WithdrawalHistorySection({ scope, refreshKey, onIdentityFailure }: { scope: string; refreshKey: number; onIdentityFailure?: IdentityFailure }) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [state, setState] = useState<ReadState<TimelineState<HistoryRow>>>({ scope, value: null, busy: true, error: null });
  const [detail, setDetail] = useState<{ scope: string; source: HistorySource; id: string; value: WithdrawalHistoryDetail | null; busy: boolean; error: WithdrawalRequestError | null } | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const stateRef = useRef(state); stateRef.current = state;
  const abort = useRef<AbortController | null>(null), ticket = useRef(0), detailAbort = useRef<AbortController | null>(null), detailTicket = useRef(0);
  const visible = state.scope === scope && identity.ready ? state : { scope, value: null, busy: true, error: null };
  const load = async (reset = false) => {
    if (!identity.current() || !identity.userId || !reset && stateRef.current.busy) return;
    abort.current?.abort(); const controller = new AbortController(), run = ++ticket.current; abort.current = controller;
    if (reset) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); setVisibleCount(5); }
    const prior = !reset && stateRef.current.scope === scope ? stateRef.current.value : null;
    setState({ scope, value: prior, busy: true, error: null });
    try {
      const next = await advanceWithdrawalTimeline(prior ?? emptyWithdrawalTimeline<HistoryRow>(), async (source, cursor) => {
        try {
          const part = historyView(source, await readWithdrawalHistory(identity.userId!, { source, cursor, limit: 20 }, controller.signal));
          return { items: part.rows, cursor: part.cursor, snapshot: part.snapshot, asOf: part.asOf, available: part.availability === "AVAILABLE", coverageKnown: part.coverageKnown };
        } catch (error) {
          const e = asError(error);
          if (cursor && e.status === 403) throw new WithdrawalTimelineSourceError(source, "WITHDRAWAL_SOURCE_FORBIDDEN");
          if (!cursor && (e.status === 403 || e.status === 503 || e.status === 0)) return { items: [], cursor: null, snapshot: null, asOf: null, available: false, coverageKnown: false };
          throw error;
        }
      });
      if (identity.current() && !controller.signal.aborted && run === ticket.current) setState({ scope, value: next, busy: false, error: null });
    } catch (error) {
      if (!identity.current() || controller.signal.aborted || run !== ticket.current) return;
      if (error instanceof WithdrawalTimelineSourceError) {
        detailTicket.current++; detailAbort.current?.abort(); setDetail(null);
        setState({ scope, value: prior ? removeWithdrawalTimelineSource(prior, error.source) : null, busy: false, error: new WithdrawalRequestError(403, "WITHDRAWAL_SOURCE_CHANGED") });
        return;
      }
      const e = error instanceof WithdrawalRequestError ? error : new WithdrawalRequestError(409, "WITHDRAWAL_SNAPSHOT_CHANGED");
      if (e.status === 401 || e.status === 409) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); }
      setState({ scope, value: e.status === 401 || e.status === 409 ? null : prior, busy: false, error: e }); identity.identityFailure(e);
    }
  };
  useEffect(() => {
    setState({ scope, value: null, busy: true, error: null }); setDetail(null); setVisibleCount(5);
    if (identity.ready) void load(true);
    return () => { ticket.current++; detailTicket.current++; abort.current?.abort(); detailAbort.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId, refreshKey]);
  const openDetail = async (recordId: string, source: HistorySource) => {
    if (!identity.current() || !identity.userId) return;
    detailAbort.current?.abort(); const controller = new AbortController(), run = ++detailTicket.current; detailAbort.current = controller;
    setDetail({ scope, source, id: recordId, value: null, busy: true, error: null });
    try { const value = await readWithdrawalHistoryItem(identity.userId, recordId, controller.signal); if (identity.current() && !controller.signal.aborted && run === detailTicket.current) setDetail({ scope, source, id: recordId, value, busy: false, error: null }); }
    catch (error) { if (identity.current() && !controller.signal.aborted && run === detailTicket.current) { const e = asError(error); if (e.status === 401 || e.status === 403) { ticket.current++; abort.current?.abort(); abort.current = null; if (e.status === 401) setState({ scope, value: null, busy: false, error: e }); else setState(current => ({ ...current, value: current.value ? removeWithdrawalTimelineSource(current.value, source) : null, busy: false, error: e })); } setDetail({ scope, source, id: recordId, value: null, busy: false, error: e }); identity.identityFailure(e); } }
  };
  const closeDetail = () => { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); };
  const rows = visible.value?.items ?? [];
  const displayedRows = rows.slice(0, visibleCount);
  const hasMoreLocalRows = rows.length > visibleCount;

  return <section className="account-module-card bank-history-section" aria-label="提现记录">
    <div className="bank-section-heading"><h3><FileText size={18} aria-hidden="true" />提现记录</h3><Button variant="tertiary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(true)} aria-label="刷新提现记录"><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
    <p className="bank-help">按申请时间查看记录，处理记录不代表银行已到账。</p>
    {visible.busy && !visible.value ? <SkeletonBlock label="正在读取提现记录" lines={2} /> : null}
    {visible.value?.partial ? <RecoveryAlert tone="unknown" title="部分记录暂时无法确认" problem="当前列表可能不完整，请稍后刷新；已显示的记录仍可查看。" /> : null}
    {visible.value?.temporalTies ? <p className="bank-help">同一时间的记录顺序可能有差异。</p> : null}
    {displayedRows.length ? <div className="bank-history-rows">{displayedRows.map(row => {
      const isRowDetailOpen = detail?.id === row.id && detail?.scope === scope && identity.ready;
      return <article key={row.id} className={`bank-history-row${isRowDetailOpen ? " is-expanded" : ""}`}>
        <div className="bank-history-row-header">
          <div><StatusBadge tone="neutral">{row.label}</StatusBadge><p>{timeLabel(row.at)}</p><small>{row.mask !== undefined ? `原收款卡：${row.mask ?? "未提供"} · ` : ""}{row.note}</small></div>
          <strong>{walletMoney(row.amount)}</strong>
          <Button variant="tertiary" className="bank-action" onPress={() => (isRowDetailOpen ? closeDetail() : void openDetail(row.id, row.source))} aria-label={isRowDetailOpen ? "收起提现详情" : "查看提现详情"}>
            {isRowDetailOpen ? "收起" : "详情"}
            {isRowDetailOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </Button>
        </div>
        {isRowDetailOpen ? <div className="bank-history-detail" aria-label="提现详情"><div className="bank-section-heading"><h4>申请详情</h4><Button variant="tertiary" className="bank-action" onPress={closeDetail}>收起详情</Button></div>{detail.busy ? <SkeletonBlock label="正在读取申请详情" lines={2} /> : detail.error ? <RecoveryAlert tone="error" title="详情暂时无法读取" problem={errorCopy(detail.error)} action={<Button variant="secondary" className="bank-action" onPress={() => void openDetail(detail.id, detail.source)}>重试详情</Button>} /> : detail.value ? <HistoryDetail value={detail.value} /> : null}</div> : null}
      </article>;
    })}</div> : visible.value && !visible.value.partial && !hasMoreWithdrawalTimeline(visible.value) ? <p className="bank-empty-text">当前没有可显示的提现记录。</p> : null}
    {visible.error ? <RecoveryAlert tone="error" live title="提现记录读取未完成" problem={errorCopy(visible.error)} action={<Button variant="secondary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(!visible.value || visible.error?.status === 403)}>重新读取</Button>} details={{ summary: "查看查询信息", body: <ErrorDetails error={visible.error} /> }} /> : null}
    {hasMoreLocalRows ? (
      <Button variant="secondary" className="bank-action bank-history-more" onPress={() => setVisibleCount(c => c + 5)}>
        查看更多记录（已显示 {displayedRows.length} / 共 {rows.length} 条）
      </Button>
    ) : visible.value && hasMoreWithdrawalTimeline(visible.value) && !visible.error ? (
      <Button variant="secondary" className="bank-action bank-history-more" isDisabled={visible.busy} onPress={() => void load()}>
        {visible.busy ? "正在读取…" : "加载更多记录"}
      </Button>
    ) : null}
  </section>;
}

export function BankBindingWorkspace({ scope, availableBalance = null, ledgerRevision = null, onWalletChanged, onIdentityFailure }: { scope: string; availableBalance?: string | null; ledgerRevision?: string | null; onWalletChanged: () => void; onIdentityFailure?: IdentityFailure }) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [bindingRefresh, setBindingRefresh] = useState(0), [historyRefresh, setHistoryRefresh] = useState(0), [bindingLock, setBindingLock] = useState({ scope, value: false });
  const [bound, setBound] = useState<{ scope: string; value: boolean | null }>({ scope, value: null });
  const onBoundChange = useCallback((value: boolean | null) => setBound({ scope, value }), [scope]);
  const isBankBound = bound.scope === scope ? bound.value : null;
  if (!identity.ready) return identity.session.status === "guest" ? <RecoveryAlert tone="info" title="登录后查看提现信息" problem="银行卡资料与提现记录仅本人可见。" action={<Link className="button primary" href="/login?next=%2Faccount%3Fview%3Dwallet%26wallet%3Dwithdraw">去登录</Link>} /> : <SkeletonBlock label="正在确认登录身份" lines={3} />;
  return <div className="bank-binding-workspace" data-testid="bank-binding-workspace" data-scope={scope}>
    <div className="bank-onboarding-stepper sr-only" aria-label="提现指引流程">
      <div className={`onboarding-step ${isBankBound === true ? 'step-done' : isBankBound === false ? 'step-active' : 'step-waiting'}`}>
        <span className="step-badge">{isBankBound ? '✓' : '1'}</span>
        <div className="step-copy">
          <strong>{isBankBound === null ? '收款资料未记录' : isBankBound ? '收款资料已保存' : '第 1 步：保存收款资料'}</strong>
          <small>{isBankBound === true ? '银行卡归属尚未核验' : '填写收款银行卡资料'}</small>
        </div>
      </div>
      <div className={`onboarding-step ${isBankBound ? 'step-active' : 'step-waiting'}`}>
        <span className="step-badge">2</span>
        <div className="step-copy">
          <strong>第 2 步：金额与费用</strong>
          <small>输入提现金额并核对费用</small>
        </div>
      </div>
      <div className="onboarding-step step-waiting">
        <span className="step-badge">3</span>
        <div className="step-copy">
          <strong>第 3 步：查看处理进度</strong>
          <small>提交后可实时查询进度</small>
        </div>
      </div>
    </div>
    <div className="bank-withdrawal-grid">
      <WithdrawalPanel scope={scope} refreshKey={bindingRefresh} bindingLocked={bindingLock.scope === scope && bindingLock.value} availableBalance={availableBalance} ledgerRevision={ledgerRevision} onWalletChanged={() => { setHistoryRefresh(value => value + 1); onWalletChanged(); }} onIdentityFailure={onIdentityFailure} />
      <BankBindingPanel scope={scope} onChanged={() => setBindingRefresh(value => value + 1)} onLocked={value => setBindingLock({ scope, value })} onIdentityFailure={onIdentityFailure} onBoundChange={onBoundChange} />
    </div>
    <WithdrawalHistorySection scope={scope} refreshKey={historyRefresh} onIdentityFailure={onIdentityFailure} />
  </div>;
}
