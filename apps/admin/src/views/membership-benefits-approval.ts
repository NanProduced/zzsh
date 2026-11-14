import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { receiptEnvelopeIssue, type RecoveryResult, type RequestDetail } from "./approval/contract";
import { dropPendingWrite, inspectPending, pendingWriteSubject, savePendingWrite, updatePendingWriteKind, type PendingInspection } from "./approval/pending-writes";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

const CREATE_PATH = "/security/approvals/requests";
const CREATE_OPERATION = "approval.request.create";
const POLICY_OPERATIONS = new Set(["membership.benefit.policy.publish"]);
const ENTITLEMENT_OPERATIONS = new Set(["membership.entitlement.grant", "membership.entitlement.replace", "membership.entitlement.revoke"]);
const COMPENSATION_OPERATIONS = new Set(["order.compensation.grant"]);
const PRICING_OPERATIONS = new Set(["supply.rules.mode_switch"]);
const PENDING_EVENT = "zzsh:membership-approval-pending";
export type VerifiedPolicyDraftReference = { policyDraftId: string; policyDraftVersion: string; policyDraftHash: string };
export function policyDraftReferenceOf(body: Record<string, unknown>): VerifiedPolicyDraftReference | null {
  if (body.operationCode !== "membership.benefit.policy.publish") return null;
  const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : null;
  const id = payload && typeof payload.policyDraftId === "string" ? payload.policyDraftId : "";
  const version = payload && (typeof payload.policyDraftVersion === "string" || typeof payload.policyDraftVersion === "number") ? String(payload.policyDraftVersion) : "";
  const hash = payload && typeof payload.policyDraftHash === "string" ? payload.policyDraftHash : "";
  return id && version && hash ? { policyDraftId: id, policyDraftVersion: version, policyDraftHash: hash } : null;
}
export type MembershipApprovalBusiness = "policy" | "entitlement" | "compensation" | "pricing";
const BUSINESS_OPERATIONS: Record<MembershipApprovalBusiness, Set<string>> = { policy: POLICY_OPERATIONS, entitlement: ENTITLEMENT_OPERATIONS, compensation: COMPENSATION_OPERATIONS, pricing: PRICING_OPERATIONS };

function notifyPendingChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PENDING_EVENT));
}

function approvalDetailError(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.status === 403) return "无权读取原申请（403）；原记录保留，请到审批中心核对";
    if (error.status === 404) return "原申请暂未读到（404）；原记录保留，请稍后重试";
    if (error.status === 409) return "申请范围已变化（409）；原记录保留，请到审批中心核对";
    if (error.status === 0) return "原申请暂时无法读取（网络）；原记录保留";
  }
  return error instanceof Error ? error.message : "原申请暂时无法读取；原记录保留";
}

export function membershipPendingLabel(record: { body: Record<string, unknown> }): string {
  const operation = typeof record.body.operationCode === "string" ? record.body.operationCode : "";
  const payload = record.body.payload && typeof record.body.payload === "object" ? record.body.payload as Record<string, unknown> : {};
  const kind = payload.kind === "PRESTIGE" ? "尊享礼遇" : payload.kind === "FRIEND" ? "挚友礼遇" : "礼遇";
  const user = typeof payload.userId === "string" ? payload.userId : "用户待核";
  if (operation === "membership.benefit.policy.publish") return `会员政策发布 · 草稿 ${String(payload.policyDraftId ?? "待核").slice(0, 8)} v${String(payload.policyDraftVersion ?? "?")}`;
  if (operation === "membership.entitlement.grant") return `礼遇发放 · ${kind} · ${user}`;
  if (operation === "membership.entitlement.replace") return `礼遇替换/续期 · ${kind} · ${user}`;
  if (operation === "membership.entitlement.revoke") return `礼遇撤销 · 对象 ${String(payload.entitlementId ?? "待核").slice(0, 8)}`;
  return "会员申请 · 业务类型待核";
}

export function identityOf(snapshot: Snapshot) {
  return JSON.stringify([snapshot.adminUserId, snapshot.session?.id, snapshot.session?.locked, snapshot.security.status, snapshot.security.isBoss, snapshot.security.passwordChangeRequired, [...snapshot.permissions].sort()]);
}

/** Only existing approval.request.create; policy and entitlement hosts share the same original-key responsibility. */
export function useMembershipApprovalRequest(snapshot: Snapshot, business: MembershipApprovalBusiness = "entitlement") {
  const identity = identityOf(snapshot);
  const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session?.id ?? "", "", CREATE_OPERATION);
  const live = useRef(identity); live.current = identity;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const autoRecoveredRef = useRef<string | null>(null);
  const operations = BUSINESS_OPERATIONS[business];
  const [state, setState] = useState(() => ({ identity, busy: false, error: null as string | null, pending: inspectPending(subject), requestId: null as string | null, detailStatus: null as string | null, verifiedReference: null as VerifiedPolicyDraftReference | null }));
  if (state.identity !== identity) setState({ identity, busy: false, error: null, pending: inspectPending(subject), requestId: null, detailStatus: null, verifiedReference: null });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = () => { if (current()) setState((previous) => ({ ...previous, pending: inspectPending(subject) })); };
    window.addEventListener(PENDING_EVENT, refresh);
    return () => window.removeEventListener(PENDING_EVENT, refresh);
  }, [identity, subject]);
  const current = () => mounted.current && live.current === identity;
  const update = (patch: Partial<typeof state>) => { if (current()) setState(previous => ({ ...previous, ...patch })); };
  const refreshPending = () => inspectPending(subject);
  const recordOperation = (record: { body: Record<string, unknown> }) => typeof record.body.operationCode === "string" ? record.body.operationCode : "";
  const ownPending = (pending: PendingInspection) => pending.state === "valid" && (operations.has(recordOperation(pending.record)) || !recordOperation(pending.record));
  const foreignPending = (pending: PendingInspection) => pending.state === "valid" && Boolean(recordOperation(pending.record)) && !operations.has(recordOperation(pending.record));

  async function confirm(id: string, key: string, operationCode: string | undefined, body: Record<string, unknown>) {
    const detail = await adminRequest<RequestDetail>("/security/approvals/requests/detail?requestId=" + encodeURIComponent(id));
    if (!current()) return false;
    const actualOperation = typeof detail.operation?.code === "string" ? detail.operation.code : "";
    if (detail.requestId !== id) throw new Error("审批详情与申请号不一致；原记录保留");
    if (typeof operationCode !== "string" || !operationCode) throw new Error("原请求缺少业务类型，无法自动解除；原记录保留，请到审批中心核对");
    if (actualOperation !== operationCode) throw new Error("审批详情的业务类型与原请求不一致；原记录保留");
    if (operationCode === 'order.compensation.grant') {
      const submitted = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string,unknown> : null;
      const actual = detail.business?.compensation;
      if (!submitted || !actual || ['orderId','origin','gameId','ownerUserId','amountCents','caseRef','reason','evidenceRef','sourceDigest'].some(key => submitted[key] !== (actual as unknown as Record<string,unknown>)[key])) throw new Error('赔偿申请的冻结资料与原请求不一致；原记录保留');
    }
    dropPendingWrite(subject, key);
    notifyPendingChanged();
    update({ pending: refreshPending(), requestId: id, detailStatus: typeof detail.status === "string" ? detail.status : null, verifiedReference: policyDraftReferenceOf(body), error: null });
    return true;
  }

  async function submit(body: Record<string, unknown>): Promise<string | null> {
    if (inFlight.current || !current()) return null;
    if (!snapshot.session || snapshot.session.locked || snapshot.security.status !== "ACTIVE" || snapshot.security.passwordChangeRequired || !snapshot.security.isBoss && !hasPermission(snapshot, "approval.request.create")) { update({ error: "当前身份不能提交审批" }); return null; }
    if (typeof body.operationCode !== "string" || !operations.has(body.operationCode)) { update({ error: "不支持的审批操作" }); return null; }
    const existing = refreshPending();
    if (existing.state !== "absent") {
      const foreign = foreignPending(existing);
      update({ pending: existing, error: existing.state === "valid" ? foreign ? "另有审批申请待核对，请先到对应子页或审批中心处理" : "还有原请求未核清，请先查询原结果" : "原请求记录不可读，本次未提交" });
      return null;
    }
    if (!globalThis.crypto?.randomUUID) { update({ error: "无法生成请求标识，本次未提交" }); return null; }
    const key = "idem_" + crypto.randomUUID().replaceAll("-", "");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: CREATE_OPERATION, path: CREATE_PATH, idempotencyKey: key, body, readback: { kind: "lists", keys: ["mine"] }, successMessage: "已提交审批", kind: "unknown" });
    if (!saved.ok) { update({ pending: refreshPending(), error: "无法可靠保存原请求标识，本次未提交" }); return null; }
    notifyPendingChanged();
    inFlight.current = true;
    update({ busy: true, error: null, pending: refreshPending(), requestId: null, detailStatus: null, verifiedReference: null });
    let acceptedId: string | null = null;
    try {
      const result = await adminRequest<{ requestId?: string; approvalRequestId?: string }>(CREATE_PATH, body, "POST", { "idempotency-key": key });
      if (!current()) return null;
      acceptedId = result.approvalRequestId ?? result.requestId ?? null;
      updatePendingWriteKind(subject, key, "readback");
      notifyPendingChanged();
      update({ pending: refreshPending(), requestId: acceptedId });
      if (!acceptedId) throw new Error("审批已受理，但申请编号未读到，请查询原结果");
      await confirm(acceptedId, key, body.operationCode, body);
      return current() ? acceptedId : null;
    } catch (error) {
      if (!current()) return null;
      const rejected = !acceptedId && error instanceof AdminApiError && error.status >= 400 && error.status < 500 && !error.code.includes("UNKNOWN");
      if (rejected) { dropPendingWrite(subject, key); notifyPendingChanged(); }
      update({ pending: refreshPending(), requestId: acceptedId, error: rejected ? friendlyError(error) : acceptedId ? `${approvalDetailError(error)}；申请号 ${acceptedId} 已保留` : "提交结果未知，请查询原结果，勿重新办理" });
      return acceptedId;
    } finally { inFlight.current = false; update({ busy: false }); }
  }

  async function recover() {
    if (inFlight.current || !current()) return;
    const pending = refreshPending();
    update({ pending });
    if (pending.state !== "valid") { update({ error: pending.state === "unreadable" ? "原请求记录不可读，请保留现场核对" : null }); return; }
    if (foreignPending(pending)) { update({ error: "原申请属于另一业务，请到对应子页处理" }); return; }
    const original = pending.record;
    if (typeof original.body.operationCode !== "string") { update({ error: "原请求缺少业务类型，无法自动核验；原记录保留，请到审批中心核对" }); return; }
    inFlight.current = true; update({ busy: true, error: null });
    try {
      const params = new URLSearchParams({ operation: CREATE_OPERATION, key: original.idempotencyKey });
      const result = await adminRequest<RecoveryResult>("/security/approvals/recovery?" + params);
      if (!current()) return;
      if (result.knowledge !== "KNOWN") { update({ error: "原结果尚未核清；没有回执不代表未提交" }); return; }
      const issue = receiptEnvelopeIssue(result, { key: original.idempotencyKey, operation: CREATE_OPERATION, target: null });
      if (issue) { update({ error: issue }); return; }
      if (result.outcome === "REJECTED") {
        dropPendingWrite(subject, original.idempotencyKey);
        notifyPendingChanged();
        update({ pending: refreshPending(), error: "原申请已被明确拒绝，可核对原因后重新办理", requestId: null, detailStatus: null, verifiedReference: null });
      } else {
        const id = result.receipt?.approvalRequestId;
        if (!id) throw new Error("申请编号缺失");
        updatePendingWriteKind(subject, original.idempotencyKey, "readback");
        notifyPendingChanged();
        update({ pending: refreshPending(), requestId: id });
        await confirm(id, original.idempotencyKey, original.body.operationCode, original.body);
      }
    } catch (failure) { update({ pending: refreshPending(), error: approvalDetailError(failure) }); }
    finally { inFlight.current = false; update({ busy: false }); }
  }

  useEffect(() => {
    if (state.identity !== identity) return;
    const pending = inspectPending(subject);
    if (pending.state !== "valid" || pending.record.kind !== "readback") return;
    if (foreignPending(pending) || typeof pending.record.body.operationCode !== "string") return;
    if (autoRecoveredRef.current === identity) return;
    autoRecoveredRef.current = identity;
    void recover();
    // The identity/pending key is the only event that starts one read-only recovery attempt per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, subject]);

  const rawVisible = state.identity === identity ? state.pending : inspectPending(subject);
  const visiblePending = ownPending(rawVisible) ? rawVisible : rawVisible.state === "unreadable" ? rawVisible : { state: "absent" as const };
  const visibleForeign = foreignPending(rawVisible) ? rawVisible : null;
  const visibleLegacy = rawVisible.state === "valid" && !recordOperation(rawVisible.record);
  const visible = state.identity === identity ? state : { busy: false, error: null, pending: rawVisible, requestId: null, detailStatus: null, verifiedReference: null };
  return { submit, recover, busy: visible.busy, error: visible.error, pending: visiblePending, foreignPending: visibleForeign, legacyPending: visibleLegacy, requestId: visible.requestId, detailStatus: visible.detailStatus, verifiedReference: visible.verifiedReference };
}
