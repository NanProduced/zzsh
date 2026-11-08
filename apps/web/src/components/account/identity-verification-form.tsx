"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { webAuthRequest, WebAuthError } from "@/lib/web-auth-request";
import type { UserIdentitySnapshot } from "@/app/user-account-status";

type Capability = UserIdentitySnapshot["verificationCapability"];
type Pending = { state: "NONE" } | { state: "SAVED"; key: string } | { state: "UNREADABLE" };
type Receipt = { status: "VERIFIED" | "REJECTED" | "UNKNOWN"; ageStatus: "ADULT" | "MINOR" | "UNKNOWN"; message: string;
  verificationAttempt?: { state: "COMPLETED" | "PENDING" | "UNKNOWN"; noReissue?: boolean }; previousIdentityPreserved?: boolean };
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const storageKey = (userId: string) => `zzsh.identity-verification.${encodeURIComponent(userId)}`;

/** Only an opaque command key survives navigation; never the submitted name or document. */
export function readIdentityVerificationKey(userId: string): Pending {
  try { const key = window.sessionStorage.getItem(storageKey(userId)); return key === null ? { state: "NONE" } : keyPattern.test(key) ? { state: "SAVED", key } : { state: "UNREADABLE" }; }
  catch { return { state: "UNREADABLE" }; }
}
function remember(userId: string, key: string): boolean {
  try {
    const previous = readIdentityVerificationKey(userId);
    if (previous.state !== "NONE" || !keyPattern.test(key)) return false;
    window.sessionStorage.setItem(storageKey(userId), key);
    return window.sessionStorage.getItem(storageKey(userId)) === key;
  } catch { return false; }
}
function forget(userId: string, key: string): boolean {
  try { if (window.sessionStorage.getItem(storageKey(userId)) !== key) return false; window.sessionStorage.removeItem(storageKey(userId)); return window.sessionStorage.getItem(storageKey(userId)) === null; }
  catch { return false; }
}
export function identityCapabilityReady(capability: Capability): boolean {
  if (capability?.available !== true || typeof capability.real !== "boolean") return false;
  if (capability.real !== true) return true;
  return capability.idempotencyRequired === true && Boolean(typeof capability.privacy?.versionId === "string" && capability.privacy.versionId.length > 0
    && /^[a-f0-9]{64}$/.test(capability.privacy.digest) && typeof capability.privacy.title === "string"
    && (capability.disclosure?.versionId === "identity-provider-transfer-v1" || capability.disclosure?.versionId === "identity-provider-transfer-market-v1") && /^[a-f0-9]{64}$/.test(capability.disclosure.digest)
    && typeof capability.disclosure.body === "string" && capability.disclosure.body.trim().length > 0 && capability.disclosure.body.length <= 4000);
}
export function parseIdentityVerificationReceipt(value: unknown, attemptRequired: boolean): Receipt {
  const receipt = value as Receipt;
  if (!receipt || !["VERIFIED", "REJECTED", "UNKNOWN"].includes(receipt.status) || !["ADULT", "MINOR", "UNKNOWN"].includes(receipt.ageStatus)
    || typeof receipt.message !== "string" || receipt.message.length > 2000
    || attemptRequired && !receipt.verificationAttempt
    || receipt.verificationAttempt && (!["COMPLETED", "PENDING", "UNKNOWN"].includes(receipt.verificationAttempt.state)
      || receipt.verificationAttempt.state !== "COMPLETED" && (receipt.status !== "UNKNOWN" || receipt.verificationAttempt.noReissue !== true))) throw new WebAuthError(502, "IDENTITY_RESPONSE_UNCONFIRMED", true);
  return receipt;
}

export function IdentityVerificationForm({ userId, identityStatus, capability, canAct, onCompleted }: {
  userId: string; identityStatus: string; capability: Capability; canAct: () => boolean; onCompleted: (message: string) => void;
}) {
  const session = useUserSession(), store = useUserSessionStore();
  const scope = `${userId}:${session.identityVersion}`;
  const [state, setState] = useState<{ scope: string; pending: Pending; busy: boolean; message: string }>({ scope: "", pending: { state: "NONE" }, busy: false, message: "" });
  const [fullName, setFullName] = useState(""), [documentNumber, setDocumentNumber] = useState(""), [acceptedFor, setAcceptedFor] = useState(""), [retryAt, setRetryAt] = useState<number | null>(null);
  const live = useRef({ scope, canAct, mounted: false }); live.current.scope = scope; live.current.canAct = canAct;
  const controller = useRef<AbortController | null>(null), sequence = useRef(0);
  const mayStart = () => { const latest = store.getSnapshot(); return latest.status === "authenticated" && latest.userId === userId
    && `${latest.userId}:${latest.identityVersion}` === scope && live.current.canAct(); };
  const current = (token: number) => { const latest = store.getSnapshot(); return live.current.mounted && sequence.current === token && live.current.scope === scope
    && latest.status === "authenticated" && latest.userId === userId && `${latest.userId}:${latest.identityVersion}` === scope && live.current.canAct(); };
  useEffect(() => {
    live.current.mounted = true; setFullName(""); setDocumentNumber(""); setAcceptedFor("");
    setState({ scope, pending: readIdentityVerificationKey(userId), busy: false, message: "" });
    return () => { live.current.mounted = false; sequence.current++; controller.current?.abort(); };
  }, [scope, userId]);
  const consentContext = JSON.stringify([capability?.real, capability?.privacy?.versionId, capability?.privacy?.digest, capability?.disclosure?.versionId, capability?.disclosure?.digest]);
  const consented = acceptedFor === consentContext;
  useEffect(() => { if (retryAt === null) return; const timer = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now())); return () => window.clearTimeout(timer); }, [retryAt]);
  const visible = state.scope === scope ? state : null;
  if (!visible || session.status !== "authenticated" || session.userId !== userId) return null;
  const ready = identityCapabilityReady(capability);
  if (visible.pending.state === "NONE" && (identityStatus === "VERIFIED" || !ready)) return null;

  const applyReceipt = (receipt: Receipt, key: string) => {
    if (receipt.verificationAttempt && receipt.verificationAttempt.state !== "COMPLETED") {
      setState({ scope, pending: { state: "SAVED", key }, busy: false, message: "本次核验结果尚未确认，请按原请求查询；不要重新提交或更换请求。" }); return;
    }
    const cleared = forget(userId, key);
    setState({ scope, pending: cleared ? { state: "NONE" } : { state: "SAVED", key }, busy: false, message: receipt.message });
    onCompleted(receipt.message + (cleared ? "" : " 原请求标记尚未清理，请继续按原请求读取，不要重新提交。"));
  };
  const recover = async () => {
    if (visible.busy || retryAt !== null || visible.pending.state !== "SAVED" || !mayStart()) return;
    const key = visible.pending.key, token = ++sequence.current; controller.current?.abort(); controller.current = new AbortController();
    setState({ scope, pending: { state: "SAVED", key }, busy: true, message: "" });
    try {
      const receipt = parseIdentityVerificationReceipt(await webAuthRequest<unknown>("/identity/verification-attempt", undefined, controller.current.signal, { "Idempotency-Key": key }), true);
      if (current(token)) applyReceipt(receipt, key);
    } catch (error) {
      if (!current(token)) return;
      if (error instanceof WebAuthError && error.status === 401) session.revalidate();
      if (error instanceof WebAuthError && error.retryAt) setRetryAt(error.retryAt);
      setState({ scope, pending: { state: "SAVED", key }, busy: false, message: "原核验结果暂时无法读取，原请求仍保留；不要换键重新提交，请稍后查询或联系平台核对。" });
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (visible.busy || retryAt !== null || visible.pending.state !== "NONE" || !ready || !mayStart()) return;
    const name = fullName.trim().normalize("NFC"), document = documentNumber.trim().toUpperCase();
    if (!name || name.length > 64 || !/^\d{17}[0-9X]$/.test(document) || !consented) {
      setState({ ...visible, message: !consented ? "请阅读说明并单独确认本次核验。" : "请填写本人姓名及18位身份证号码。" }); return;
    }
    const key = `identity_${crypto.randomUUID()}`;
    if (!remember(userId, key)) { setState({ scope, pending: readIdentityVerificationKey(userId), busy: false, message: "浏览器无法保存本次核验请求，尚未提交。请恢复会话存储后重试。" }); return; }
    const token = ++sequence.current; controller.current?.abort(); controller.current = new AbortController();
    setState({ scope, pending: { state: "SAVED", key }, busy: true, message: "" });
    setFullName(""); setDocumentNumber(""); setAcceptedFor("");
    try {
      const body = { fullName: name, documentNumber: document, ...(capability?.real && capability.privacy && capability.disclosure ? { privacyAcceptance: {
        accepted: true, versionId: capability.privacy.versionId, digest: capability.privacy.digest, disclosureVersion: capability.disclosure.versionId,
      } } : {}) };
      const receipt = parseIdentityVerificationReceipt(await webAuthRequest<unknown>("/identity/verify", body, controller.current.signal, { "Idempotency-Key": key }), capability?.idempotencyRequired === true);
      if (current(token)) applyReceipt(receipt, key);
    } catch (error) {
      if (!current(token)) return;
      if (error instanceof WebAuthError && error.status === 401) session.revalidate();
      if (error instanceof WebAuthError && error.retryAt) setRetryAt(error.retryAt);
      const rejected = error instanceof WebAuthError && !error.accepted && [400, 403, 409, 429].includes(error.status);
      const cleared = rejected && forget(userId, key);
      setState({ scope, pending: cleared ? { state: "NONE" } : { state: "SAVED", key }, busy: false, message: cleared
        ? error instanceof WebAuthError && error.status === 429 ? "已达到核验次数或间隔限制，请按提示稍后再申请。"
          : "本次核验未受理，请核对资料、账号资格及当前隐私文书后重新填写。"
        : "本次提交结果尚未确认，已保留原请求；请只查询原结果，不要重复提交。" });
    }
  };
  return <section className="identity-verification-form" aria-labelledby="identity-verification-form-title" aria-busy={visible.busy}>
    <h3 id="identity-verification-form-title">{visible.pending.state !== "NONE" ? "核对上次实名请求" : capability?.real ? "完成本次实名认证" : "本地模拟校验"}</h3>
    {visible.message ? <p className="account-module-note" role="status">{visible.message}</p> : null}
    {visible.pending.state === "UNREADABLE" ? <p role="alert">原核验请求记录无法读取，已阻止新的提交。请保留当前状态并联系平台核对，勿清除后重新提交。</p>
      : visible.pending.state === "SAVED" ? <><p className="account-module-note">原请求已保存，只查询原结果，不会再次向实名服务发起核验；无需重新填写姓名或证件。</p><button type="button" className="button secondary" disabled={visible.busy || retryAt !== null} onClick={() => void recover()}>{visible.busy ? "正在核对…" : "查询原核验结果"}</button></>
        : <form onSubmit={event => void submit(event)} autoComplete="off">
          {capability?.real ? <><p className="account-module-note identity-verification-disclosure">{capability.disclosure?.body}</p><a href={`/legal/privacy?version=${encodeURIComponent(capability.privacy!.versionId)}`} target="_blank" rel="noopener noreferrer">阅读《{capability.privacy!.title || "隐私政策"}》（新窗口）</a></> : <p className="account-module-note">仅用于本地模拟，不代表真实身份核验。请勿填写真实姓名或身份证。</p>}
          <label className="identity-verification-field" htmlFor="identity-full-name">本人姓名<input id="identity-full-name" name="fullName" value={fullName} maxLength={64} disabled={visible.busy} onChange={event => setFullName(event.target.value)} autoComplete="off" /></label>
          <label className="identity-verification-field" htmlFor="identity-document-number">身份证号码<input id="identity-document-number" name="documentNumber" value={documentNumber} maxLength={18} disabled={visible.busy} onChange={event => setDocumentNumber(event.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label className="identity-verification-consent"><input id="identity-verification-consent" type="checkbox" checked={consented} disabled={visible.busy} onChange={event => setAcceptedFor(event.target.checked ? consentContext : "")} /><span>{capability?.real ? "我已阅读本次核验说明和隐私政策，同意按说明提交本人姓名和身份证号。" : "我确认这是用于本地模拟的测试资料。"}</span></label>
          <button type="submit" className="button primary" disabled={visible.busy || retryAt !== null}>{visible.busy ? "正在提交…" : capability?.real ? "提交本次实名核验" : "提交模拟校验"}</button>
        </form>}
    {retryAt !== null ? <p className="account-module-note">请求受到频率限制，请稍后再操作；不会自动重新发起核验。</p> : null}
  </section>;
}
