import { useEffect, useRef, useState, type ReactNode } from "react";
import { TriangleAlert, XIcon } from "lucide-react";

import { Button, PasswordInput, StatusMessage } from "../../components/ui-elements";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Icons } from "../../components/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  asCommandError,
  backupCodesReceiptLines,
  buildPendingRecord,
  describeCommandError,
  isUnknownOutcome,
  makeSecurityCommandId,
  passwordSuccessLines,
  validateBackupPassword,
  validatePasswordChange,
  validatePin,
  verifyCommandSuccess,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PendingRecord,
  type SecurityAction,
  type SecurityCommandError,
  type SecurityCommands,
  type UnresolvedGate,
} from "./model";

/** 命令发出时绑定的身份/会话/epoch；父级回调前必须用 origin.epoch 复核。 */
export type CommandOrigin = { adminUserId: string; sessionId: string; epoch: number };

export type IntentStart =
  | { kind: "ok" }
  | { kind: "storage" }
  | { kind: "gate"; notice: string; fingerprint: string };

export type SecurityCommandHandlers = {
  /** 提交前按最新权威记录写入非敏感待核记录；未核清集合需与已确认指纹一致，否则返回 gate。 */
  beginIntent: (record: PendingRecord, acknowledgedFingerprint: string | null) => IntentStart;
  /** 结果未知（网络/5xx/矛盾响应）后标记已发出，供后续区分授权失败与原拒绝。 */
  markDispatched: (origin: CommandOrigin, commandId: string) => void;
  /** 明确成功后收口；返回需要在成功面板展示的补充提示（如快照刷新失败）。 */
  succeeded: (origin: CommandOrigin, commandId: string, action: SecurityAction, envelope: unknown) => Promise<string | undefined>;
  /** 明确拒绝：仅在原命令尚未进入未知态时收口为 retired；否则 kept（保留原责任）。 */
  rejected: (origin: CommandOrigin, commandId: string, error: SecurityCommandError) => "retired" | "kept";
  /** 用户确认已妥善保存一次性备份码。 */
  codesConfirmed: (origin: CommandOrigin, commandId: string) => void;
  /** 打开原结果核对弹窗。 */
  openLookup: (origin: CommandOrigin, commandId: string) => void;
};

type BaseProps = {
  open: boolean;
  locked: boolean;
  unavailableReason?: string;
  adminUserId: string;
  sessionId: string;
  /** 父级身份/会话/锁态 epoch；发出命令时绑定，响应回调由父级复核。 */
  epoch: number;
  unresolvedNotice?: string;
  handlers: SecurityCommandHandlers;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
};

type DiscardCopy = { title: string; body: string; keepLabel: string; discardLabel: string };

/** 弹窗关闭后清理内存中的秘密输入与临时状态；秘密绝不留在已关闭的组件里。 */
function useClosedReset(open: boolean, reset: () => void): void {
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (!open) resetRef.current();
  }, [open]);
}

function GuardedDialog({
  open,
  title,
  description,
  busy,
  needsConfirm,
  discardCopy,
  confirming,
  setConfirming,
  keepContentVisible = false,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  busy: boolean;
  needsConfirm: boolean;
  discardCopy: DiscardCopy;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  keepContentVisible?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (busy) {
          details.cancel();
          return;
        }
        if (confirming) {
          setConfirming(false);
          details.cancel();
          return;
        }
        if (needsConfirm) {
          setConfirming(true);
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <button
          type="button"
          aria-label="关闭"
          className="absolute top-2.5 right-2.5 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (busy) return;
            if (needsConfirm) {
              setConfirming(true);
              return;
            }
            onClose();
          }}
        >
          <XIcon className="size-4" />
        </button>
        {confirming ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{discardCopy.title}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{discardCopy.body}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                {discardCopy.keepLabel}
              </Button>
              <Button type="button" variant="danger" size="sm" onClick={onClose}>
                {discardCopy.discardLabel}
              </Button>
            </div>
          </div>
        ) : null}
        {!confirming || keepContentVisible ? children : null}
      </DialogContent>
    </Dialog>
  );
}

function UnknownPanel({
  children,
  origin,
  commandId,
  handlers,
  onClose,
}: {
  children: ReactNode;
  origin: CommandOrigin;
  commandId: string;
  handlers: SecurityCommandHandlers;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <Alert variant="warning" role="status">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>提交后未收到明确结果</AlertTitle>
        <AlertDescription>{children}</AlertDescription>
        <AlertAction>
          <Button type="button" size="sm" variant="secondary" onClick={() => handlers.openLookup(origin, commandId)}>
            <Icons.AlertCircle size={14} />
            <span>核对原结果</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            <span>关闭窗口</span>
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

function GatePanel({
  notice,
  acknowledged,
  onAcknowledge,
}: {
  notice: string;
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <Alert variant="warning" role="status">
      <TriangleAlert aria-hidden="true" />
      <AlertDescription>{notice}</AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={acknowledged}
          onClick={onAcknowledge}
          disabled={acknowledged}
        >
          {acknowledged ? "已确认：将发起新的独立操作" : "我了解，仍要发起一次新的独立操作"}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function PassiveNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return <Alert variant="warning" role="status"><TriangleAlert aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert>;
}

function FieldError({ children }: { children?: string }) {
  if (!children) return null;
  return <p className="text-xs text-rose-500 dark:text-rose-400">{children}</p>;
}

const STORAGE_BLOCKED_COPY = "无法在本机安全记录中保存本次命令标识；为避免结果丢失，本次未提交。请检查浏览器存储限制后重试。";

export function PasswordChangeDialog({
  open,
  locked,
  unavailableReason,
  adminUserId,
  sessionId,
  epoch,
  unresolvedNotice,
  handlers,
  onClose,
  onDirtyChange,
  submit,
}: BaseProps & { submit: SecurityCommands["changePassword"] }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"currentPassword" | "newPassword" | "confirmPassword", string>>>({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"editing" | "unknown" | "success">("editing");
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState<string>();
  const [unverifiedNote, setUnverifiedNote] = useState<string>();
  const [successLines, setSuccessLines] = useState<string[]>([]);
  const [successNote, setSuccessNote] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [gate, setGate] = useState<UnresolvedGate | null>(null);
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const [activeCommandId, setActiveCommandId] = useState("");
  const [activeOrigin, setActiveOrigin] = useState<CommandOrigin | null>(null);
  const commandIdRef = useRef<string | null>(null);

  const clearSecrets = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };
  const dirty = phase === "editing" && (currentPassword.length > 0 || newPassword.length > 0 || confirmPassword.length > 0);
  useClosedReset(open, () => {
    clearSecrets();
    setErrors({});
    setError(undefined);
    setBlocked(undefined);
    setUnverifiedNote(undefined);
    setSuccessLines([]);
    setSuccessNote(undefined);
    setPhase("editing");
    setConfirming(false);
    setGate(null);
    setAcknowledgedFingerprint(null);
    setActiveCommandId("");
    setActiveOrigin(null);
    commandIdRef.current = null;
  });
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const action: SecurityAction = "password.change";
  const runSubmit = async () => {
    if (busy || locked || unavailableReason) return;
    const nextErrors = validatePasswordChange({ currentPassword, newPassword, confirmPassword });
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setError(undefined);
    const commandId = commandIdRef.current ?? makeSecurityCommandId();
    commandIdRef.current = commandId;
    const intent = handlers.beginIntent(buildPendingRecord({ adminUserId, action, commandId, sessionId }), acknowledgedFingerprint);
    if (intent.kind === "storage") {
      setBlocked(STORAGE_BLOCKED_COPY);
      return;
    }
    if (intent.kind === "gate") {
      setGate({ notice: intent.notice, fingerprint: intent.fingerprint });
      setAcknowledgedFingerprint(null);
      return;
    }
    setBlocked(undefined);
    setGate(null);
    const origin: CommandOrigin = { adminUserId, sessionId, epoch };
    setActiveCommandId(commandId);
    setActiveOrigin(origin);
    setBusy(true);
    try {
      const result = await submit({ commandId, currentPassword, newPassword });
      if (!verifyCommandSuccess(action, result, commandId, { sessionId })) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        clearSecrets();
        setUnverifiedNote("服务端响应缺少必要结果或与请求不一致，无法确认本次操作是否执行。已清除输入并保留待核记录。");
        setPhase("unknown");
        return;
      }
      const note = await handlers.succeeded(origin, commandId, action, result).catch(() => undefined);
      commandIdRef.current = null;
      clearSecrets();
      setSuccessLines(passwordSuccessLines(result.receipt));
      setSuccessNote(note);
      setPhase("success");
    } catch (failure) {
      const commandError = asCommandError(failure);
      if (isUnknownOutcome(commandError)) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        clearSecrets();
        setUnverifiedNote(undefined);
        setPhase("unknown");
      } else {
        const outcome = handlers.rejected(origin, commandId, commandError);
        commandIdRef.current = null;
        const copy = describeCommandError(action, commandError);
        setError(
          outcome === "kept"
            ? `${copy} 本次失败发生在原请求结果未知之后，不能证明原请求失败；原待核记录已保留。`
            : copy,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <GuardedDialog
      open={open}
      title="修改登录密码"
      description={
        <>
          保存后服务端会<strong className="text-foreground">撤销其他设备的全部旧会话</strong>
          ，并为新会话换发登录态；原快捷 PIN 需要在新会话中重新设置。新密码 {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} 位。
        </>
      }
      busy={busy}
      needsConfirm={dirty}
      confirming={confirming}
      setConfirming={setConfirming}
      onClose={onClose}
      discardCopy={{
        title: "放弃已输入的内容？",
        body: "关闭后已输入的密码会被清除，不会提交。",
        keepLabel: "继续编辑",
        discardLabel: "放弃并关闭",
      }}
    >
      {phase === "editing" ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void runSubmit();
          }}
        >
          {gate ? (
            <GatePanel
              notice={gate.notice}
              acknowledged={acknowledgedFingerprint === gate.fingerprint}
              onAcknowledge={() => setAcknowledgedFingerprint(gate.fingerprint)}
            />
          ) : (
            <PassiveNotice notice={unresolvedNotice} />
          )}
          <div className="space-y-1">
            <label htmlFor="self-current-password" className="block text-xs font-medium text-foreground">
              当前密码
            </label>
            <PasswordInput
              id="self-current-password"
              autoComplete="current-password"
              className="h-9 rounded border border-border bg-surface-raised px-3 text-xs"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <FieldError>{errors.currentPassword}</FieldError>
          </div>
          <div className="space-y-1">
            <label htmlFor="self-new-password" className="block text-xs font-medium text-foreground">
              新密码（{PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} 位）
            </label>
            <PasswordInput
              id="self-new-password"
              autoComplete="new-password"
              className="h-9 rounded border border-border bg-surface-raised px-3 text-xs"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <FieldError>{errors.newPassword}</FieldError>
          </div>
          <div className="space-y-1">
            <label htmlFor="self-confirm-password" className="block text-xs font-medium text-foreground">
              确认新密码
            </label>
            <PasswordInput
              id="self-confirm-password"
              autoComplete="new-password"
              className="h-9 rounded border border-border bg-surface-raised px-3 text-xs"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <FieldError>{errors.confirmPassword}</FieldError>
          </div>
          <StatusMessage error={error} />
          {unavailableReason ? <p className="text-xs leading-relaxed text-muted-foreground">{unavailableReason}</p> : null}
          <StatusMessage error={blocked} />
          {locked ? <p className="text-xs text-muted-foreground">当前会话已锁定，解锁后才能修改密码。</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={busy} disabled={locked || Boolean(unavailableReason)}>
              更新登录密码
            </Button>
          </div>
        </form>
      ) : null}
      {phase === "unknown" ? (
        <UnknownPanel origin={activeOrigin ?? { adminUserId, sessionId, epoch }} commandId={activeCommandId} handlers={handlers} onClose={onClose}>
          {unverifiedNote ? <p>{unverifiedNote}</p> : null}
          <p>无法确认本次修改是否已执行。若已执行，旧密码已失效；不要再使用旧密码重复提交，也不要假定原会话仍然可用。</p>
          <p>已清除输入；待核记录已保留，请先核对原结果；如 Cookie 已失效，请重新登录后再核对。</p>
        </UnknownPanel>
      ) : null}
      {phase === "success" ? (
        <div className="space-y-3">
          <StatusMessage success={successLines.join(" ")} />
          {successNote ? <p className="text-xs text-amber-600 dark:text-amber-400">{successNote}</p> : null}
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={onClose}>
              完成
            </Button>
          </div>
        </div>
      ) : null}
    </GuardedDialog>
  );
}

export function PinChangeDialog({
  open,
  locked,
  unavailableReason,
  mode,
  adminUserId,
  sessionId,
  epoch,
  unresolvedNotice,
  handlers,
  onClose,
  onDirtyChange,
  setPin,
  changePin,
}: BaseProps & {
  mode: "set" | "change";
  setPin: SecurityCommands["setPin"];
  changePin: SecurityCommands["changePin"];
}) {
  const action: SecurityAction = mode === "set" ? "pin.set" : "pin.change";
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"currentPin" | "newPin", string>>>({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"editing" | "unknown" | "success">("editing");
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState<string>();
  const [unverifiedNote, setUnverifiedNote] = useState<string>();
  const [successNote, setSuccessNote] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [gate, setGate] = useState<UnresolvedGate | null>(null);
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const [activeCommandId, setActiveCommandId] = useState("");
  const [activeOrigin, setActiveOrigin] = useState<CommandOrigin | null>(null);
  const commandIdRef = useRef<string | null>(null);

  const clearSecrets = () => {
    setCurrentPin("");
    setNewPin("");
  };
  const dirty = phase === "editing" && (currentPin.length > 0 || newPin.length > 0);
  useClosedReset(open, () => {
    clearSecrets();
    setErrors({});
    setError(undefined);
    setBlocked(undefined);
    setUnverifiedNote(undefined);
    setSuccessNote(undefined);
    setPhase("editing");
    setConfirming(false);
    setGate(null);
    setAcknowledgedFingerprint(null);
    setActiveCommandId("");
    setActiveOrigin(null);
    commandIdRef.current = null;
  });
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const runSubmit = async () => {
    if (busy || locked || unavailableReason) return;
    const nextErrors: Partial<Record<"currentPin" | "newPin", string>> = {};
    if (mode === "change") {
      const currentError = validatePin(currentPin);
      if (currentError) nextErrors.currentPin = "请输入当前 6 位 PIN。";
    }
    const pinError = validatePin(newPin);
    if (pinError) nextErrors.newPin = pinError;
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setError(undefined);
    const commandId = commandIdRef.current ?? makeSecurityCommandId();
    commandIdRef.current = commandId;
    const intent = handlers.beginIntent(buildPendingRecord({ adminUserId, action, commandId, sessionId }), acknowledgedFingerprint);
    if (intent.kind === "storage") {
      setBlocked(STORAGE_BLOCKED_COPY);
      return;
    }
    if (intent.kind === "gate") {
      setGate({ notice: intent.notice, fingerprint: intent.fingerprint });
      setAcknowledgedFingerprint(null);
      return;
    }
    setBlocked(undefined);
    setGate(null);
    const origin: CommandOrigin = { adminUserId, sessionId, epoch };
    setActiveCommandId(commandId);
    setActiveOrigin(origin);
    setBusy(true);
    try {
      const result = mode === "set" ? await setPin({ commandId, pin: newPin }) : await changePin({ commandId, currentPin, newPin });
      if (!verifyCommandSuccess(action, result, commandId, { sessionId })) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        clearSecrets();
        setUnverifiedNote("服务端响应缺少必要结果或与请求不一致，无法确认本次操作是否执行。已清除输入并保留待核记录。");
        setPhase("unknown");
        return;
      }
      const note = await handlers.succeeded(origin, commandId, action, result).catch(() => undefined);
      commandIdRef.current = null;
      clearSecrets();
      setSuccessNote(note);
      setPhase("success");
    } catch (failure) {
      const commandError = asCommandError(failure);
      if (isUnknownOutcome(commandError)) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        clearSecrets();
        setUnverifiedNote(undefined);
        setPhase("unknown");
      } else {
        const outcome = handlers.rejected(origin, commandId, commandError);
        commandIdRef.current = null;
        const copy = describeCommandError(action, commandError);
        setError(
          outcome === "kept"
            ? `${copy} 本次失败发生在原请求结果未知之后，不能证明原请求失败；原待核记录已保留。`
            : copy,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <GuardedDialog
      open={open}
      title={mode === "set" ? "设置会话快捷 PIN" : "更改会话快捷 PIN"}
      description={
        mode === "set"
          ? "PIN 为 6 位数字，仅作用于当前会话（不是跨设备全局 PIN）。忘记 PIN 时通过完整重新认证解锁并重设。"
          : "更改 PIN 需要当前 PIN；连续错误达到上限后当前会话会被锁定，需完整重新认证解锁。"
      }
      busy={busy}
      needsConfirm={dirty}
      confirming={confirming}
      setConfirming={setConfirming}
      onClose={onClose}
      discardCopy={{
        title: "放弃已输入的 PIN？",
        body: "关闭后已输入的 PIN 会被清除，不会提交。",
        keepLabel: "继续编辑",
        discardLabel: "放弃并关闭",
      }}
    >
      {phase === "editing" ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void runSubmit();
          }}
        >
          {gate ? (
            <GatePanel
              notice={gate.notice}
              acknowledged={acknowledgedFingerprint === gate.fingerprint}
              onAcknowledge={() => setAcknowledgedFingerprint(gate.fingerprint)}
            />
          ) : (
            <PassiveNotice notice={unresolvedNotice} />
          )}
          {mode === "change" ? (
            <div className="space-y-1">
              <label htmlFor="self-current-pin" className="block text-xs font-medium text-foreground">
                当前 PIN
              </label>
              <input
                id="self-current-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="h-9 w-full rounded border border-border bg-surface-raised px-3 font-mono text-xs tracking-widest text-foreground"
              />
              <FieldError>{errors.currentPin}</FieldError>
            </div>
          ) : null}
          <div className="space-y-1">
            <label htmlFor="self-new-pin" className="block text-xs font-medium text-foreground">
              {mode === "set" ? "设置 6 位数字 PIN" : "新的 6 位 PIN"}
            </label>
            <input
              id="self-new-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={newPin}
              onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••"
              className="h-9 w-full rounded border border-border bg-surface-raised px-3 font-mono text-xs tracking-widest text-foreground"
            />
            <FieldError>{errors.newPin}</FieldError>
          </div>
          <StatusMessage error={error} />
          <StatusMessage error={blocked} />
          {mode === "change" ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              忘记当前 PIN？请勿尝试覆盖。锁定当前会话或退出登录后，使用管理员密码和验证器完成完整重新认证，并设置新的 PIN。
            </p>
          ) : null}
          {unavailableReason ? <p className="text-xs leading-relaxed text-muted-foreground">{unavailableReason}</p> : null}
          {locked ? <p className="text-xs text-muted-foreground">当前会话已锁定，解锁后才能{mode === "set" ? "设置" : "更改"} PIN。</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={busy} disabled={locked || Boolean(unavailableReason)}>
              {mode === "set" ? "设置 PIN" : "更新 PIN"}
            </Button>
          </div>
        </form>
      ) : null}
      {phase === "unknown" ? (
        <UnknownPanel origin={activeOrigin ?? { adminUserId, sessionId, epoch }} commandId={activeCommandId} handlers={handlers} onClose={onClose}>
          {unverifiedNote ? <p>{unverifiedNote}</p> : null}
          <p>
            无法确认 PIN 是否已{mode === "set" ? "设置" : "更新"}。错误 PIN 的拒绝可能已经计次；不要改用其他 PIN 反复试探，也不要不核对就重新发起。
          </p>
          <p>已清除输入；待核记录已保留，请先核对原结果。</p>
        </UnknownPanel>
      ) : null}
      {phase === "success" ? (
        <div className="space-y-3">
          <StatusMessage success={mode === "set" ? "会话 PIN 已设置（仅当前会话）。" : "会话 PIN 已更新（仅当前会话）。"} />
          {successNote ? <p className="text-xs text-amber-600 dark:text-amber-400">{successNote}</p> : null}
          <p className="text-[11px] leading-relaxed text-muted-foreground">退出登录或会话过期后，新会话需要重新设置 PIN。</p>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={onClose}>
              完成
            </Button>
          </div>
        </div>
      ) : null}
    </GuardedDialog>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function BackupCodesDialog({
  open,
  locked,
  unavailableReason,
  adminUserId,
  sessionId,
  epoch,
  unresolvedNotice,
  handlers,
  onClose,
  onDirtyChange,
  generateBackupCodes,
}: BaseProps & { generateBackupCodes: SecurityCommands["generateBackupCodes"] }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"editing" | "unknown" | "success">("editing");
  const [unverifiedNote, setUnverifiedNote] = useState<string>();
  const [codes, setCodes] = useState<string[]>([]);
  const [receiptLines, setReceiptLines] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [gate, setGate] = useState<UnresolvedGate | null>(null);
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const [activeCommandId, setActiveCommandId] = useState("");
  const [activeOrigin, setActiveOrigin] = useState<CommandOrigin | null>(null);
  const commandIdRef = useRef<string | null>(null);

  const codesPending = phase === "success" && codes.length > 0;
  const dirty = (phase === "editing" && password.length > 0) || codesPending;
  useClosedReset(open, () => {
    setPassword("");
    setError(undefined);
    setBlocked(undefined);
    setUnverifiedNote(undefined);
    setCodes([]);
    setReceiptLines([]);
    setCopyStatus(undefined);
    setPhase("editing");
    setConfirming(false);
    setGate(null);
    setAcknowledgedFingerprint(null);
    setActiveCommandId("");
    setActiveOrigin(null);
    commandIdRef.current = null;
  });
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const action: SecurityAction = "backup-codes.generate";
  const runSubmit = async () => {
    if (busy || locked || unavailableReason) return;
    const passwordError = validateBackupPassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setError(undefined);
    const commandId = commandIdRef.current ?? makeSecurityCommandId();
    commandIdRef.current = commandId;
    const intent = handlers.beginIntent(buildPendingRecord({ adminUserId, action, commandId, sessionId }), acknowledgedFingerprint);
    if (intent.kind === "storage") {
      setBlocked(STORAGE_BLOCKED_COPY);
      return;
    }
    if (intent.kind === "gate") {
      setGate({ notice: intent.notice, fingerprint: intent.fingerprint });
      setAcknowledgedFingerprint(null);
      return;
    }
    setBlocked(undefined);
    setGate(null);
    const origin: CommandOrigin = { adminUserId, sessionId, epoch };
    setActiveCommandId(commandId);
    setActiveOrigin(origin);
    setBusy(true);
    try {
      const result = await generateBackupCodes({ commandId, password });
      if (!verifyCommandSuccess(action, result, commandId)) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        setPassword("");
        setUnverifiedNote("服务端响应缺少必要结果或与请求不一致，无法确认本次操作是否执行。已清除输入并保留待核记录。");
        setPhase("unknown");
        return;
      }
      const nextCodes = result.backupCodes ?? [];
      await handlers.succeeded(origin, commandId, action, result).catch(() => undefined);
      commandIdRef.current = null;
      setPassword("");
      setCodes(nextCodes);
      setReceiptLines(backupCodesReceiptLines(result.receipt));
      setCopyStatus(undefined);
      setPhase("success");
    } catch (failure) {
      const commandError = asCommandError(failure);
      if (isUnknownOutcome(commandError)) {
        handlers.markDispatched(origin, commandId);
        commandIdRef.current = null;
        setPassword("");
        setUnverifiedNote(undefined);
        setPhase("unknown");
      } else {
        const outcome = handlers.rejected(origin, commandId, commandError);
        commandIdRef.current = null;
        const copy = describeCommandError(action, commandError);
        setError(
          outcome === "kept"
            ? `${copy} 本次失败发生在原请求结果未知之后，不能证明原请求失败；原待核记录已保留。`
            : copy,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <GuardedDialog
      open={open}
      title="重新生成备份码"
      description={
        <>
          重新生成会<strong className="text-foreground">立即作废全部旧备份码</strong>
          ；新码只在本页显示一次，关闭后无法再次查看。
        </>
      }
      busy={busy}
      needsConfirm={dirty}
      confirming={confirming}
      setConfirming={setConfirming}
      keepContentVisible={codesPending}
      onClose={onClose}
      discardCopy={
        codesPending
          ? {
              title: "新备份码尚未确认保存",
              body: "关闭后本页无法再次查看这些码；如未记录，需要重新生成并作废本批。",
              keepLabel: "继续查看",
              discardLabel: "放弃并关闭",
            }
          : {
              title: "放弃已输入的内容？",
              body: "关闭后已输入的密码会被清除，不会提交。",
              keepLabel: "继续编辑",
              discardLabel: "放弃并关闭",
            }
      }
    >
      {phase === "editing" ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void runSubmit();
          }}
        >
          {gate ? (
            <GatePanel
              notice={gate.notice}
              acknowledged={acknowledgedFingerprint === gate.fingerprint}
              onAcknowledge={() => setAcknowledgedFingerprint(gate.fingerprint)}
            />
          ) : (
            <PassiveNotice notice={unresolvedNotice} />
          )}
          <div className="space-y-1">
            <label htmlFor="self-backup-password" className="block text-xs font-medium text-foreground">
              当前登录密码（再认证）
            </label>
            <PasswordInput
              id="self-backup-password"
              autoComplete="current-password"
              className="h-9 rounded border border-border bg-surface-raised px-3 text-xs"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError>{error}</FieldError>
          </div>
          <StatusMessage error={blocked} />
          {unavailableReason ? <p className="text-xs leading-relaxed text-muted-foreground">{unavailableReason}</p> : null}
          {locked ? <p className="text-xs text-muted-foreground">当前会话已锁定，解锁后才能重新生成备份码。</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={busy} disabled={locked || Boolean(unavailableReason)}>
              生成新一批备份码
            </Button>
          </div>
        </form>
      ) : null}
      {phase === "unknown" ? (
        <UnknownPanel origin={activeOrigin ?? { adminUserId, sessionId, epoch }} commandId={activeCommandId} handlers={handlers} onClose={onClose}>
          {unverifiedNote ? <p>{unverifiedNote}</p> : null}
          <p>
            若本次已生成，<strong>上一批备份码已经失效，而新码未在本页交付</strong>。请不要假定旧码仍可用；请先核对结果，再决定是否明确发起新一轮生成。
          </p>
          <p>已清除输入；待核记录已保留。</p>
        </UnknownPanel>
      ) : null}
      {phase === "success" ? (
        <div className="space-y-3">
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            {receiptLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {codes.map((code, index) => (
              <code
                key={`${index}-${code}`}
                className="select-all rounded border border-border bg-surface-raised px-2 py-1.5 font-mono text-xs text-foreground"
              >
                {code}
              </code>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={async () => {
                const ok = await copyToClipboard(codes.join("\n"));
                setCopyStatus(ok ? "已复制全部代码。" : "复制失败，请手动选择并保存下方全部代码。");
              }}
            >
              <Icons.Copy size={14} />
              <span>复制全部</span>
            </Button>
            {copyStatus ? <p className="text-xs text-muted-foreground">{copyStatus}</p> : null}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            这些代码仅本次显示；关闭本页后无法再次查看。每枚只能使用一次，请存放在密码管理器等安全位置。
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (activeOrigin && activeCommandId) handlers.codesConfirmed(activeOrigin, activeCommandId);
                onClose();
              }}
            >
              我已妥善保存
            </Button>
          </div>
        </div>
      ) : null}
    </GuardedDialog>
  );
}
