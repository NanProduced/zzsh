"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, CreditCard, FileText, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/form-controls";
import { FieldGroup, RecoveryAlert, SkeletonBlock, StatusBadge, fieldControlProps } from "@/components/ui/information";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { walletMoney } from "@/lib/personal-wallet-client";
import { formatOrderTime } from "@/lib/order-client";
import { yuanToCents } from "@/lib/controlled-withdrawal-client";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import { pendingBankBinding, readBankBinding, recoverBankBinding, saveBankBinding, validateBankBindingInput, type BankBindingRead, type PendingBankBinding } from "@/lib/withdrawal-bank-binding-client";
import { pendingChannelWithdrawal, quoteChannelWithdrawal, readChannelWithdrawal, readChannelWithdrawalOptions, recoverChannelWithdrawal, submitChannelWithdrawal, type ChannelWithdrawalIntent, type ChannelWithdrawalQuote, type PendingChannelWithdrawal, type WithdrawalOptions } from "@/lib/channel-withdrawal-client";
import { readWithdrawalHistory, readWithdrawalHistoryItem, recoverWithdrawalFromHistory, type WithdrawalHistoryDetail, type WithdrawalHistoryRead, type WithdrawalHistoryRecovery, type WithdrawalHistorySource } from "@/lib/withdrawal-history-client";
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
  if (error.code === "RECOVERY_STORAGE_UNAVAILABLE") return "浏览器无法保存或读取原请求信息，暂不能提交新申请。请保留当前页面并联系支持。";
  if (error.code === "PENDING_REQUEST_EXISTS") return "已有结果待确认的请求，请先查询原请求。";
  if (error.code === "WRITE_LOCK_UNAVAILABLE") return "当前浏览器无法保护重复提交，请更换受支持的浏览器后重试。";
  if (error.status === 401) return "登录身份已变化，请重新确认登录后继续。";
  if (error.status === 403) return "当前账号暂不能进行此操作，已有记录仍可单独查询。";
  if (error.status === 409) return "资料或费用依据已变化，请重新读取后核对；结果未知的原请求仍需先查询。";
  if (error.status === 400) return "填写的信息不符合要求，请核对后重试。";
  if (error.status === 503) return "这项服务暂时无法使用，请稍后重新读取。";
  return "本次未能确认处理结果，请稍后重新查询。";
}

function ErrorDetails({ error }: { error: WithdrawalRequestError }) {
  return <span>错误代码：{error.code}{error.requestId ? <><br />查询编号：{error.requestId}</> : null}</span>;
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

function BankBindingPanel({ scope, onChanged, onLocked, onIdentityFailure }: {
  scope: string; onChanged: () => void; onLocked: (locked: boolean) => void; onIdentityFailure?: IdentityFailure;
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
    if (original) { setNotice("已有待确认的原保存，请先查询原请求，再选择是否重新输入原资料。"); return; }
    setNotice(""); setDraft({ ...emptyBankDraft(scope), open: true, context: { kind: "new" } });
  };
  const beginRecovery = () => {
    if (!identity.current() || writingRef.current || storageBlocked) return;
    const original = selectedRecovery ?? syncPending();
    if (!original) { setNotice("原保存记录已变化，请重新查询原保存结果。"); return; }
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
      setDraft(d => ({ ...d, error: "原保存记录已变化，当前填写不会提交。请先查询原保存结果。" })); return;
    }
    if (context.kind === "new" && latestPending) {
      setDraft(d => ({ ...d, error: "发现待确认的原保存，当前填写尚未提交。请先查询原请求，恢复时选择重新输入原资料。" })); return;
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
        setRead({ scope, value: null, busy: false, error: e }); setNotice("原保存已确认，当前收款资料还需重新读取。"); changedRef.current(); return;
      }
      if (context.kind === "recovery" && ["NO_PENDING_REQUEST", "RECOVERY_CONTEXT_CHANGED"].includes(e.code)) {
        setDraft(d => ({ ...d, error: "原保存记录已变化，本次填写未提交。请先查询原保存结果。" })); return;
      }
      setDraft(d => ({ ...d, error: p ? "原保存结果尚未确认。请先查询原请求，不要另建保存请求。" : errorCopy(e) }));
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
        setDraft(emptyBankDraft(scope)); setNotice(result.current ? "原保存结果已确认，当前收款资料已重新读取。" : "原保存已确认，当前收款资料还需重新读取。"); changedRef.current();
      } else setNotice("暂未确认原保存结果。可稍后继续查询，或重新输入当时的资料核对原请求。");
    } catch (error) { if (identity.current()) { const e = asError(error); setNotice(errorCopy(e)); identity.identityFailure(e); } }
    finally { if (identity.current()) { writingRef.current = false; setWriting(false); syncPending(); } }
  };
  return <section className="account-module-card bank-binding-panel" aria-labelledby={`${ids}-heading`} data-testid="bank-binding-panel">
    <div className="bank-section-heading"><h3 id={`${ids}-heading`}><CreditCard size={19} aria-hidden="true" />收款银行卡</h3><Button variant="tertiary" className="bank-action" isDisabled={visible.busy || writing} onPress={() => void load()} aria-label="重新读取收款资料"><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
    <p className="bank-help">仅保存你填写的收款资料，不代表银行卡开户归属已验证。</p>
    {visible.busy ? <SkeletonBlock label="正在读取收款资料" lines={2} /> : visible.error ? <RecoveryAlert tone="error" live title="收款资料暂时无法读取" problem={errorCopy(visible.error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={visible.error} /> }} /> : visible.value?.integration !== "INTEGRATED" ? <RecoveryAlert tone="unknown" title="收款资料暂未接通" problem="暂时无法确认是否已绑定，请稍后重新读取。" /> : visible.value.binding ? <>
      <div className="bank-saved"><span className="bank-card-mark" aria-hidden="true"><CreditCard size={26} /></span><div><strong>{visible.value.binding.cardMask}</strong><p>持卡人：{visible.value.binding.holderNameMask}</p></div><StatusBadge tone="neutral">资料已保存</StatusBadge></div>
      <p className="bank-meta">更新于 {timeLabel(visible.value.binding.updatedAt)}</p>
      {!form.open && !activeRecovery && !storageBlocked ? <Button variant="secondary" className="bank-action" onPress={beginEdit}>修改收款资料</Button> : null}
    </> : <div className="bank-empty"><p>尚未绑定收款银行卡。</p>{!form.open && !activeRecovery && !storageBlocked ? <Button variant="primary" className="bank-action bank-primary" onPress={beginEdit}>绑定银行卡</Button> : null}</div>}
    {storageBlocked ? <RecoveryAlert tone="unknown" title="原保存记录暂时无法读取" problem="不能确认是否有未完成请求，已暂停新的保存与提现操作。请保留当前浏览器状态。" /> : activeRecovery ? <RecoveryAlert tone="unknown" title="原保存结果待确认" problem="先查询原请求；重新输入资料时仍使用原请求，不会另建保存请求。" action={<div className="bank-actions"><Button variant="primary" className="bank-action bank-primary" isDisabled={writing} onPress={() => void recover()}>{writing ? "正在核对…" : "查询原保存结果"}</Button><Button variant="secondary" className="bank-action" isDisabled={writing || visible.value?.integration !== "INTEGRATED"} onPress={beginRecovery}>重新输入原资料</Button></div>} /> : null}
    {form.open ? <form className="bank-binding-form" onSubmit={save} noValidate>
      <FieldGroup id={`${ids}-name`} label="持卡人姓名" required helper="填写银行账户登记姓名。修改时需要重新填写，不会预填旧资料。"><Input {...fieldControlProps({ id: `${ids}-name`, helper: true })} ref={nameRef} name="bank-holder-name" autoComplete="off" spellCheck={false} maxLength={128} value={form.name} disabled={writing} onChange={e => setDraft(d => ({ ...d, name: e.target.value, error: "" }))} /></FieldGroup>
      <FieldGroup id={`${ids}-card`} label="银行卡号" required helper="15–19位数字，可粘贴带空格的卡号。"><Input {...fieldControlProps({ id: `${ids}-card`, helper: true })} name="bank-card-number" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} value={form.cardNo} disabled={writing} onChange={e => setDraft(d => ({ ...d, cardNo: e.target.value, error: "" }))} /></FieldGroup>
      {selectedRecovery ? <p className="bank-help">请填写当时提交的原姓名和卡号，以核对原保存请求。</p> : <p className="bank-help">修改收款资料不会更换已提交提现申请的收款目标。</p>}
      {form.error ? <p className="bank-form-error" role="alert">{form.error}</p> : null}
      <div className="bank-actions"><Button type="submit" variant="primary" className="bank-action bank-primary" isDisabled={writing || storageBlocked || visible.busy || visible.value?.integration !== "INTEGRATED" || (form.context?.kind === "new" && Boolean(pending)) || (selectedRecovery !== null && !sameBankPending(pending, selectedRecovery))}>{writing ? "正在保存…" : selectedRecovery ? "核对并恢复原保存" : "保存收款资料"}</Button><Button type="button" variant="secondary" className="bank-action" isDisabled={writing} onPress={closeEdit}>取消填写</Button></div>
    </form> : null}
    {notice ? <p className="bank-feedback" role="status">{notice}</p> : null}
  </section>;
}

const channelStateLabel: Record<string, string> = { RESERVED: "资金已预留", SUBMITTING: "正在提交处理", PROCESSING: "处理中", UNKNOWN: "结果待确认", CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "渠道成功观察待核验", SUCCEEDED: "本地记录处理成功", FAILED: "本地记录处理失败", RECONCILIATION_REQUIRED: "需要人工核对" };
const reasonLabel: Record<string, string> = { BANK_BINDING_REQUIRED: "请先绑定收款银行卡", BANK_BINDING_NOT_INTEGRATED: "收款资料链路尚未接通", BANK_BINDING_UNAVAILABLE: "收款资料暂时无法核对", IDENTITY_NOT_VERIFIED: "身份资料尚未满足提现要求", REAL_IDENTITY_REQUIRED: "身份资料尚未满足提现要求", REAL_IDENTITY_SOURCE_REQUIRED: "缺少可用的实名校验依据", IDENTITY_PROVIDER_MISMATCH: "身份依据暂不适用于本次提现", ADULT_STATUS_REQUIRED: "当前年龄资料不符合提现要求", USER_NOT_ADULT: "当前年龄资料不符合提现要求", IDENTITY_EXPIRED: "身份依据需要更新", IDENTITY_PROOF_EXPIRED_OR_INVALID: "实名依据已过期或无效，请重新核验", NEW_REQUESTS_DISABLED: "当前暂未开放新的提现申请", POLICY_UNAVAILABLE: "提现规则暂时无法读取", WITHDRAWAL_POLICY_UNAVAILABLE: "提现规则暂时无法读取", WITHDRAWAL_QUOTA_UNKNOWN: "今日提现次数暂时无法确认", WITHDRAWAL_QUOTA_EXHAUSTED: "今日提现申请次数已用完" };
/** Only describe what the server returned; unknown values stay unknown instead of becoming eligibility. */
function identityStatusLabel(value: string | undefined): string {
  return value === "VERIFIED" ? "已实名" : value === "UNVERIFIED" ? "未实名" : value === "REJECTED" ? "实名未通过" : "实名状态待确认";
}
function ageStatusLabel(value: string | undefined): string {
  return value === "ADULT" ? "已成年" : value === "MINOR" ? "未成年" : "年龄状态待确认";
}

function IntentFacts({ intent, onRefresh, busy }: { intent: ChannelWithdrawalIntent; onRefresh: () => void; busy: boolean }) {
  return <section className="bank-result" aria-label="原提现申请记录"><div className="bank-section-heading"><h4>申请记录</h4><StatusBadge tone={intent.requiresReview ? "unknown" : "neutral"}>{channelStateLabel[intent.state] ?? "状态待核对"}</StatusBadge></div><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(intent.amountCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(intent.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(intent.netCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{intent.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请时间</dt><dd>{timeLabel(intent.acceptedAt)}</dd></div><div><dt>申请单号</dt><dd>{intent.merchantOrderNo}</dd></div><div><dt>到账情况</dt><dd>尚未核验</dd></div></dl><p className="bank-help">申请金额、手续费和提现净额为本地记录，手续费由你承担；不代表银行已到账。修改当前银行卡不会改变这笔申请的原收款目标。</p><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={onRefresh}>刷新申请记录</Button></section>;
}

function ChannelWithdrawalPanel({ scope, refreshKey, bindingLocked, onWalletChanged, onIdentityFailure }: {
  scope: string; refreshKey: number; bindingLocked: boolean; onWalletChanged: () => void; onIdentityFailure?: IdentityFailure;
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
  const preview = async (event: FormEvent) => {
    event.preventDefault(); if (!identity.current() || !identity.userId || blocked || busyRef.current || !options?.policy || !options.bankBinding.binding) return;
    if (syncPending() !== null) return;
    try { if (pendingBankBinding(identity.userId)) { setNotice("请先确认收款资料的原保存结果，再核对提现费用。"); return; } }
    catch { setStorageBlocked(true); return; }
    let cents: string;
    try { cents = yuanToCents(amountText); if (BigInt(cents) <= 0n) throw new Error(); }
    catch { setNotice("请输入大于0、最多两位小数的提现金额。"); return; }
    busyRef.current = true; quoteBusyRef.current = true; setBusy(true); setError(null); setNotice(""); setQuote(null);
    const abort = new AbortController(), ticket = ++generation.current; request.current?.abort(); request.current = abort;
    try { const next = await quoteChannelWithdrawal(identity.userId, { amountCents: cents, destinationId: options.bankBinding.binding.id, policyVersion: options.policy.version }, abort.signal); if (identity.current() && !abort.signal.aborted && ticket === generation.current) { if (next.destination.revision !== options.bankBinding.binding.revision) { busyRef.current = false; setBusy(false); setNotice("收款资料已有更新，请重新读取后核对。"); void load(); } else setQuote({ scope, value: next }); } }
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
    try { const reply = await recoverChannelWithdrawal(identity.userId, { isCurrent: identity.current, signal: abort.signal }); if (identity.current()) { if (reply.knowledge === "KNOWN" && reply.receipt) { setKnownIntent({ scope, id: reply.receipt.id }); setResult(reply.current ? { scope, value: reply.current } : null); setAmount({ scope, value: "" }); setNotice(reply.current ? "原提交已确认，当前申请记录已读取；到账情况仍待核验。" : "原提交已确认，当前申请状态还需重新读取。"); changedRef.current(); } else setNotice("暂未确认原申请结果。原请求仍保留，请稍后继续查询。"); } }
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
    <div className="bank-section-heading"><h3 id={`${id}-title`}>银行卡提现</h3><Button variant="tertiary" className="bank-action" isDisabled={read.busy || busy} onPress={() => void load()}><RefreshCw size={15} aria-hidden="true" />读取条件</Button></div>
    <p className="bank-help">先核对提现金额、手续费与收款目标，再确认申请。</p>
    {storageBlocked ? <RecoveryAlert tone="unknown" title="原申请信息暂时无法读取" problem="无法确认是否已有提交，已暂停新申请。请保留当前浏览器状态。" /> : pending ? <RecoveryAlert tone="unknown" title="原提现申请结果待确认" problem="原金额、收款目标与请求已保留。查询确认前不会另建申请。" action={<div className="bank-actions"><Button variant="primary" className="bank-action bank-primary" isDisabled={busy} onPress={() => void recover()}>{busy ? "正在查询…" : "查询原提现申请"}</Button><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void readLocalRecovery()}>查询原申请本地记录</Button></div>} /> : null}
    {read.busy ? <SkeletonBlock label="正在读取提现条件" lines={2} /> : read.error ? <RecoveryAlert tone="error" title="提现条件暂时无法读取" problem={errorCopy(read.error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={read.error} /> }} /> : options && !options.canQuote ? <RecoveryAlert tone="unknown" title="当前暂不可申请提现" problem={[...new Set(options.reasonCodes.map(code => reasonLabel[code] ?? "暂未满足服务端提现条件"))].join("；") || "当前提现条件尚未确认。"} details={options.reasonCodes.length ? { summary: "查看原因代码", body: options.reasonCodes.join("、") } : undefined} /> : null}
    {options ? <div className="bank-eligibility" aria-label="提现资格与次数"><dl className="bank-facts">
      <div><dt>实名状态</dt><dd>{identityStatusLabel(options.identity?.identityStatus)}</dd></div>
      <div><dt>年龄状态</dt><dd>{ageStatusLabel(options.identity?.ageStatus)}</dd></div>
      {options.identity?.verifiedAt ? <div><dt>实名核验时间</dt><dd>{timeLabel(options.identity.verifiedAt)}</dd></div> : null}
      {options.quota ? <><div><dt>本时段已用</dt><dd>{options.quota.used} / {options.quota.maxIntents} 笔</dd></div><div><dt>本时段剩余</dt><dd>{options.quota.remaining} 笔</dd></div><div><dt>统计窗口</dt><dd>{timeLabel(options.quota.windowStart)} 至 {timeLabel(options.quota.windowEnd)}</dd></div></> : null}
    </dl>{!options.identity ? <p className="bank-help">身份资料未提供，不能据此认定已实名或已成年。</p> : null}{!options.quota ? <p className="bank-help">本时段提现次数未提供，不能据此认定仍有剩余额度。</p> : null}</div> : null}
    {options?.policy ? <div className="bank-policy"><span>单笔 {walletMoney(options.policy.minCents)}–{walletMoney(options.policy.maxCents)}</span><span>{options.policy.fee.kind === "FIXED" ? `手续费 ${walletMoney(options.policy.fee.cents)}` : "按比例计费，具体费用以报价为准"}</span><span>每个计次时段最多 {options.policy.maxIntents} 笔</span></div> : null}
    <form className="bank-withdraw-form" onSubmit={preview} noValidate><FieldGroup id={`${id}-amount`} label="提现金额（元）" helper="实际可申请金额、费用与资格由本次报价核对。"><Input {...fieldControlProps({ id: `${id}-amount`, helper: true })} inputMode="decimal" autoComplete="off" placeholder="填写提现金额" value={amountText} disabled={!canEditAmount} onChange={e => { setAmount({ scope, value: e.target.value }); setQuote(null); setConfirmOpen(false); setNotice(""); }} /></FieldGroup><Button type="submit" variant="secondary" className="bank-action" isDisabled={blocked || busy || !amountText}>{busy ? "正在核对…" : "核对金额与费用"}</Button></form>
    {bindingLocked ? <p className="bank-help">请先确认收款资料的保存结果，再核对提现费用。</p> : null}
    {error ? <RecoveryAlert tone={pending ? "unknown" : "error"} live title={pending ? "申请结果尚未确认" : "本次操作未完成"} problem={errorCopy(error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={error} /> }} /> : null}
    {visibleQuote && !blocked ? <div className="bank-quote"><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(visibleQuote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(visibleQuote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(visibleQuote.netCents)}</dd></div><div><dt>本次收款银行卡</dt><dd>{visibleQuote.destination.mask}</dd></div></dl><p className="bank-help bank-quote-note">手续费由你承担，报价净额为申请金额减手续费；报价不代表已扣款或银行到账。</p><Button variant="primary" className="bank-action bank-primary" isDisabled={busy} onPress={() => setConfirmOpen(true)}>确认提现申请</Button></div> : null}
    {notice ? <p className="bank-feedback" role="status">{notice}</p> : null}
    {pending && localRecovery?.scope === scope ? <section className="bank-result" aria-label="原申请本地查询结果"><h4>原申请本地查询结果</h4>{localRecovery.value.knowledge === "KNOWN" && localRecovery.value.item ? <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(localRecovery.value.item.amountCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{localRecovery.value.item.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>本地记录状态</dt><dd>{channelStateLabel[localRecovery.value.item.state] ?? "状态待核对"}</dd></div></dl><p className="bank-help">已找到原申请的本地记录；这不是原提交回执，也不代表银行到账。原请求仍保留，请勿重复提交。</p></> : <p className="bank-help">暂未找到可确认的本地记录，不能据此认定原申请未执行。原请求继续保留。</p>}</section> : null}
    {visibleResult ? <IntentFacts intent={visibleResult} onRefresh={() => void refreshIntent()} busy={busy} /> : knownIntent?.scope === scope ? <Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void refreshIntent()}>重新读取原申请记录</Button> : null}
    <ConfirmAlertDialog open={confirmOpen && Boolean(visibleQuote) && identity.ready} onOpenChange={setConfirmOpen} title="确认这笔提现申请？" description="申请受理后将按服务端结果预留资金。申请记录不代表银行已到账。" confirmLabel={busy ? "正在提交申请…" : "确认提交申请"} cancelLabel="返回核对" onConfirm={() => void submit()} busy={busy} confirmDisabled={blocked || !visibleQuote} className="bank-withdrawal-confirm" consequences={visibleQuote ? <dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(visibleQuote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(visibleQuote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(visibleQuote.netCents)}</dd></div><div><dt>收款银行卡</dt><dd>{visibleQuote.destination.mask}</dd></div></dl> : null} />
  </section>;
}

type HistorySource = Exclude<WithdrawalHistorySource, "ALL">;
type HistoryRow = { id: string; amount: string; at: string; label: string; note: string; mask?: string | null };
type HistoryView = { availability: string; reasons: string[]; rows: HistoryRow[]; cursor: string | null; snapshot: string | null; asOf: string | null; emptyText: string };
function historyView(source: HistorySource, reply: WithdrawalHistoryRead): HistoryView {
  if (source === "HISTORICAL") {
    const part = reply.sections.historical, data = part.data;
    return { availability: part.availability, reasons: part.reasonCodes, rows: data?.items.map(item => ({ id: item.id, amount: item.amountCents, at: item.occurredAt, label: `旧系统状态 ${item.sourceStatus}`, note: "渠道到账尚未核验" })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, emptyText: data?.coverage.knowledge === "KNOWN" ? "已核定的历史范围内暂无记录。" : "已读取范围内暂无记录，历史覆盖尚未确认。" };
  }
  if (source === "LOCAL_CONTROLLED") {
    const part = reply.sections.controlled, data = part.data;
    return { availability: part.availability, reasons: part.reasonCodes, rows: data?.items.map(item => ({ id: `controlled:${item.id}`, amount: item.amountCents, at: item.acceptedAt, label: channelStateLabel[item.state] ?? "状态待核对", note: "本地受控处理，不代表真实银行出款" })) ?? [], cursor: data?.pagination?.nextCursor ?? null, snapshot: data?.pagination?.snapshotVersion ?? null, asOf: data?.pagination?.asOf ?? null, emptyText: "当前已核定的本地受控范围内暂无记录。" };
  }
  const part = reply.sections.joinpay, data = part.data;
  return { availability: part.availability, reasons: part.reasonCodes, rows: data?.items.map(item => ({ id: item.id, amount: item.amountCents, at: item.occurredAt, label: item.requiresReview ? "需要人工核对" : channelStateLabel[item.state] ?? "状态待核对", note: "本地记录未重验渠道，到账待核", mask: item.originalDestination?.cardMask ?? null })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, emptyText: "本次已读取的本地渠道申请中暂无记录。" };
}

function HistoryDetail({ value }: { value: WithdrawalHistoryDetail }) {
  const item = value.source === "LOCAL_CONTROLLED" ? value.item.intent : value.source === "JOINPAY" ? value.data.item : value.item;
  const joinpay = value.source === "JOINPAY" ? value.data.item : null;
  return <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(item.amountCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(item.netCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(item.feeCents)}</dd></div>{joinpay ? <><div><dt>原收款银行卡</dt><dd>{joinpay.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请单号</dt><dd>{joinpay.merchantOrderNo}</dd></div><div><dt>渠道流水号</dt><dd>{joinpay.platformSerialNo ?? "尚未提供"}</dd></div></> : null}<div><dt>到账情况</dt><dd>尚未核验</dd></div></dl><p className="bank-help">所列净额按申请金额减手续费记录，费用由你承担；实际扣账、释放与银行到账分别核对。</p></>;
}

const sourceTitle: Record<HistorySource, string> = { HISTORICAL: "旧系统提现记录", LOCAL_CONTROLLED: "本地受控记录", JOINPAY: "银行卡提现记录" };
function WithdrawalHistorySection({ source, scope, refreshKey, onIdentityFailure }: { source: HistorySource; scope: string; refreshKey: number; onIdentityFailure?: IdentityFailure }) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [state, setState] = useState<ReadState<HistoryView>>({ scope, value: null, busy: true, error: null });
  const [detail, setDetail] = useState<{ scope: string; id: string; value: WithdrawalHistoryDetail | null; busy: boolean; error: WithdrawalRequestError | null } | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const abort = useRef<AbortController | null>(null), ticket = useRef(0), detailAbort = useRef<AbortController | null>(null), detailTicket = useRef(0);
  const visible = state.scope === scope && identity.ready ? state : { scope, value: null, busy: true, error: null };
  const load = async (cursor: string | null = null) => {
    if (!identity.current() || !identity.userId || cursor && stateRef.current.busy) return;
    abort.current?.abort(); const controller = new AbortController(), run = ++ticket.current; abort.current = controller;
    if (!cursor) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); }
    const prior = cursor && stateRef.current.scope === scope ? stateRef.current.value : null;
    setState({ scope, value: prior, busy: true, error: null });
    try {
      const response = await readWithdrawalHistory(identity.userId, { source, cursor, limit: 20 }, controller.signal);
      if (!identity.current() || controller.signal.aborted || run !== ticket.current) return;
      const next = historyView(source, response);
      if (prior && (next.availability !== "AVAILABLE" || next.snapshot !== prior.snapshot || next.asOf !== prior.asOf || next.rows.some(row => prior.rows.some(old => old.id === row.id)))) throw new WithdrawalRequestError(409, "WITHDRAWAL_SNAPSHOT_CHANGED");
      setState({ scope, value: { ...next, rows: [...(prior?.rows ?? []), ...next.rows] }, busy: false, error: null });
    } catch (error) {
      if (!identity.current() || controller.signal.aborted || run !== ticket.current) return;
      const e = asError(error);
      if ([401, 403, 409].includes(e.status)) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); }
      setState({ scope, value: e.status === 409 || e.status === 401 || e.status === 403 ? null : prior, busy: false, error: e }); identity.identityFailure(e);
    }
  };
  useEffect(() => {
    setState({ scope, value: null, busy: true, error: null }); setDetail(null);
    if (identity.ready) void load();
    return () => { ticket.current++; detailTicket.current++; abort.current?.abort(); detailAbort.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId, refreshKey, source]);
  const openDetail = async (recordId: string) => {
    if (!identity.current() || !identity.userId) return;
    detailAbort.current?.abort(); const controller = new AbortController(), run = ++detailTicket.current; detailAbort.current = controller;
    setDetail({ scope, id: recordId, value: null, busy: true, error: null });
    try { const value = await readWithdrawalHistoryItem(identity.userId, recordId, controller.signal); if (identity.current() && !controller.signal.aborted && run === detailTicket.current) setDetail({ scope, id: recordId, value, busy: false, error: null }); }
    catch (error) { if (identity.current() && !controller.signal.aborted && run === detailTicket.current) { const e = asError(error); setDetail({ scope, id: recordId, value: null, busy: false, error: e }); identity.identityFailure(e); } }
  };
  const closeDetail = () => { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); };
  const rows = visible.value?.rows ?? [], unavailable = visible.value && visible.value.availability !== "AVAILABLE";
  return <section className="account-module-card bank-history-section" data-history-source={source}>
    <div className="bank-section-heading"><h3><FileText size={18} aria-hidden="true" />{sourceTitle[source]}</h3><Button variant="tertiary" className="bank-action" isDisabled={visible.busy} onPress={() => void load()} aria-label={`刷新${sourceTitle[source]}`}><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
    <p className="bank-help">{source === "JOINPAY" ? "只展示本地保存的渠道申请，未重新核验银行到账。" : source === "LOCAL_CONTROLLED" ? "与正式银行卡提现分别记录，不代表真实出款或到账。" : "保留旧系统记录与原状态，不会因本次查询重复扣款。"}</p>
    {visible.busy && !visible.value ? <SkeletonBlock label={`正在读取${sourceTitle[source]}`} lines={2} /> : null}
    {unavailable ? <RecoveryAlert tone="unknown" title="该来源暂时无法提供记录" problem="这不表示没有提现记录，其他来源可以继续查看。" details={{ summary: "查看读取状态", body: `${visible.value!.availability}${visible.value!.reasons.length ? ` · ${visible.value!.reasons.join("、")}` : ""}` }} /> : rows.length ? <div className="bank-history-rows">{rows.map(row => <article key={row.id} className="bank-history-row"><div><StatusBadge tone="neutral">{row.label}</StatusBadge><p>{timeLabel(row.at)}</p><small>{row.mask !== undefined ? `原收款卡：${row.mask ?? "未提供"} · ` : ""}{row.note}</small></div><strong>{walletMoney(row.amount)}</strong><Button variant="tertiary" className="bank-action" onPress={() => void openDetail(row.id)} aria-label={`查看${sourceTitle[source]}详情`}>详情<ChevronDown size={14} aria-hidden="true" /></Button></article>)}</div> : visible.value?.availability === "AVAILABLE" ? <p className="bank-empty-text">{visible.value.emptyText}</p> : null}
    {visible.error ? <RecoveryAlert tone="error" live title="这部分记录读取未完成" problem={errorCopy(visible.error)} action={<Button variant="secondary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(visible.error?.status === 409 ? null : visible.value?.cursor ?? null)}>重新读取此来源</Button>} details={{ summary: "查看查询信息", body: <ErrorDetails error={visible.error} /> }} /> : null}
    {visible.value?.cursor && !visible.error ? <Button variant="secondary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(visible.value!.cursor)}>{visible.busy ? "正在读取…" : `加载更多${sourceTitle[source]}`}</Button> : null}
    {detail?.scope === scope && identity.ready ? <div className="bank-history-detail" aria-label={`${sourceTitle[source]}详情`}><div className="bank-section-heading"><h4>申请详情</h4><Button variant="tertiary" className="bank-action" onPress={closeDetail}>收起详情</Button></div>{detail.busy ? <SkeletonBlock label="正在读取申请详情" lines={2} /> : detail.error ? <RecoveryAlert tone="error" title="详情暂时无法读取" problem={errorCopy(detail.error)} action={<Button variant="secondary" className="bank-action" onPress={() => void openDetail(detail.id)}>重试详情</Button>} /> : detail.value ? <HistoryDetail value={detail.value} /> : null}</div> : null}
  </section>;
}

export function BankBindingWorkspace({ scope, onWalletChanged, onIdentityFailure }: { scope: string; onWalletChanged: () => void; onIdentityFailure?: IdentityFailure }) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [bindingRefresh, setBindingRefresh] = useState(0), [historyRefresh, setHistoryRefresh] = useState(0), [bindingLock, setBindingLock] = useState({ scope, value: false });
  if (!identity.ready) return identity.session.status === "guest" ? <RecoveryAlert tone="info" title="登录后查看提现信息" problem="银行卡资料与提现记录仅本人可见。" action={<Link className="button primary" href="/login?next=%2Faccount%3Fview%3Dwallet%26wallet%3Dwithdraw">去登录</Link>} /> : <SkeletonBlock label="正在确认登录身份" lines={3} />;
  return <div className="bank-binding-workspace" data-testid="bank-binding-workspace"><div className="bank-withdrawal-grid"><BankBindingPanel scope={scope} onChanged={() => setBindingRefresh(value => value + 1)} onLocked={value => setBindingLock({ scope, value })} onIdentityFailure={onIdentityFailure} /><ChannelWithdrawalPanel scope={scope} refreshKey={bindingRefresh} bindingLocked={bindingLock.scope === scope && bindingLock.value} onWalletChanged={() => { setHistoryRefresh(value => value + 1); onWalletChanged(); }} onIdentityFailure={onIdentityFailure} /></div><div className="bank-history-heading"><h2>提现记录</h2><p>各来源分别读取与分页，处理记录不等于银行到账。</p></div>{(["HISTORICAL", "LOCAL_CONTROLLED", "JOINPAY"] as const).map(source => <WithdrawalHistorySection key={source} source={source} scope={scope} refreshKey={historyRefresh} onIdentityFailure={onIdentityFailure} />)}</div>;
}
