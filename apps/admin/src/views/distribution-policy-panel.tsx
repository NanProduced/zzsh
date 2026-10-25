import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from "../api";
import { directoryScopeOf } from "../workspace/admin-directory-read";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** GAP-014 Admin distribution policy (E-owned view). API: GET/PUT /api/v1/admin/distribution/policy via BFF /distribution/policy. */
export type DistributionLevel = { code: string; rank: number; default: boolean; renterPercent: string; ownerPercent: string; upgrade: null | { match: "ANY" | "ALL"; conditions: { metric: string; value: string }[] } };
export type DistributionPolicyConfig = { schema: "distribution-policy.v1"; scope: "LOCAL_CONTROLLED"; enabled: boolean; participation: string; depth: number; selfRebate: boolean; accountModes: ("ordinary" | "custom")[]; minimumAccrualCents: string; settlementDelayDays: number; levels: DistributionLevel[] };
export type DistributionPolicyRead = { knowledge: "KNOWN"; policy: { versionId: string; revision: string; digest: string; config: DistributionPolicyConfig; createdAt: string } } | { knowledge: "UNKNOWN"; policy: null; reason: string };
type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

export const DISTRIBUTION_POLICY_READ = "personal.distribution.policy.read";
export const DISTRIBUTION_POLICY_MANAGE = "personal.distribution.policy.manage";

/** Same rule as the API authorize(): read or manage reads; only manage writes. Boss keeps existing full access. */
export function distributionPolicyAccess(snapshot: Snapshot) {
  const boss = snapshot.security.isBoss;
  const canManage = boss || hasPermission(snapshot, DISTRIBUTION_POLICY_MANAGE);
  return { canRead: canManage || hasPermission(snapshot, DISTRIBUTION_POLICY_READ), canManage };
}

const PERCENT = /^(0|[1-9]\d{0,2})(?:\.\d{1,8})?$/;
/** Strict parse; anything unexpected fails closed instead of rendering a partial table. */
export function parseDistributionPolicyRead(value: unknown): DistributionPolicyRead {
  const v = value as Record<string, any>;
  if (!v || typeof v !== "object") throw new AdminApiError(502, "DISTRIBUTION_POLICY_CONTRACT_REQUIRED");
  if (v.knowledge === "UNKNOWN" && v.policy === null && typeof v.reason === "string") return { knowledge: "UNKNOWN", policy: null, reason: v.reason };
  const p = v.policy, c = p?.config;
  if (v.knowledge !== "KNOWN" || !p || typeof p.versionId !== "string" || !/^(0|[1-9]\d{0,18})$/.test(String(p.revision)) || typeof p.digest !== "string" || !c || c.schema !== "distribution-policy.v1" || c.scope !== "LOCAL_CONTROLLED" || typeof c.enabled !== "boolean" || !Array.isArray(c.levels) || !c.levels.length || c.levels.some((l: any) => typeof l?.code !== "string" || !PERCENT.test(l.renterPercent) || !PERCENT.test(l.ownerPercent))) throw new AdminApiError(502, "DISTRIBUTION_POLICY_CONTRACT_REQUIRED");
  return { knowledge: "KNOWN", policy: { versionId: p.versionId, revision: String(p.revision), digest: p.digest, config: c, createdAt: String(p.createdAt) } };
}

export function readDistributionPolicyAdmin(signal?: AbortSignal) {
  return adminRequest<unknown>("/distribution/policy", undefined, "GET", {}, signal).then(parseDistributionPolicyRead);
}
/** PUT keeps the store's original guards: exact expectedRevision, typed config, reason, idempotency key (adminRequest adds it). */
export function saveDistributionPolicyAdmin(body: { expectedRevision: string; config: DistributionPolicyConfig; reason: string }) {
  return adminRequest<unknown>("/distribution/policy", body as unknown as Record<string, unknown>, "PUT");
}

const metricLabel: Record<string, string> = { LAST_PAID_AMOUNT: "最近一笔实付", TOTAL_PAID_AMOUNT: "累计实付", PAID_COUNT: "实付笔数", SETTLED_REFERRAL: "已结算邀请" };
const failure = (e: unknown) => e instanceof AdminApiError ? (e.status === 403 ? "当前管理员没有分销政策权限" : e.status === 409 ? "政策已被他人修改，请重新读取后再提交" : e.status === 503 ? "分销政策资源未就绪，保持只读" : "分销政策读取或保存失败") : "分销政策读取或保存失败";

type PanelView = { scope: string; status: "loading" | "ready" | "error"; read: DistributionPolicyRead | null; message: string; enabled: boolean; reason: string; busy: boolean; notice: string };
const blank = (scope: string): PanelView => ({ scope, status: "loading", read: null, message: "", enabled: false, reason: "", busy: false, notice: "" });

export function DistributionPolicyPanel({ snapshot }: { snapshot: Snapshot }) {
  const access = distributionPolicyAccess(snapshot);
  // E-R3-01: same authorization scope as the directory module (identity, session, status, boss, effective permissions).
  // The ref advances during render, so a revocation/identity/session change invalidates in-flight GET/PUT immediately.
  const scope = directoryScopeOf(snapshot);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [stored, setView] = useState<PanelView>(() => blank(scope));
  const view = stored.scope === scope ? stored : blank(scope);
  /** Only the scope that issued a request may write its result; anything else is discarded. */
  // Request generation: bumped when a scope instance retires (incl. A→B→A) or the panel unmounts.
  const genRef = useRef(0);
  const patch = (owner: string, next: Partial<PanelView>, gen = genRef.current) => { if (scopeRef.current === owner && genRef.current === gen) setView((prev) => ({ ...(prev.scope === owner ? prev : blank(owner)), ...next })); };
  const load = async (owner: string, keepNotice = "") => {
    const gen = genRef.current;
    patch(owner, { status: "loading", notice: keepNotice }, gen);
    try {
      const read = await readDistributionPolicyAdmin();
      patch(owner, { status: "ready", read, enabled: read.knowledge === "KNOWN" ? read.policy.config.enabled : false }, gen);
    } catch (e) { patch(owner, { status: "error", message: failure(e) }, gen); }
  };
  useEffect(() => { if (access.canRead) void load(scope); return () => { genRef.current += 1; }; }, [scope]);
  if (!access.canRead) return <Alert variant="warning" role="status"><TriangleAlert aria-hidden="true" /><AlertTitle>当前管理员没有分销政策权限</AlertTitle><AlertDescription>需要读取权限；修改还需要管理权限。</AlertDescription></Alert>;
  if (view.status === "loading") return <p className="text-sm text-muted-foreground" role="status">正在读取分销政策…</p>;
  if (view.status === "error" || !view.read) return <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>分销政策读取失败</AlertTitle><AlertDescription>{view.message}</AlertDescription><AlertAction><Button type="button" size="sm" variant="outline" onClick={() => void load(scope)}>重试</Button></AlertAction></Alert>;
  const read = view.read;
  if (read.knowledge === "UNKNOWN") return <section className="space-y-2 text-sm"><h2 className="text-base font-semibold">分销政策</h2><p>当前未配置分销政策（{read.reason}），不按任何默认比例显示。</p></section>;
  const { config } = read.policy;
  const { enabled, reason, busy, notice } = view;
  const dirty = enabled !== config.enabled;
  const submit = async () => {
    const owner = scope;
    const gen = genRef.current;
    if (!access.canManage || !dirty || reason.trim().length < 3 || busy) return;
    patch(owner, { busy: true, notice: "" }, gen);
    try {
      await saveDistributionPolicyAdmin({ expectedRevision: read.policy.revision, config: { ...config, enabled }, reason: reason.trim() });
      if (scopeRef.current !== owner || genRef.current !== gen) return; // old PUT finished after identity/scope change: never touch the new page
      patch(owner, { busy: false, reason: "" }, gen);
      await load(owner, "已提交，正在重新读取当前版本");
    } catch (e) { patch(owner, { busy: false, notice: failure(e) }, gen); }
  };
  return <section className="space-y-4 text-sm" aria-labelledby="distribution-policy-heading">
    <div><h2 id="distribution-policy-heading" className="text-base font-semibold">分销政策</h2><p className="text-muted-foreground">版本 {read.policy.versionId} · 修订 {read.policy.revision} · 本地受控政策（LOCAL_CONTROLLED），不代表正式全量政策</p></div>
    <dl className="grid grid-cols-2 gap-2"><dt>状态</dt><dd>{config.enabled ? "已开启" : "未开启"}</dd><dt>适用出租方式</dt><dd>{config.accountModes.map((m) => m === "ordinary" ? "普通出租" : "定制出租").join("、")}</dd><dt>结算后到账</dt><dd>{config.settlementDelayDays} 天</dd><dt>单笔最低（分）</dt><dd>{config.minimumAccrualCents}</dd></dl>
    <Table><TableHeader><TableRow><TableHead>等级</TableHead><TableHead>排序</TableHead><TableHead>邀请租客</TableHead><TableHead>邀请号主</TableHead><TableHead>升级条件</TableHead></TableRow></TableHeader>
      <TableBody>{config.levels.map((l) => <TableRow key={l.code}><TableCell>{l.code}{l.default ? "（默认）" : ""}</TableCell><TableCell>{l.rank}</TableCell><TableCell>{l.renterPercent}%</TableCell><TableCell>{l.ownerPercent}%</TableCell><TableCell>{l.upgrade ? `${l.upgrade.match === "ALL" ? "全部满足" : "任一满足"}：${l.upgrade.conditions.map((c) => `${metricLabel[c.metric] ?? c.metric} ≥ ${c.value}`).join("；")}` : "—"}</TableCell></TableRow>)}</TableBody></Table>
    {access.canManage ? <div className="space-y-2 border-t pt-3"><div className="flex items-center gap-2"><span>变更后状态：{enabled ? "开启" : "关闭"}</span><Button type="button" size="sm" variant="outline" aria-pressed={enabled} aria-label="切换分销政策开关" disabled={busy} onClick={() => patch(scope, { enabled: !enabled })}>{enabled ? "改为关闭" : "改为开启"}</Button></div><Textarea value={reason} onChange={(e) => patch(scope, { reason: e.target.value })} maxLength={500} placeholder="变更原因（必填，至少 3 个字）" disabled={busy} /><Button type="button" disabled={!dirty || reason.trim().length < 3 || busy} onClick={() => void submit()}>{busy ? "提交中…" : "提交变更"}</Button></div> : <p className="text-muted-foreground">只读：修改需要分销政策管理权限。</p>}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}