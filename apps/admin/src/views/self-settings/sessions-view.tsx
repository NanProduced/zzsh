import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { CopyIcon, LogOutIcon, MonitorIcon, TerminalIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui-elements";
import { StepUpCaptcha } from "../../components/altcha-field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import {
  beijingDateTime,
  canRevokeRow,
  classifyReadFailure,
  ContractViolation,
  expiresInPhrase,
  relativePastPhrase,
  otherSessionCount,
  parseRevokePayload,
  parseSessionsPayload,
  reconcileRevokedTarget,
  revokeDoneNotice,
  NOT_PROVIDED_TEXT,
  type ReadFailure,
  type SessionRow,
  type SessionsFacts,
} from "./model";
import { MissingValue, SettingsGroup, SettingsNotice, SettingsPageHeader } from "./settings-shell";

export type SessionsViewProps = {
  adminUserId: string;
  sessionId: string;
  accountStatus: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
  locked: boolean;
  load: () => Promise<unknown>;
  /** 缺少写回调即表示撤销合同未接入：给出原因并禁用，不放装饰性按钮。 */
  revokeSession?: (input: { sessionId: string; password: string; totpCode: string }) => Promise<unknown>;
  revokeOtherSessions?: (input: { sessionIds: string[]; password: string; totpCode: string }) => Promise<unknown>;
  writeDisabledReason?: string;
  /** 既有快照/会话刷新协调；本包不自建全局 401/423 处理。 */
  onSessionRefresh?: () => Promise<unknown> | unknown;
  onDirtyChange?: (dirty: boolean) => void;
};

type Pending = { kind: "single"; sessionId: string } | { kind: "others" } | null;
type ConfirmTarget = { kind: "single"; row: SessionRow } | { kind: "others"; sessionIds: string[] } | null;
type Outcome = { kind: "done" | "unknown" | "checked" | "rejected"; message: string };

function rowTitle(row: SessionRow): string {
  return row.createdAt === null ? "创建时间未提供" : `${beijingDateTime(row.createdAt)} 登录`;
}

/** 设备主文案：优先服务端 UA 解析；旧接口未解析时退回原始 UA。 */
function deviceLabel(row: SessionRow): string | null {
  return row.client?.label ?? row.userAgent;
}

export function SessionsView({
  adminUserId,
  sessionId,
  accountStatus,
  locked,
  load,
  revokeSession,
  revokeOtherSessions,
  writeDisabledReason,
  onSessionRefresh,
  onDirtyChange,
}: SessionsViewProps) {
  const identityKey = `${adminUserId}|${sessionId}|${accountStatus}|${locked ? "locked" : "unlocked"}`;
  const identityKeyRef = useRef(identityKey);
  const epochRef = useRef(0);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  const [facts, setFacts] = useState<SessionsFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<ReadFailure | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const stepUpReady = password.length > 0 && /^\d{6}$/.test(totpCode);
  const openConfirm = (target: NonNullable<ConfirmTarget>) => { setPassword(""); setTotpCode(""); setConfirmTarget(target); };
  const closeConfirm = () => { setPassword(""); setTotpCode(""); setConfirmTarget(null); };
  const reconcileTargetRef = useRef<string[] | null>(null);
  const pendingRef = useRef(false);

  const isCurrent = (epoch: number, seq: number) => mountedRef.current && epochRef.current === epoch && seqRef.current === seq;

  useLayoutEffect(() => {
    if (identityKeyRef.current === identityKey) return;
    identityKeyRef.current = identityKey;
    epochRef.current += 1;
    // 切身份/会话失效/锁定：上一身份的会话投影与未决结论立即失效。
    setFacts(null);
    setLoadFailure(null);
    setPending(null);
    pendingRef.current = false;
    setConfirmTarget(null);
    setOutcome(null);
    reconcileTargetRef.current = null;
  }, [identityKey]);

  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  // 有未决写或待确认弹窗时视为离开风险，复用既有 dirty 离开保护。
  useEffect(() => {
    onDirtyChange?.(pending !== null || confirmTarget !== null || outcome?.kind === "unknown");
  }, [pending, confirmTarget, outcome?.kind, onDirtyChange]);

  const read = useCallback(
    async (options?: { silent?: boolean }) => {
      const epoch = epochRef.current;
      const seq = ++seqRef.current;
      if (!options?.silent) setLoading(true);
      if (locked || accountStatus !== "ACTIVE") {
        setFacts(null);
        setLoading(false);
        return;
      }
      try {
        const parsed = parseSessionsPayload(await load());
        if (!isCurrent(epoch, seq)) return;
        if (parsed.currentSessionId && parsed.currentSessionId !== sessionId) {
          throw new ContractViolation("返回的当前会话与本页会话不一致");
        }
        setFacts(parsed);
        setLoadFailure(null);
        // 未知结果的注销只做列表读回核对（合同 §2.2）：目标已不在有效列表即安全目标已达成。
        const targetIds = reconcileTargetRef.current;
        if (targetIds) {
          reconcileTargetRef.current = null;
          const remaining = targetIds.filter((id) => parsed.rows.some((row) => row.id === id));
          setOutcome({
            kind: remaining.length ? "checked" : "done",
            message: targetIds.length === 1
              ? reconcileRevokedTarget(parsed.rows, targetIds[0]!).text
              : `本次选择的 ${targetIds.length} 条会话中，当前仍有 ${remaining.length} 条在有效列表；这只描述当前事实，不证明原请求是否执行。新登录会话未计入本次核对。`,
          });
        }
      } catch (error) {
        if (!isCurrent(epoch, seq)) return;
        const failure = classifyReadFailure(error, "会话列表读取未完成");
        setLoadFailure(failure);
        if (["unauthorized", "forbidden", "locked", "contract"].includes(failure.kind)) {
          setFacts(null);
          setConfirmTarget(null);
        }
      } finally {
        if (isCurrent(epoch, seq)) setLoading(false);
      }
    },
    [identityKey, load],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const rows = facts?.rows ?? [];
  const others = otherSessionCount(rows);
  const currentMarked = facts !== null && facts.currentSessionId !== null;
  const writeUnavailable = !revokeSession && !revokeOtherSessions && !writeDisabledReason;
  const frozen = accountStatus === "FROZEN";
  // 撤销动作互斥：任一行处理中时其他行与批量动作都不可再点，避免并发目标集合漂移。
  const actionsBlocked = loading || pending !== null || outcome?.kind === "unknown" || Boolean(loadFailure) || !currentMarked || accountStatus !== "ACTIVE" || locked || writeUnavailable;

  const runRevoke = async (target: NonNullable<ConfirmTarget>) => {
    if (actionsBlocked || pendingRef.current || writeDisabledReason || !stepUpReady) return;
    pendingRef.current = true;
    const stepUp = { password, totpCode };
    setPassword(""); setTotpCode("");
    const epoch = epochRef.current;
    const seq = ++seqRef.current;
    const scope = target.kind === "single" ? "single" : "others";
    const targetId = target.kind === "single" ? target.row.id : null;
    const targetIds = target.kind === "single" ? [target.row.id] : target.sessionIds;
    setConfirmTarget(null);
    setPending(scope === "single" ? { kind: "single", sessionId: targetId as string } : { kind: "others" });
    setOutcome(null);
    try {
      let revokedSessionCount = 0;
      if (scope === "single") {
        if (!revokeSession) throw new Error("撤销单个会话的接口尚未接入");
        revokedSessionCount = parseRevokePayload(await revokeSession({ sessionId: targetId as string, ...stepUp })).revokedSessionCount;
      } else {
        if (!revokeOtherSessions) throw new Error("退出其他设备的接口尚未接入");
        revokedSessionCount = parseRevokePayload(await revokeOtherSessions({ sessionIds: [...targetIds], ...stepUp })).revokedSessionCount;
      }
      if (!isCurrent(epoch, seq)) return;
      if (revokedSessionCount !== targetIds.length) throw new ContractViolation("注销计数与本次确认的目标集合不一致");
      setOutcome({ kind: "done", message: revokeDoneNotice(scope, revokedSessionCount) });
      try {
        await onSessionRefresh?.();
      } catch {
        if (isCurrent(epoch, seq)) setOutcome({ kind: "done", message: "注销结果已确认，但顶部会话状态刷新失败；请手动刷新页面。" });
      }
      // 成功后一律以服务端列表为准重新读取，不在本地删行后宣布完成。
      if (isCurrent(epoch, seq)) await read({ silent: true });
    } catch (error) {
      if (!isCurrent(epoch, seq)) return;
      const failure = classifyReadFailure(error, "注销未完成");
      if (["unauthorized", "forbidden", "locked"].includes(failure.kind)) {
        setFacts(null);
        setLoadFailure(failure);
        return;
      }
      if (scope === "single" && failure.kind === "notFound") {
        // 404 也可能来自尚未装配的路由；仅凭状态码不能证明目标会话已经消失。
        reconcileTargetRef.current = targetIds;
        setOutcome({ kind: "unknown", message: "未能确认注销结果，正在核对当前会话列表；未重发注销命令。" });
        await read({ silent: true });
      } else if (scope === "others" && failure.kind === "notFound") {
        setOutcome({ kind: "rejected", message: "本次批量操作未完成，目标列表可能已变化。请重新读取后再选择；这不证明此前未知请求未执行。" });
        await read({ silent: true });
      } else if (failure.kind === "network" || failure.kind === "server" || failure.kind === "contract") {
        // 结果未知：保留原列表事实，只允许读回核对，绝不自动重发（批量重发会误伤新建会话）。
        reconcileTargetRef.current = targetIds;
        setOutcome({
          kind: "unknown",
          message: `${failure.message} 注销是否已生效无法确认；列表未做本地改动，请用「重新读取列表」核对。`,
        });
      } else {
        setOutcome({ kind: "rejected", message: `注销未完成：${failure.message} 当前列表保持不变。` });
      }
    } finally {
      // pending 是组件本地状态：成功路径里的重读会推进 seq，这里只能按身份/挂载判定，否则动作永久禁用。
      if (mountedRef.current && epochRef.current === epoch) {
        pendingRef.current = false;
        setPending(null);
      }
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6 lg:p-8">
      <SettingsPageHeader
        eyebrow="设置 · 设备与会话"
        title="设备与会话"
        description="查看在哪些设备上登录过，退出不再使用或不认识的设备。"
      />
      {locked || accountStatus !== "ACTIVE" ? (
        <SettingsNotice tone="warning">{locked ? "当前会话已锁定，解锁后可查看会话列表。" : accountStatus === "FROZEN" ? "账号已冻结，会话列表暂不可用。" : "请先完成身份验证后查看会话列表。"}</SettingsNotice>
      ) : null}

      {loadFailure ? (
        <SettingsNotice tone="danger" role="alert" action={<Button size="sm" variant="secondary" onClick={() => void read()} disabled={loading}>重新读取</Button>}>
          {loadFailure.message}
          {loadFailure.requestId ? <span className="mt-1 block break-all font-mono text-[11px]">请求编号 {loadFailure.requestId}</span> : null}
        </SettingsNotice>
      ) : null}

      {loading && !facts ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : null}

      {facts ? (
        <>
          {!currentMarked ? (
            <SettingsNotice tone="warning" role="alert">
              服务端未标记当前会话，无法可靠区分「本次登录」与「其他会话」。为避免误注销自己，本页暂时禁用注销动作，请重新读取或核对合同字段。
            </SettingsNotice>
          ) : null}
          {rows.length === 0 ? (
            <SettingsNotice tone="warning" role="alert" action={<Button size="sm" variant="secondary" onClick={() => void read()} disabled={loading}>重新读取</Button>}>
              未读到任何会话记录，包括当前会话。已登录状态下这属于异常返回，本页不把它显示成「没有会话」。
            </SettingsNotice>
          ) : null}
          {frozen ? (
            <SettingsNotice tone="danger" role="alert">
              账号已冻结：注销动作当前不可用。
            </SettingsNotice>
          ) : null}
          {writeUnavailable ? (
            <SettingsNotice tone="warning">
              本人会话撤销接口尚未接入（等待 ADM-SELF-SETTINGS-BACKEND-1 装配）。当前只能读取列表。
            </SettingsNotice>
          ) : null}
          {outcome ? (
            <SettingsNotice
              tone={outcome.kind === "done" ? "success" : outcome.kind === "rejected" ? "danger" : "warning"}
              role={outcome.kind === "done" ? "status" : "alert"}
              action={
                outcome.kind === "unknown" ? (
                  <Button size="sm" variant="secondary" onClick={() => void read()} disabled={loading}>
                    重新读取列表
                  </Button>
                ) : undefined
              }
            >
              {outcome.message}
            </SettingsNotice>
          ) : null}

          <SettingsGroup title="当前会话" description="一个设备或浏览器可能保留多条会话；本列表按会话逐条展示，不是设备清单。时间均为北京时间。">
            {rows.filter((row) => row.current).map((row) => (
              <SessionRowView key={row.id} row={row} current />
            ))}
            {!currentMarked && rows.length > 0 ? (
              <div className="p-4">
                <p className="text-muted-foreground text-xs">当前会话未标记，下方列表按服务端返回原样展示。</p>
              </div>
            ) : null}
          </SettingsGroup>

          <SettingsGroup
            title={others > 0 ? `其他会话（${others}）` : "其他会话"}
            description={
              others > 0
                ? "逐条注销只影响所选会话；「退出其他设备」只影响本次确认的固定会话集合。"
                : "除当前会话外没有其他有效会话。这不代表本页读取失败，也不影响当前登录。"
            }
            aside={
              others > 0 ? (
                <Button type="button" size="sm" variant="destructive" disabled={actionsBlocked || (!revokeOtherSessions && !writeDisabledReason) || others > 50} onClick={() => openConfirm({ kind: "others", sessionIds: rows.filter(canRevokeRow).map((row) => row.id) })}>
                  <LogOutIcon />
                  <span>退出其他设备（{others}）</span>
                </Button>
              ) : null
            }
          >
            {others > 50 ? <p className="p-4 text-xs text-muted-foreground">单次批量注销最多 50 条，当前超过上限，请先逐条注销。</p> : null}
            {others > 0 ? (
              rows.filter(canRevokeRow).map((row) => (
                <SessionRowView
                  key={row.id}
                  row={row}
                  pending={pending?.kind === "single" && pending.sessionId === row.id}
                  disabled={actionsBlocked || (!revokeSession && !writeDisabledReason)}
                  onRevoke={() => openConfirm({ kind: "single", row })}
                />
              ))
            ) : (
              <div className="p-4">
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <MonitorIcon className="size-4 shrink-0" aria-hidden />
                  没有其他会话。
                </p>
              </div>
            )}
          </SettingsGroup>
        </>
      ) : null}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) closeConfirm();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmTarget?.kind === "others" ? "退出其他设备" : "注销该会话"}</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {confirmTarget?.kind === "others"
                ? `将注销本次选择的 ${confirmTarget.sessionIds.length} 条其他会话，当前会话保留。此后新登录的会话不在此范围内。`
                : confirmTarget?.kind === "single"
                  ? `仅注销这一条会话：${rowTitle(confirmTarget.row)}。当前会话与其他会话不受影响。`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs leading-relaxed">
            确认后对应设备需要重新登录，无法撤回。取消不会发出任何请求。
          </p>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (confirmTarget && stepUpReady) void runRevoke(confirmTarget); }}>
            <label className="block space-y-1">
              <span className="text-xs font-medium">本人密码</span>
              <PasswordInput autoComplete="current-password" value={password} disabled={Boolean(writeDisabledReason)}
                onChange={(event) => setPassword(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none!" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">6 位动态验证码</span>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} disabled={Boolean(writeDisabledReason)}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="focus-visible:outline-none!" />
            </label>
            <StepUpCaptcha />
          </form>
          <DialogFooter>
            {writeDisabledReason ? <p className="text-xs text-muted-foreground">{writeDisabledReason}</p> : null}
            <Button type="button" size="sm" variant="ghost" onClick={closeConfirm}>
              取消
            </Button>
            <Button type="button" size="sm" variant="destructive" disabled={Boolean(writeDisabledReason) || !stepUpReady} onClick={() => confirmTarget && void runRevoke(confirmTarget)}>
              确认注销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionRowView({
  row,
  current = false,
  pending = false,
  disabled = false,
  onRevoke,
}: {
  row: SessionRow;
  current?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onRevoke?: () => void;
}) {
  return (
    <div className={current ? "bg-surface-raised/70 p-4" : "p-4"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground break-words [overflow-wrap:anywhere]" title={row.userAgent ?? undefined}>
              {deviceLabel(row) ?? "设备未识别"}
            </h3>
            {current ? <Badge variant="secondary">当前会话</Badge> : null}
            {row.client?.isScript ? <Badge variant="warning" title="该会话不是由浏览器建立的，若不是你本人运行的脚本，请立即退出并修改密码。"><TerminalIcon className="size-3" aria-hidden />脚本/非浏览器客户端</Badge> : null}
            {row.locked ? <Badge variant="warning">已锁屏</Badge> : null}
            {pending ? <Badge variant="info">处理中…</Badge> : null}
          </div>
          <dl className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div className="flex min-w-0 items-baseline gap-1">
              <dt className="sr-only">登录时间</dt>
              <dd>{rowTitle(row)}</dd>
            </div>
            {row.lastActiveAt !== null ? (
              <div className="flex min-w-0 items-baseline gap-1" title={beijingDateTime(row.lastActiveAt)}>
                <dt>最近活跃</dt>
                <dd className="text-foreground">{relativePastPhrase(row.lastActiveAt)}</dd>
              </div>
            ) : null}
            {row.ipAddress !== null ? (
              <div className="flex min-w-0 items-baseline gap-1" title={row.ipMasked ? "非当前设备的 IP 已部分隐藏" : undefined}>
                <dt>IP</dt>
                <dd className="text-foreground font-mono">{row.ipAddress}{row.region ? <span className="font-sans text-muted-foreground"> · {row.region}</span> : null}</dd>
              </div>
            ) : null}
            <div className="flex min-w-0 items-baseline gap-1" title={row.expiresAt === null ? undefined : `北京时间 ${beijingDateTime(row.expiresAt)} 到期`}>
              <dt className="sr-only">有效期</dt>
              <dd>{row.expiresAt === null ? <MissingValue /> : <span className="text-foreground">{expiresInPhrase(row.expiresAt)}</span>}</dd>
            </div>
            {deviceLabel(row) === null ? (
              <div className="flex min-w-0 items-baseline gap-1">
                <dt>客户端</dt>
                <dd><MissingValue /></dd>
              </div>
            ) : null}
          </dl>
          <button type="button" title={`会话引用 ${row.id}`} aria-label="复制会话引用"
            onClick={() => { void navigator.clipboard?.writeText(row.id).catch(() => undefined); }}
            className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-[11px]">
            <CopyIcon className="size-3" aria-hidden />复制会话引用
          </button>
        </div>
        {current ? (
          <p className="text-muted-foreground shrink-0 text-xs">本次登录；注销其他会话不影响它。</p>
        ) : (
          <Button type="button" size="sm" variant="destructive" disabled={disabled || pending} onClick={onRevoke} className="shrink-0">
            <LogOutIcon />
            <span>注销该会话</span>
          </Button>
        )}
      </div>
    </div>
  );
}
