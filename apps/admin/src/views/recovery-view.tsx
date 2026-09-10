import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import {
  adminRequest,
  friendlyError,
  formatDate,
  makeRecoveryCredential,
  type SessionSnapshot,
  type RecoveryResponse,
  type PendingRecovery,
} from "../api";

type RecoveryViewProps = {
  snapshot?: Extract<SessionSnapshot, { authenticated: true }>;
  initialMessage?: string;
  onBack?: () => void;
  onCompleted?: () => void;
};

export function RecoveryView({
  snapshot,
  initialMessage,
  onBack,
  onCompleted,
}: RecoveryViewProps) {
  const [username, setUsername] = useState(snapshot?.user.username ?? "");
  const [requestPassword, setRequestPassword] = useState("");
  const [requestTarget, setRequestTarget] = useState<{ username?: string; name?: string }>();
  const [credential, setCredential] = useState("");
  const [completeCredential, setCompleteCredential] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pendingRequests, setPendingRequests] = useState<PendingRecovery[]>([]);
  const [message, setMessage] = useState<string | undefined>(initialMessage);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const isStandalone = Boolean(onBack);

  const loadPending = useCallback(async () => {
    if (!snapshot?.security.isBoss) {
      setPendingRequests([]);
      return;
    }
    try {
      const result = await adminRequest<{ requests?: PendingRecovery[] }>(
        "/security/recovery/pending"
      );
      setPendingRequests(result.requests ?? []);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  }, [snapshot?.security.isBoss]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (initialMessage) setMessage(initialMessage);
  }, [initialMessage]);

  const handleRequestRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const nextCredential = makeRecoveryCredential();
      const result = await adminRequest<RecoveryResponse>(
        "/security/recovery/request",
        {
          username: username.trim(),
          password: requestPassword,
          targetRecoveryCredential: nextCredential,
        }
      );
      setRequestTarget(result.target);
      setCredential(nextCredential);
      setCompleteCredential(nextCredential);
      setRequestPassword("");
      setMessage("恢复请求已建立。凭据仅在当前页面内存中保留；若页面刷新或重载，请重新申请。");
      await loadPending();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmRecovery = async (recoveryRequestId: string) => {
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/recovery/confirm", { recoveryRequestId });
      setMessage("恢复请求已由同级管理员确认，目标本人现在可完成恢复。");
      await loadPending();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/recovery/complete", {
        targetRecoveryCredential: completeCredential,
        newPassword,
      });
      setCredential("");
      setCompleteCredential("");
      setNewPassword("");
      setMessage("账号恢复已完成！旧会话及原二次验证均已撤销。请返回登录并重新绑定验证器。");
      onCompleted?.();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icons.ArrowLeft size={14} />
            <span>返回登录</span>
          </button>
        )}
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          管理员账号恢复
        </h2>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          {isStandalone
            ? "无需有效会话。本人使用已知管理员账号及当前密码发起恢复；协助管理员在工作台列表确认后，提交新密码完成恢复。"
            : "本人发起恢复请求，协助管理员在工作台确认后，提交凭据与新密码完成恢复。"}
        </p>
      </div>

      <div className="space-y-6">
        {/* Subflow 1: Self Initiate */}
        <div className="p-4 rounded-lg border border-border bg-surface-raised/40 space-y-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">1. 本人申请恢复</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              验证当前密码以证明身份，生成一次性内存凭据。
            </p>
          </div>

          <form onSubmit={handleRequestRecovery} className="space-y-3" noValidate>
            <div className="space-y-1">
              <label
                htmlFor="rec-username"
                className="block text-xs font-medium text-foreground"
              >
                管理员账号 (ZZ 编号)
              </label>
              <input
                id="rec-username"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ZZ00001"
                className="w-full h-9 px-3 rounded border border-border bg-surface text-foreground text-xs"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="rec-password"
                className="block text-xs font-medium text-foreground"
              >
                当前管理员密码
              </label>
              <PasswordInput
                id="rec-password"
                autoComplete="current-password"
                required
                minLength={12}
                value={requestPassword}
                onChange={(e) => setRequestPassword(e.target.value)}
                placeholder="输入当前密码"
                className="h-9 px-3 rounded border border-border bg-surface text-foreground text-xs"
              />
            </div>

            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={loading}
              disabled={!username.trim() || !requestPassword}
              className="w-full"
            >
              建立恢复请求
            </Button>
          </form>

          {requestTarget && credential && (
            <div className="p-3 rounded bg-surface border border-emerald-500/30 text-xs space-y-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>目标账号</span>
                <span className="font-mono font-semibold text-foreground">
                  {requestTarget.username ?? username.trim().toUpperCase()}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">
                  一次性恢复凭据（仅当前页面内存有效）
                </span>
                <code className="block p-2 rounded bg-surface-raised font-mono text-xs text-foreground select-all break-all border border-border">
                  {credential}
                </code>
              </div>
            </div>
          )}
        </div>

        {/* Subflow 2: Boss Confirm (if authenticated boss) */}
        {snapshot?.security.isBoss && (
          <div className="p-4 rounded-lg border border-border bg-surface-raised/40 space-y-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">2. 同级协助确认</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                列表仅展示账号与申请时间，协助者无法查看目标凭据。
              </p>
            </div>

            {pendingRequests.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 text-center">
                暂无待确认的恢复请求。
              </p>
            ) : (
              <ul className="space-y-2">
                {pendingRequests.map((item) => (
                  <li
                    key={item.id}
                    className="p-3 rounded border border-border bg-surface flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <strong className="block font-medium text-foreground">
                        {item.name} · {item.username}
                      </strong>
                      <span className="text-[11px] text-muted-foreground">
                        有效至：{formatDate(item.expiresAt)}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={loading}
                      onClick={() => void handleConfirmRecovery(item.id)}
                    >
                      确认此请求
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Subflow 3: Self Complete Recovery */}
        <div className="p-4 rounded-lg border border-border bg-surface-raised/40 space-y-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">3. 本人完成恢复</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              确认通过后，提交凭据并设置新管理密码。
            </p>
          </div>

          <form onSubmit={handleCompleteRecovery} className="space-y-3" noValidate>
            <div className="space-y-1">
              <label
                htmlFor="complete-cred"
                className="block text-xs font-medium text-foreground"
              >
                本人恢复凭据
              </label>
              <input
                id="complete-cred"
                autoComplete="off"
                required
                value={completeCredential}
                onChange={(e) => setCompleteCredential(e.target.value)}
                placeholder="粘贴第一步生成的一次性凭据"
                className="w-full h-9 px-3 rounded border border-border bg-surface text-foreground font-mono text-xs"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="new-admin-pw"
                className="block text-xs font-medium text-foreground"
              >
                新管理员密码
              </label>
              <PasswordInput
                id="new-admin-pw"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 12 位字符"
                className="h-9 px-3 rounded border border-border bg-surface text-foreground text-xs"
              />
            </div>

            <Button
              type="submit"
              size="sm"
              loading={loading}
              disabled={!completeCredential.trim() || newPassword.length < 12}
              className="w-full"
            >
              完成恢复并重置
            </Button>
          </form>
        </div>
      </div>

      <StatusMessage error={error} success={message} />

      {onBack && (
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          className="w-full text-xs"
        >
          {message?.startsWith("账号恢复已完成")
            ? "返回登录并重新绑定验证器"
            : "返回登录界面"}
        </Button>
      )}
    </div>
  );
}
