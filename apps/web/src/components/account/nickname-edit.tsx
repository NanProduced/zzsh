"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { Pencil, X } from "lucide-react";
import { useUserSession, useUserSessionStore, publishUserSessionChange } from "@/components/session/user-session-provider";
import { authErrorMessage, webAuthRequest, WebAuthError } from "@/lib/web-auth-request";
import { FieldGroup, RecoveryAlert } from "@/components/ui/information";
import type { SecurityNicknameDraft, SecurityPendingWrite } from "./account-security-controls";

type Overview = { userId: string; nickname: string };
type NicknameIntent = { action: "nickname"; expected: string };
/**
 * 概况事实无法确认：subject=true 是共享会话主体已变化（含退出登录/identityVersion 变化），
 * subject=false 是返回合同不成立。两者都撤下旧概况事实与编辑资格，但已接受的写意图仍按原责任保留。
 */
class OverviewUnconfirmed extends Error {
  constructor(readonly subject: boolean) { super(subject ? "Security subject unconfirmed" : "Security overview unconfirmed"); }
}

/**
 * 昵称编辑从账号安全页迁到总览「编辑资料」入口（Owner 裁定）。
 * 只做 /profile/nickname 的提交与结果确认：不复制密码/换绑的 challenge·proof 状态机；
 * 沿用同一组共享意图容器（nicknameDraft/pendingWrite）与安全页一致的四条保障——
 * 身份隔离（userId 不符即清）、提交锁（writeLock + busy）、未知结果恢复（保留意图 + 重新确认）、
 * 草稿跨卸载保留。概况读取失败时不渲染编辑入口（对齐安全页 F1：失权撤下编辑入口）。
 */
export function NicknameEditEntry({
  userId,
  nicknameDraft,
  pendingWrite,
}: {
  userId: string;
  nicknameDraft?: SecurityNicknameDraft;
  pendingWrite?: SecurityPendingWrite;
}) {
  const session = useUserSession();
  const sessionStore = useUserSessionStore();
  const inheritedWrite = pendingWrite?.current?.userId === userId ? pendingWrite.current : null;
  const inheritedIntent = inheritedWrite?.intent.action === "nickname" ? inheritedWrite.intent : null;
  // F2：共享容器里同主体的其他类未决写（密码/换绑/会话撤销）不由本组件负责恢复；
  // 只呈现说明与返回恢复入口，不覆盖、不清除、不重新生成对方意图。
  const foreignWrite = pendingWrite?.current?.userId === userId && pendingWrite.current.intent.action !== "nickname" ? pendingWrite.current : null;
  const initialDraft = nicknameDraft?.current?.userId === userId ? nicknameDraft.current.value : null;

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialDraft ?? "");
  // 编辑入口只在服务端概况读取成功后出现；null=未读到（含读取失败），此时不渲染入口。
  const [serverNickname, setServerNickname] = useState<string | null>(null);
  const [pending, setPending] = useState<NicknameIntent | null>(inheritedIntent as NicknameIntent | null);
  const [accepted, setAccepted] = useState(inheritedWrite?.accepted ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invalidField, setInvalidField] = useState("");

  const edited = useRef(initialDraft !== null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writeLock = useRef(Boolean(inheritedWrite));
  // F1：本次可见概况所绑定的共享身份范围 `${userId}:${identityVersion}`；读取成功时登记，失权/换主体时清空。
  const readScope = useRef<string | null>(null);
  const scopeRef = useRef(userId);
  scopeRef.current = userId;
  const active = (id: number) => sequence.current === id && scopeRef.current === userId;
  // F1：同步读共享会话当前主体与 identityVersion，不依赖父组件稍后重渲染，也不用响应 userId 兜底。
  const subjectScope = () => {
    const snap = sessionStore.getSnapshot();
    return snap.status === "authenticated" && snap.userId === userId ? `${snap.userId}:${snap.identityVersion}` : null;
  };
  const canActNow = () => { const scope = subjectScope(); return scope !== null && scope === readScope.current; };
  // F2：共享容器存在同主体其他类未决写时，本组件的新写在实际调用时同步阻止。
  const blockedByForeignWrite = () => {
    const slot = pendingWrite?.current;
    return Boolean(slot && slot.userId === userId && slot.intent.action !== "nickname");
  };
  const start = () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    return { id: ++sequence.current, abort };
  };
  const retainWrite = (intent: NicknameIntent | null, knownAccepted = false) => {
    if (!pendingWrite) return;
    const slot = pendingWrite.current;
    // F2：另一类未决写不属于本组件，既不覆盖也不清除。
    if (slot && slot.userId === userId && slot.intent.action !== "nickname") return;
    pendingWrite.current = intent ? { userId, intent, accepted: knownAccepted, target: "" } : null;
  };
  // 撤下旧概况事实与编辑资格（主体变化/失权/合同不成立）；已接受的意图由调用方按原责任保留。
  const withdraw = () => {
    readScope.current = null;
    setServerNickname(null);
    setOpen(false);
  };

  const fetchOverview = async (id: number, signal: AbortSignal): Promise<Overview> => {
    // 新请求发出前同步核主体：共享会话已换人/退出时不带着旧页面上下文发请求。
    const requestedScope = subjectScope();
    if (requestedScope === null) throw new OverviewUnconfirmed(true);
    const data = await webAuthRequest<Overview>("/security/overview", undefined, signal);
    if (!active(id)) return data;
    // 回填前再核一次：迟到响应不得把旧主体的事实写进当前页面。
    const scope = subjectScope();
    if (scope !== requestedScope || data.userId !== userId) throw new OverviewUnconfirmed(true);
    if (typeof data.nickname !== "string") throw new OverviewUnconfirmed(false);
    readScope.current = scope;
    setServerNickname(data.nickname);
    if (!edited.current) setValue(data.nickname);
    return data;
  };

  // 身份绑定读取：换身份/重挂载都会重启；401 走共享会话刷新，入口随概况事实一起撤下。
  useEffect(() => {
    const draft = nicknameDraft?.current?.userId === userId ? nicknameDraft.current.value : null;
    edited.current = draft !== null;
    setValue(draft ?? "");
    const request = start();
    setPending(pendingWrite?.current?.userId === userId && pendingWrite.current?.intent.action === "nickname" ? (pendingWrite.current.intent as NicknameIntent) : null);
    setServerNickname(null);
    readScope.current = null;
    setError("");
    setNotice("");
    void fetchOverview(request.id, request.abort.signal).catch((failure: unknown) => {
      if (!active(request.id)) return;
      if (failure instanceof WebAuthError && failure.status === 401) session.revalidate();
    });
    return () => {
      sequence.current++;
      controller.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const confirmResult = async (intent: NicknameIntent, id: number, signal: AbortSignal) => {
    const data = await fetchOverview(id, signal);
    if (!active(id)) return;
    if (data.nickname !== intent.expected) throw new Error("Nickname unconfirmed");
    edited.current = false;
    setValue(data.nickname);
    setServerNickname(data.nickname);
    if (nicknameDraft?.current?.userId === userId) nicknameDraft.current = null;
  };

  const save = async () => {
    if (busy || writeLock.current) return;
    // F2：调用时同步互斥——共享容器有其他未决写时不发新写、不动共享槽。
    if (blockedByForeignWrite()) return;
    // F1：发请求前同步核主体与 identityVersion；不满足即撤下旧概况与编辑资格，不发 POST。
    if (!canActNow()) {
      withdraw();
      setError("登录状态已变化，资料读取已撤下，请刷新页面后重试。");
      return;
    }
    const intent: NicknameIntent = { action: "nickname", expected: value };
    writeLock.current = true;
    retainWrite(intent);
    const request = start();
    setBusy(true);
    setError("");
    setNotice("");
    setAccepted(false);
    let serverAccepted = false;
    try {
      await webAuthRequest("/profile/nickname", { nickname: value }, request.abort.signal);
      serverAccepted = true;
      if (!active(request.id)) return;
      setAccepted(true);
      setPending(intent);
      retainWrite(intent, true);
      await confirmResult(intent, request.id, request.abort.signal);
      if (!active(request.id)) return;
      setPending(null);
      retainWrite(null);
      writeLock.current = false;
      setOpen(false);
      setNotice("昵称已更新。");
      publishUserSessionChange();
    } catch (failure) {
      if (!active(request.id)) return;
      // 保存 403、确认读取 401/403 或主体变化：撤下旧概况与编辑资格；
      // 已接受/未知的写意图不清除，继续走下面的恢复分支。
      const subjectLost =
        failure instanceof OverviewUnconfirmed ||
        (failure instanceof WebAuthError && (failure.status === 401 || failure.status === 403));
      if (subjectLost) withdraw();
      const unknown =
        serverAccepted ||
        (failure instanceof WebAuthError && (failure.accepted || failure.status === 0 || failure.status >= 500));
      if (unknown) {
        const knownAccepted = serverAccepted || (failure instanceof WebAuthError && failure.accepted);
        retainWrite(intent, knownAccepted);
        setPending(intent);
        setAccepted(knownAccepted);
        setError(
          knownAccepted
            ? "操作已接受，但后续状态暂时读不到。请重新确认，勿重复提交。"
            : "结果暂时无法确认，请先查询状态，勿重复提交。",
        );
        if (failure instanceof WebAuthError && failure.status === 401) session.revalidate();
      } else {
        retainWrite(null);
        writeLock.current = false;
        setPending(null);
        setError(
          failure instanceof OverviewUnconfirmed && failure.subject
            ? "登录状态已变化，资料读取已撤下，请刷新页面后重试。"
            : authErrorMessage(failure, "verify"),
        );
        if (failure instanceof WebAuthError && failure.status === 401) session.revalidate();
      }
    } finally {
      if (active(request.id)) setBusy(false);
    }
  };

  const reconcile = async () => {
    const intent = pending;
    // 提交锁只挡新写入；结果查询本身必须可执行（与安全页 reconcile 同一语义）。
    if (!intent || busy) return;
    const request = start();
    setBusy(true);
    try {
      await confirmResult(intent, request.id, request.abort.signal);
      if (!active(request.id)) return;
      setPending(null);
      retainWrite(null);
      writeLock.current = false;
      setOpen(false);
      setError("");
      setNotice("操作结果已确认。");
      publishUserSessionChange();
    } catch (failure) {
      if (!active(request.id)) return;
      // 确认读取 401/403 或主体变化：撤下旧概况与编辑资格；已接受意图保留在共享容器，恢复入口留在页面上。
      const subjectLost =
        failure instanceof OverviewUnconfirmed ||
        (failure instanceof WebAuthError && (failure.status === 401 || failure.status === 403));
      if (subjectLost) withdraw();
      setError(
        failure instanceof OverviewUnconfirmed && failure.subject
          ? "登录状态已变化，资料读取已撤下，请刷新页面后重试。"
          : failure instanceof WebAuthError && (failure.status === 401 || failure.status === 403)
            ? authErrorMessage(failure, "read")
            : "结果仍未确认，请稍后再查询。",
      );
      if (failure instanceof WebAuthError && failure.status === 401) session.revalidate();
    } finally {
      if (active(request.id)) setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim() || [...value].length > 64) {
      setInvalidField("profile-nickname");
      setError("昵称需要 1–64 个字符。");
      return;
    }
    setInvalidField("");
    void save();
  };

  const locked = busy || Boolean(pending) || writeLock.current;
  const formLocked = locked || Boolean(foreignWrite);
  const showPendingNotice = Boolean(pending) && !open;
  const showForeignNotice = Boolean(foreignWrite) && !pending && !open;
  const showWithdrawnNotice = serverNickname === null && !pending && !open && Boolean(error);
  // 概况未读到（未读/读取失败/失权）时撤下入口，不因“能进总览页”假定资料可编辑；
  // 但待确认意图的恢复入口、跨页返回恢复入口与撤下说明必须保留。
  if (serverNickname === null && !showPendingNotice && !showForeignNotice && !showWithdrawnNotice && !(pending && open)) return null;

  return (
    <div className="account-profile-edit" data-testid="profile-edit-entry">
      {showPendingNotice ? (
        <div className="account-nickname-pending" role="alert">
          <span>昵称修改结果待确认。</span>
          <button type="button" className="button secondary button--xs" disabled={busy} onClick={() => void reconcile()}>
            重新确认结果
          </button>
        </div>
      ) : null}
      {showForeignNotice ? (
        <div className="account-nickname-pending" role="alert">
          <span>其他操作结果待确认，昵称修改已暂停。</span>
          <Link href="/account?view=security" className="button secondary button--xs">前往安全设置确认</Link>
        </div>
      ) : null}
      {showWithdrawnNotice ? (
        <p id="profile-nickname-result" role="alert" className="account-module-note is-error">{error}</p>
      ) : null}
      {serverNickname === null ? null : (
        <button
          type="button"
          className="button quiet button--xs account-edit-profile"
          data-testid="edit-profile"
          disabled={busy}
          onClick={() => {
            setError("");
            setNotice("");
            setOpen(true);
          }}
        >
          <Pencil size={13} aria-hidden="true" />
          编辑资料
        </button>
      )}

      <Dialog.Root open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="sec-dialog profile-dialog">
            <Dialog.Title>编辑资料</Dialog.Title>
            <Dialog.Description asChild>
              <p className="sec-dialog-desc">对外展示的昵称，仅用于展示，不影响登录方式。</p>
            </Dialog.Description>
            <form aria-label="修改昵称" className="auth-fields" onSubmit={submit} noValidate>
              <FieldGroup id="profile-nickname" label="昵称" helper="1–64 个字符，仅用于对外展示。" required>
                <input
                  id="profile-nickname"
                  aria-describedby={["profile-nickname-helper", invalidField === "profile-nickname" ? "profile-nickname-result" : ""].filter(Boolean).join(" ")}
                  aria-invalid={invalidField === "profile-nickname" || undefined}
                  value={value}
                  disabled={formLocked}
                  autoComplete="nickname"
                  onChange={(event) => {
                    edited.current = true;
                    if (nicknameDraft) nicknameDraft.current = { userId, value: event.target.value };
                    setValue(event.target.value);
                  }}
                />
              </FieldGroup>
              {foreignWrite ? (
                <div className="account-nickname-pending" role="alert">
                  <span>其他操作结果待确认，昵称修改已暂停。</span>
                  <Link href="/account?view=security" className="button secondary button--xs">前往安全设置确认</Link>
                </div>
              ) : null}
              {pending ? (
                <RecoveryAlert
                  className="sec-recovery"
                  tone="unknown"
                  title="操作结果待确认"
                  problem={accepted ? "昵称修改已被服务端接受，但后续状态暂时读不到。" : "暂时无法确认本次修改是否已经生效。"}
                  impact="本次修改目标已冻结。请勿重复提交，先查询结果。"
                  action={
                    <button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile()}>
                      重新确认结果
                    </button>
                  }
                  details={{ summary: "为什么不能直接重试", body: "重发已被接受的写入会产生第二次变更。查询用同一凭据读取服务端回执，不会新建操作。" }}
                />
              ) : null}
              {(error || notice) && (
                <p id="profile-nickname-result" role={error ? "alert" : "status"} className={"account-module-note" + (error ? " is-error" : "")}>
                  {error || notice}
                </p>
              )}
              <div className="sec-dialog-actions">
                <button type="button" className="button quiet" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
                <button type="submit" className="button primary" disabled={formLocked}>
                  保存昵称
                </button>
              </div>
            </form>
            <Dialog.Close className="icon-button dialog-close" aria-label="关闭对话框">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
