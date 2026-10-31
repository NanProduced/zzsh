import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui-elements";
import { Icons } from "../../components/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  backupCodesResultSubset,
  createLocalPendingStore,
  dismissedPendingRecords,
  normalizeIdleMinutes,
  patchPendingRecord,
  removePendingRecord,
  unresolvedGate,
  upsertPendingRecord,
  visiblePendingRecords,
  IDLE_CHOICES,
  type AccountStatus,
  type BackupCodesEnvelope,
  type BackupCodesReceipt,
  type OperationReadResult,
  type PendingRecord,
  type PendingStore,
  type PendingStoreUpdateResult,
  type SecurityCommandError,
  type SecurityCommands,
  type SecurityFactsInput,
} from "./model";
import {
  BackupCodesDialog,
  PasswordChangeDialog,
  PinChangeDialog,
  type SecurityCommandHandlers,
} from "./command-dialogs";
import { OperationResultDialog, PendingRecordsBlock, type ResolvedRefresh } from "./operation-dialog";

const defaultPendingStore = createLocalPendingStore();

export type SecuritySelfViewProps = {
  adminUserId: string;
  accountLabel: string;
  accountStatus: AccountStatus;
  twoFactorEnabled: boolean | null;
  session: { id: string; locked: boolean; pinConfigured: boolean };
  idleMinutes: number;
  compact?: boolean;
  commands: SecurityCommands;
  commandsUnavailableReason?: string;
  refreshSession: () => Promise<SecurityFactsInput | null>;
  onIdleMinutesChange: (value: number) => void;
  onLockSession: () => void;
  onOpenRecovery: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  store?: PendingStore;
};

function SecurityGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      <div className="divide-border bg-surface-raised/40 divide-y rounded-xl border border-border">{children}</div>
    </section>
  );
}

function SecurityRow({
  title,
  status,
  description,
  action,
}: {
  title: string;
  status?: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 max-w-xl">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {status ? (
            <span className="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted-foreground">
              {status}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const tone =
    status === "ACTIVE"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "FROZEN"
        ? "border-rose-500/30 bg-rose-500/10 text-rose-500 dark:text-rose-400"
        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  const label = status === "ACTIVE" ? "账号状态：正常" : status === "FROZEN" ? "账号状态：已冻结" : "账号状态：待完成绑定";
  return (
    <span className={`inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1 text-xs font-medium ${tone}`}>
      <Icons.ShieldCheck size={14} />
      {label}
    </span>
  );
}

export function SecuritySelfView({
  adminUserId,
  accountLabel,
  accountStatus,
  twoFactorEnabled,
  session,
  idleMinutes,
  compact = false,
  commands,
  commandsUnavailableReason,
  refreshSession,
  onIdleMinutesChange,
  onLockSession,
  onOpenRecovery,
  onDirtyChange,
  store,
}: SecuritySelfViewProps) {
  const storeRef = useRef<PendingStore>(store ?? defaultPendingStore);
  storeRef.current = store ?? defaultPendingStore;

  const initialReadRef = useRef<{ records: PendingRecord[]; error: boolean } | null>(null);
  if (initialReadRef.current === null) initialReadRef.current = storeRef.current.read();

  const [facts, setFacts] = useState<SecurityFactsInput>({ accountStatus, twoFactorEnabled, session });
  const [records, setRecords] = useState<PendingRecord[]>(initialReadRef.current.records);
  const [storeReadFailed, setStoreReadFailed] = useState(initialReadRef.current.error);
  const [storeWriteFailed, setStoreWriteFailed] = useState(false);
  const [dirtyParts, setDirtyParts] = useState({ password: false, pin: false, backup: false });

  const recordsRef = useRef(records);
  recordsRef.current = records;

  const identityKey = `${adminUserId}|${session.id}|${session.locked ? "locked" : "unlocked"}|${accountStatus}`;
  // 弹窗状态与 epoch 都与“它属于哪个身份/session/锁态”绑定：身份切换时在本次渲染内派生为关闭并递增 epoch，
  // 既避免“挂载即打开、随后立刻关闭”的僵尸浮层，也保证旧命令回调无法改写新身份事实。
  const [dialogSession, setDialogSession] = useState<{
    key: string;
    epoch: number;
    dialog: "password" | "pin" | "backup" | null;
    lookup: string | null;
  }>({ key: identityKey, epoch: 0, dialog: null, lookup: null });
  if (dialogSession.key !== identityKey) {
    setDialogSession({ key: identityKey, epoch: dialogSession.epoch + 1, dialog: null, lookup: null });
    setDirtyParts({ password: false, pin: false, backup: false });
  }
  const identityEpoch = dialogSession.key === identityKey ? dialogSession.epoch : dialogSession.epoch + 1;
  const epochRef = useRef(identityEpoch);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  epochRef.current = identityEpoch;
  const activeDialog = dialogSession.key === identityKey ? dialogSession.dialog : null;
  const activeLookupCommandId = dialogSession.key === identityKey ? dialogSession.lookup : null;

  useEffect(() => {
    setFacts({ accountStatus, twoFactorEnabled, session });
  }, [accountStatus, twoFactorEnabled, session.id, session.locked, session.pinConfigured]);

  const dirty = dirtyParts.password || dirtyParts.pin || dirtyParts.backup;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const commit = useCallback((mutate: (current: readonly PendingRecord[]) => PendingRecord[] | null): boolean => {
    const result = storeRef.current.update(mutate);
    if (!result.ok) {
      setStoreWriteFailed(true);
      return false;
    }
    setRecords(result.records);
    setStoreWriteFailed(false);
    setStoreReadFailed(false);
    return true;
  }, []);

  const removeRecord = useCallback(
    (commandId: string) => {
      commit((current) => removePendingRecord(current, adminUserId, commandId));
    },
    [adminUserId, commit],
  );

  const applyFacts = useCallback((refreshed: SecurityFactsInput) => {
    setFacts(refreshed);
  }, []);

  const handlers: SecurityCommandHandlers = {
    beginIntent: (record, acknowledgedFingerprint) => {
      if (!mountedRef.current || commandsUnavailableReason) return { kind: "storage" };
      const latest = storeRef.current.read();
      if (latest.error) {
        setStoreReadFailed(true);
        return { kind: "storage" };
      }
      const gateOf = (rows: readonly PendingRecord[]) => unresolvedGate(rows, record.adminUserId, record.action);
      const firstGate = gateOf(latest.records);
      if (firstGate && acknowledgedFingerprint !== firstGate.fingerprint) {
        setRecords(latest.records);
        return { kind: "gate", notice: firstGate.notice, fingerprint: firstGate.fingerprint };
      }
      const write = (): PendingStoreUpdateResult =>
        storeRef.current.update((current) => {
          const currentGate = gateOf(current);
          if (currentGate && acknowledgedFingerprint !== currentGate.fingerprint) return null;
          return upsertPendingRecord(current, record);
        });
      let result = write();
      if (!result.ok && result.reason === "refused") {
        // 读取与写入之间未决集合变化：按最新权威集合重新给出告知；集合已清空则重试一次写入。
        const again = storeRef.current.read();
        if (again.error) {
          setStoreReadFailed(true);
          return { kind: "storage" };
        }
        const freshGate = gateOf(again.records);
        if (freshGate) {
          setRecords(again.records);
          return { kind: "gate", notice: freshGate.notice, fingerprint: freshGate.fingerprint };
        }
        result = write();
      }
      if (!result.ok) {
        setStoreWriteFailed(true);
        return { kind: "storage" };
      }
      setRecords(result.records);
      setStoreWriteFailed(false);
      setStoreReadFailed(false);
      return { kind: "ok" };
    },
    markDispatched: (origin, commandId) => {
      if (!mountedRef.current || origin.epoch !== epochRef.current) return;
      commit((current) => patchPendingRecord(current, origin.adminUserId, commandId, { dispatched: true }));
    },
    succeeded: async (origin, commandId, action, envelope) => {
      // 命令发出后身份/session/锁态已变化：不得启动旧刷新、不得改写当前事实或一次性数据。
      if (!mountedRef.current || origin.epoch !== epochRef.current) return undefined;
      if (action === "backup-codes.generate") {
        const receipt = (envelope as BackupCodesEnvelope | undefined)?.receipt;
        const subset = backupCodesResultSubset(receipt);
        // 仅结算本命令；不凭“同动作不同 key”删除其他备份码记录（响应顺序≠服务端代次）。
        commit((current) =>
          patchPendingRecord(current, origin.adminUserId, commandId, {
            outcome: "completed",
            delivered: false,
            dispatched: true,
            ...(subset ? { result: subset } : {}),
          }),
        );
        return undefined;
      }
      commit((current) => removePendingRecord(current, origin.adminUserId, commandId));
      const epoch = epochRef.current;
      const refreshed = await refreshSession().catch(() => null);
      if (!mountedRef.current || epochRef.current !== epoch) return undefined;
      if (refreshed) {
        applyFacts(refreshed);
        return undefined;
      }
      return action === "password.change"
        ? "密码已更新，但会话状态刷新失败；请重新登录后再管理会话相关项。"
        : "PIN 状态刷新失败；请刷新页面确认当前状态。";
    },
    rejected: (origin, commandId, _error: SecurityCommandError) => {
      if (!mountedRef.current || origin.epoch !== epochRef.current) return "kept";
      const record = recordsRef.current.find((item) => item.adminUserId === origin.adminUserId && item.commandId === commandId);
      if (record && (record.dispatched === true || record.outcome !== "unknown")) {
        // 原请求已进入未知态：之后的授权失败不能证明原请求失败，保留原 key/身份/作用对象/首次时间。
        return "kept";
      }
      commit((current) => removePendingRecord(current, origin.adminUserId, commandId));
      return "retired";
    },
    codesConfirmed: (origin, commandId) => {
      if (!mountedRef.current || origin.epoch !== epochRef.current) return;
      commit((current) => patchPendingRecord(current, origin.adminUserId, commandId, { delivered: true }));
    },
    openLookup: (origin, commandId) => {
      if (!mountedRef.current || origin.epoch !== epochRef.current || !commandId) return;
      setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: null, lookup: commandId });
    },
  };

  const refreshCurrent = useCallback(async (): Promise<boolean> => {
    const epoch = epochRef.current;
    const refreshed = await refreshSession().catch(() => null);
    if (!mountedRef.current || epochRef.current !== epoch) return false;
    if (!refreshed) return false;
    applyFacts(refreshed);
    return true;
  }, [refreshSession, applyFacts]);

  const resolveRecord = useCallback(
    async (result: OperationReadResult): Promise<ResolvedRefresh> => {
      const epoch = epochRef.current;
      const record = recordsRef.current.find((item) => item.adminUserId === adminUserId && item.commandId === result.commandId);
      if (!record) return { refresh: "skipped" };
      if (result.status === "rejected") {
        removeRecord(result.commandId);
        return { refresh: "skipped" };
      }
      if (result.status === "completed" && result.action === "backup-codes.generate") {
        const subset = backupCodesResultSubset(result.result as BackupCodesReceipt | undefined);
        commit((current) =>
          patchPendingRecord(current, adminUserId, result.commandId, {
            outcome: "completed",
            delivered: record.delivered ?? false,
            ...(subset ? { result: subset } : {}),
          }),
        );
        return { refresh: "skipped" };
      }
      if (result.status === "completed") {
        removeRecord(result.commandId);
        const refreshed = await refreshSession().catch(() => null);
        if (!mountedRef.current || epochRef.current !== epoch) return { refresh: "skipped" };
        if (!refreshed) return { refresh: "failed" };
        applyFacts(refreshed);
        return { refresh: "ok" };
      }
      const outcome = result.status === "unconfirmed" ? "unconfirmed" : "expired";
      commit((current) => patchPendingRecord(current, adminUserId, result.commandId, { outcome }));
      return { refresh: "skipped" };
    },
    [adminUserId, commit, removeRecord, refreshSession, applyFacts],
  );

  const dismissRecord = useCallback(
    (commandId: string) => {
      commit((current) => patchPendingRecord(current, adminUserId, commandId, { dismissed: true }));
    },
    [adminUserId, commit],
  );
  const undismissRecord = useCallback(
    (commandId: string) => {
      commit((current) => patchPendingRecord(current, adminUserId, commandId, { dismissed: false }));
    },
    [adminUserId, commit],
  );

  const handlePasswordDirty = useCallback((value: boolean) => setDirtyParts((prev) => (prev.password === value ? prev : { ...prev, password: value })), []);
  const handlePinDirty = useCallback((value: boolean) => setDirtyParts((prev) => (prev.pin === value ? prev : { ...prev, pin: value })), []);
  const handleBackupDirty = useCallback((value: boolean) => setDirtyParts((prev) => (prev.backup === value ? prev : { ...prev, backup: value })), []);

  const frozen = facts.accountStatus === "FROZEN";
  const locked = facts.session.locked;
  const securityDisabled = frozen || locked;
  const twoFactorReady = facts.twoFactorEnabled === true;
  const pending = visiblePendingRecords(records, adminUserId);
  const hidden = dismissedPendingRecords(records, adminUserId);
  const storeWarning = [
    storeReadFailed
      ? "无法读取本机安全操作记录（存储受限或内容无法辨认）；未核对的操作可能不在此显示，并且在存储恢复前无法提交新的安全操作。"
      : "",
    storeWriteFailed ? "本机安全操作记录写入或回读校验失败；在存储恢复前无法提交新的安全操作。" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-muted-foreground mb-1 font-mono text-[11px] tracking-wider uppercase">设置 · 安全</div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">账号安全</h1>
          <p className="text-muted-foreground mt-1 text-sm">管理本人的登录密码、身份验证器、会话锁定与应急恢复入口。</p>
          <p className="text-muted-foreground mt-0.5 text-xs">当前管理员：{accountLabel}</p>
        </div>
        <AccountStatusBadge status={facts.accountStatus} />
      </div>

      {frozen ? (
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-500 dark:text-rose-400">
          账号已冻结：安全操作当前不可用。请通过管理员账号恢复流程或联系维护人员处理。
        </p>
      ) : null}

      <PendingRecordsBlock
        records={pending}
        dismissed={hidden}
        storeWarning={storeWarning || undefined}
        currentSessionId={facts.session.id}
        onLookup={(commandId) => setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: null, lookup: commandId })}
        onDismiss={dismissRecord}
        onUndismiss={undismissRecord}
      />

      <SecurityGroup title="登录凭据" description="用于登录与验证本人身份的凭据；修改即时作用于整账号。">
        <SecurityRow
          title="登录密码"
          description="用于登录与高风险操作的再认证。修改后其他设备的旧会话全部撤销；服务端为新会话换发登录态，原快捷 PIN 需要重新设置。"
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={securityDisabled}
              onClick={() => setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: "password", lookup: null })}
            >
              修改密码
            </Button>
          }
        />
        <SecurityRow
          title="身份验证器 (TOTP)"
          status={facts.twoFactorEnabled === true ? "已启用" : facts.twoFactorEnabled === false ? "未启用" : "未提供"}
          description="动态六位验证码；登录与关键安全操作时强制验证。管理端不提供关闭入口。"
        />
        <SecurityRow
          title="备用恢复码"
          description={`验证器不可用时的应急登录手段。重新生成会立即作废旧码，新码只显示一次；当前是否仍有可用备份码无法在此确认。${twoFactorReady ? "" : " 需先启用身份验证器。"}`}
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={securityDisabled || !twoFactorReady}
              onClick={() => setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: "backup", lookup: null })}
            >
              重新生成备份码
            </Button>
          }
        />
      </SecurityGroup>

      <SecurityGroup title="会话保护" description="作用于当前会话（当前浏览器），不影响其他设备会话。">
        {compact ? (
          <div className="p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              小屏终端不提供快捷 PIN 与立即锁定入口；已锁会话需通过完整重新认证（密码＋验证器）恢复访问，隐藏界面或缩小窗口不能绕过服务端锁态。
            </p>
          </div>
        ) : (
          <>
            <SecurityRow
              title="会话快捷 PIN"
              status={facts.session.pinConfigured ? "已配置" : "未配置"}
              description={`离开座位时快速锁定当前会话（6 位数字，仅当前会话，不是跨设备全局 PIN）。更改 PIN 需要当前 PIN；忘记 PIN 时通过完整重新认证解锁并重设。${twoFactorReady ? "" : " 需先启用身份验证器。"}`}
              action={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={securityDisabled || !twoFactorReady}
                  onClick={() => setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: "pin", lookup: null })}
                >
                  {facts.session.pinConfigured ? "更改 PIN" : "设置 PIN"}
                </Button>
              }
            />
            <SecurityRow
              title="立即锁定当前会话"
              description={
                facts.session.pinConfigured
                  ? "锁定后受保护操作需要输入快捷 PIN 或完成完整重新认证；不退出登录，也不影响其他设备会话。"
                  : "尚未配置 PIN。请先设置 6 位 PIN；锁定是服务端动作，刷新或缩小窗口不能绕过。"
              }
              action={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!facts.session.pinConfigured || locked || frozen || Boolean(commandsUnavailableReason)}
                  onClick={onLockSession}
                >
                  <Icons.Lock size={14} />
                  <span>立即锁定当前会话</span>
                </Button>
              }
            />
          </>
        )}
        <SecurityRow
          title="闲置自动锁定"
          description="无操作达到所选时长后，服务端锁定当前会话。偏好仅保存在当前浏览器；其他设备会话不受影响。"
          action={
            <div className="relative">
              <Select
                value={String(normalizeIdleMinutes(idleMinutes))}
                onValueChange={(val) => val && onIdleMinutesChange(Number(val))}
                items={IDLE_CHOICES.map((minutes) => ({ value: String(minutes), label: `${minutes} 分钟` }))}
              >
                <SelectTrigger aria-label="当前浏览器闲置锁定时长" className="h-8 text-xs min-w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IDLE_CHOICES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {minutes} 分钟
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
      </SecurityGroup>

      <SecurityGroup title="无法登录时" description="当验证器不可用时的受控恢复路径。">
        <SecurityRow
          title="管理员账号恢复"
          description="丢失身份验证器（仍记得登录密码）时：本人用当前密码发起申请，另一名有权限的管理员线下核验后协助确认，再由本人设置新密码并重新绑定验证器。当前合同要求以本人当前密码发起申请；若密码与验证器同时不可用，请联系维护人员处理。恢复由独立入口完成，本页不承载恢复表单。"
          action={
            <Button type="button" variant="secondary" size="sm" onClick={onOpenRecovery} disabled={Boolean(commandsUnavailableReason)}>
              <Icons.ArrowRight size={14} />
              <span>进入账号恢复</span>
            </Button>
          }
        />
      </SecurityGroup>

      <Fragment key={identityKey}>
        <PasswordChangeDialog
          unavailableReason={commandsUnavailableReason}
          open={activeDialog === "password"}
          locked={facts.session.locked}
          adminUserId={adminUserId}
          sessionId={facts.session.id}
          epoch={identityEpoch}
          unresolvedNotice={unresolvedGate(records, adminUserId, "password.change")?.notice}
          handlers={handlers}
          onClose={() => setDialogSession((prev) => ({ ...prev, dialog: null }))}
          onDirtyChange={handlePasswordDirty}
          submit={commands.changePassword}
        />
        <PinChangeDialog
          unavailableReason={commandsUnavailableReason}
          open={activeDialog === "pin"}
          locked={facts.session.locked}
          mode={facts.session.pinConfigured ? "change" : "set"}
          adminUserId={adminUserId}
          sessionId={facts.session.id}
          epoch={identityEpoch}
          unresolvedNotice={unresolvedGate(records, adminUserId, facts.session.pinConfigured ? "pin.change" : "pin.set")?.notice}
          handlers={handlers}
          onClose={() => setDialogSession((prev) => ({ ...prev, dialog: null }))}
          onDirtyChange={handlePinDirty}
          setPin={commands.setPin}
          changePin={commands.changePin}
        />
        <BackupCodesDialog
          unavailableReason={commandsUnavailableReason}
          open={activeDialog === "backup"}
          locked={facts.session.locked}
          adminUserId={adminUserId}
          sessionId={facts.session.id}
          epoch={identityEpoch}
          unresolvedNotice={unresolvedGate(records, adminUserId, "backup-codes.generate")?.notice}
          handlers={handlers}
          onClose={() => setDialogSession((prev) => ({ ...prev, dialog: null }))}
          onDirtyChange={handleBackupDirty}
          generateBackupCodes={commands.generateBackupCodes}
        />
        <OperationResultDialog
          open={activeLookupCommandId !== null}
          commandId={activeLookupCommandId ?? undefined}
          record={
            activeLookupCommandId
              ? records.find((item) => item.adminUserId === adminUserId && item.commandId === activeLookupCommandId)
              : undefined
          }
          currentSessionId={facts.session.id}
          read={commands.readOperation}
          onClose={() => setDialogSession((prev) => ({ ...prev, lookup: null }))}
          onResolved={resolveRecord}
          refreshCurrent={refreshCurrent}
          onDismissRecord={dismissRecord}
          onRegenerateBackupCodes={() => {
            setDialogSession({ key: identityKey, epoch: identityEpoch, dialog: "backup", lookup: null });
          }}
        />
      </Fragment>
    </div>
  );
}
