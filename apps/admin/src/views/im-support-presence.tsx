"use client";
/**
 * 客服工作台「在线」模块：接待状态机与云信连接生命周期。
 * useSupportPresence 拥有 presence/connection/租约/心跳与 operator 代次；
 * 队列与消息写入通过 onQueue/onIncoming 端口交回编排层，接待弹窗编排仍在 im-support-view.tsx。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Bell, BellOff, CircleAlert, X } from "lucide-react";
import { ImClientLifecycle, isImDisposeFailure, markImDisposeFailure } from "@zzsh/im-client/lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, NIM_RECEIPT_PENDING, NimLoginTerminalError, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { API_ROOT, AdminApiError, adminRequest, friendlyError } from "../api";
import { messageAccessPath } from "./im-support-guards";
import { acquireSupportTabLease } from "./support-tab-lease";
import { ActionTooltip } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { formatDuration } from "./im-support-management-model";
import {
  PRESENCE_CONFLICT_NOTICE, PRESENCE_SAVE_ERROR, connectionForPresence, createConnectionId,
  httpStatus, presenceRuntimeState, presenceWriteSucceeded, readConsultations, readImToken,
  scopeStateLabel, staleHeartbeatRetryState, typeLabel,
  type ConnectionClaim, type ConnectionLease, type Consultation, type Presence, type PresenceHeartbeat,
} from "./im-support-view-model";

/** Isolates the 1-second display re-render from the rest of the workbench. */
export function TodayDuration({ seconds, active }: { seconds: number | undefined; active: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { setTick(0); }, [seconds]);
  useEffect(() => {
    if (!active || seconds === undefined) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active, seconds]);
  return (
    <ActionTooltip content="今日接待开启时长（含短暂断线和锁屏存活；失联30分钟后按最后可信存活截断）">
      <span className="im-wb-state im-wb-today" data-action="today-duty">今日接待 <b>{seconds === undefined ? "—" : formatDuration(seconds + tick)}</b></span>
    </ActionTooltip>
  );
}

export type SupportPresencePorts = {
  adminUserId: string;
  sessionLocked: boolean;
  readClientKey: string;
  canRead: boolean;
  canPresence: boolean;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
  /** 队列读取成功（含只读回退）：编排层据此 setQueue + setQueueLoaded。 */
  onQueue: (rows: Consultation[]) => void;
  /** 实时消息：编排层按 queueRef 归属会话并合并消息/未读。 */
  onIncoming: (incoming: NimMessageLike[], client: NimWebClientLike) => void;
};

export function useSupportPresence(ports: SupportPresencePorts) {
  const { adminUserId, sessionLocked, readClientKey, canRead, canPresence, setNotice } = ports;
  const onQueueRef = useRef(ports.onQueue);
  onQueueRef.current = ports.onQueue;
  const onIncomingRef = useRef(ports.onIncoming);
  onIncomingRef.current = ports.onIncoming;

  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">("idle");
  const [localLeader, setLocalLeader] = useState(true);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [connectionLeaseActive, setConnectionLeaseActive] = useState(false);
  const connectionIdRef = useRef(createConnectionId());
  const [presence, setPresence] = useState<Presence>({ adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const [busy, setBusy] = useState(false);
  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const availabilityRef = useRef<Presence["availability"]>("OFF_DUTY");
  const presenceVersionRef = useRef<number | null>(null);
  const presenceStateRevisionRef = useRef<number | null>(null);
  const heartbeatChainRef = useRef(Promise.resolve());
  const handoffRef = useRef<Promise<void>>(Promise.resolve());
  // 最近一次由服务端确认的 presence。写入失败时用它回退 availabilityRef，
  // 让 30s 心跳与连接事件只重放"已知成立"的状态，而不是重试失败的用户意图。
  const presenceRef = useRef<Presence>({ adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const presenceWriteRef = useRef(Promise.resolve());
  const connectionRef = useRef(connection);
  const sessionLockedRef = useRef(sessionLocked);
  sessionLockedRef.current = sessionLocked;
  const nimGenerationRef = useRef(0);
  const terminalConnectionRef = useRef<"KICKED" | "AUTH_FAILED" | undefined>(undefined);
  const applyConnection = useCallback((next: NimWebConnectionState | "idle" | "error") => {
    connectionRef.current = next;
    setConnection(next);
  }, []);
  const localLeaderRef = useRef(localLeader);
  localLeaderRef.current = localLeader;
  const authRetryRef = useRef(0);
  const logoutRetryRef = useRef(false);
  const busyOwnerRef = useRef(0);
  const canPresenceRef = useRef(canPresence);
  const operatorRef = useRef("");
  const operatorGenerationRef = useRef(0);
  const readyOperatorRef = useRef<string | null>(null);
  const [readyOperator, setReadyOperator] = useState<string | null>(null);
  const markReadyOperator = useCallback((value: string | null) => {
    readyOperatorRef.current = value;
    setReadyOperator(value);
  }, []);
  canPresenceRef.current = canPresence;
  if (operatorRef.current !== readClientKey) { operatorRef.current = readClientKey; operatorGenerationRef.current += 1; }

  const beginBusy = () => { const owner = busyOwnerRef.current + 1; busyOwnerRef.current = owner; setBusy(true); return owner; };
  const endBusy = (owner: number) => { if (busyOwnerRef.current === owner) setBusy(false); };
  // 所有 presence 显示/版本只从服务端返回值更新；客户端没有任何"先行生效"的路径。
  const rememberPresence = useCallback((value: Presence) => {
    presenceVersionRef.current = value.version;
    presenceStateRevisionRef.current = value.stateRevision ?? null;
    presenceRef.current = value;
    availabilityRef.current = value.availability;
    setPresence(value);
  }, []);

  const writePresence = useCallback((availability: Presence["availability"], state: ReturnType<typeof connectionForPresence>, options?: { takeover?: boolean }) => {
    const key = readClientKey;
    const generation = operatorGenerationRef.current;
    const current = () => canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation;
    if (!canPresence || !current()) return Promise.resolve<Presence | undefined>(undefined);
    availabilityRef.current = availability;
    const operation = presenceWriteRef.current.then(async () => {
      if (!current()) return undefined;
      let version = presenceVersionRef.current;
      if (version === null) {
        // 本操作员本次会话的第一次写入：先向服务端要当前版本，再写。
        // 上一会话可能已留下 presence 行；此时省略 version 会让 PUT 必然 409，
        // 首屏就变成“未上线 + 一次失败”，而这不是并发冲突。
        try {
          const existing = await adminRequest<Presence>("/im/presence");
          if (!current()) return undefined;
          rememberPresence(existing);
          version = presenceVersionRef.current;
        } catch {
          if (!current()) return undefined;
          // 读不到就保持 null，让服务端按“无行则插入”的规则自行裁决。
        }
      }
      if (!current()) return undefined;
      try {
        const value = await adminRequest<Presence>("/im/presence", {
          availability,
          connectionState: state,
          ...(version === null ? {} : { version }),
          ...(options?.takeover ? { takeover: true } : {}),
          connectionId: connectionIdRef.current,
        }, "PUT");
        if (!current()) return undefined;
        rememberPresence(value);
        return value;
      } catch (cause) {
        if (!canPresenceRef.current || operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
        // 失败不能成为本地状态：先把意图回退到最近一次服务端确认值，显示保持真实。
        availabilityRef.current = presenceRef.current.availability;
        if (httpStatus(cause) === 409) {
          // 版本冲突：别的窗口已写过。读取最新版本与状态，不重发这次 PUT。
          try {
            const latest = await adminRequest<Presence>("/im/presence");
            if (!canPresenceRef.current || operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
            rememberPresence(latest);
            setNotice(PRESENCE_CONFLICT_NOTICE);
          } catch {
            if (canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation) setNotice(PRESENCE_SAVE_ERROR);
          }
          return undefined;
        }
        // 401/423 由 adminRequest 触发的既有会话刷新处理，这里不自行重登。
        setNotice(httpStatus(cause) === 401 || httpStatus(cause) === 423 ? friendlyError(cause) : PRESENCE_SAVE_ERROR);
        return undefined;
      }
    });
    presenceWriteRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [canPresence, readClientKey, rememberPresence, setNotice]);

  const heartbeatPresence = useCallback((state: NimWebConnectionState, generation: number, client?: NimWebClientLike | null): Promise<void> => {
    const key = readClientKey;
    const operatorGeneration = operatorGenerationRef.current;
    const current = () => canPresenceRef.current && operatorRef.current === key
      && operatorGenerationRef.current === operatorGeneration && localLeaderRef.current
      && !sessionLockedRef.current
      && presenceRef.current.availability === "AVAILABLE"
      && nimGenerationRef.current === generation
      && (client == null || clientRef.current === client);
    const run = async (sendState: NimWebConnectionState, retryStale: boolean): Promise<void> => {
      if (!current()) return;
      if (presenceStateRevisionRef.current === null) {
        const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
        if (!current() || !latest) return;
        rememberPresence(latest);
      }
      try {
        const value = await adminRequest<PresenceHeartbeat>("/im/presence/heartbeat", {
          connectionState: sendState,
          stateRevision: presenceStateRevisionRef.current,
          connectionId: connectionIdRef.current,
        }, "POST");
        if (!current()) return;
        // A newer NIM event already superseded this response; never let a late
        // CONNECTED write over a disconnect/kick/reconnect state.
        if (connectionForPresence(connectionRef.current) !== sendState) return;
        presenceStateRevisionRef.current = value.stateRevision;
        setPresence((currentPresence) => ({
          ...currentPresence,
          connectionState: sendState,
          disconnectedSince: value.disconnectedSince,
          dispatchPaused: value.dispatchPaused,
          dispatchable: value.dispatchable,
          reason: value.reason,
          stateRevision: value.stateRevision,
          ...(value.today ? { today: value.today } : {}),
        }));
        if (value.ok) return;
        if (value.reason === "STALE_STATE" && retryStale) {
          const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
          if (!current() || !latest) return;
          rememberPresence(latest);
          // Retry with the *current* live connection state, not the stale closure's
          // state. A terminal event must be recorded, and an old CONNECTED must not
          // be replayed after the client was kicked or started reconnecting.
          const liveState = staleHeartbeatRetryState({
            liveConnection: connectionRef.current,
            terminal: terminalConnectionRef.current,
            sentGeneration: generation,
            liveGeneration: nimGenerationRef.current,
            sentClient: client,
            liveClient: clientRef.current,
          });
          if (!liveState) return;
          return run(liveState, false);
        }
        const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
        if (!current()) return;
        if (latest) rememberPresence(latest);
        const stopConnection = value.reason === "OTHER_WINDOW" || value.reason === "TAKEN_OVER"
          || value.reason === "STALE_CONNECTION"
          || value.reason === "FORBIDDEN" || value.reason === "SESSION_INVALID" || value.reason === "LOCKED"
          || latest?.ownedByAnotherSession === true;
        if (stopConnection) {
          clientRef.current = null;
          nimGenerationRef.current += 1;
          applyConnection("idle");
          void lifecycleRef.current?.close();
        }
        if (value.reason === "OTHER_WINDOW" || value.reason === "TAKEN_OVER" || latest?.ownedByAnotherSession) {
          setNotice("其他窗口已持有云信连接或接管接待，本页不再登录云信。");
        } else if (value.reason === "FORBIDDEN") setNotice("接待权限已失效，请联系管理岗。");
        else if (value.reason === "ENDED") setNotice("当前接待已结束，如需继续请重新开始接待。");
      } catch {
        // The next interval or visibility event retries; heartbeat failure does not
        // end reception or rewrite the last server-confirmed state.
      }
    };
    heartbeatChainRef.current = heartbeatChainRef.current.then(() => run(state, true), () => run(state, true));
    return heartbeatChainRef.current;
  }, [readClientKey, rememberPresence, applyConnection, setNotice]);

  // Identity/permission change: drop the presence projection and owned connection.
  useEffect(() => {
    clientRef.current = null;
    markReadyOperator(null);
    const clearedPresence: Presence = { adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 };
    presenceRef.current = clearedPresence;
    setPresence(clearedPresence);
    presenceVersionRef.current = null;
    presenceStateRevisionRef.current = null;
    heartbeatChainRef.current = Promise.resolve();
    availabilityRef.current = "OFF_DUTY";
    applyConnection("idle");
    setLocalLeader(true);
    setReconnectEpoch(0);
    authRetryRef.current = 0;
    logoutRetryRef.current = false;
    busyOwnerRef.current += 1;
    setBusy(false);
    presenceWriteRef.current = Promise.resolve();
  }, [readClientKey, adminUserId, applyConnection, markReadyOperator]);

  useEffect(() => {
    if (!canRead) return;
    // A locked page holds no live NIM connection. Reset the local state so an
    // unlock cannot send a stale CONNECTED heartbeat before NIM actually recovers.
    if (sessionLocked) { applyConnection("idle"); return; }
    // A kick is terminal until the operator explicitly reconnects; an automatic
    // epoch/retry or an unrelated re-render must not log in over the new client.
    if (terminalConnectionRef.current === "KICKED") { applyConnection("KICKED"); return; }
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryWake: (() => void) | undefined;
    let tabLease: ReturnType<typeof acquireSupportTabLease> | undefined;
    const waitForRetry = (ms: number) => new Promise<void>((resolve) => {
      let settled = false;
      let timer: number | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        window.removeEventListener("online", finish);
        retryWake = undefined;
        resolve();
      };
      retryWake = finish;
      timer = window.setTimeout(finish, ms);
      window.addEventListener("online", finish, { once: true });
    });
    const leaseAbort = new AbortController();
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const lifecycle = new ImClientLifecycle<NimWebClientLike>(async (context) => {
      const token = await readImToken(connectionIdRef.current);
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/bff/admin/im/messages", accountId: token.accountId, pollMs: 1_500 })(context);
      const factory = createNimWebClientFactory({
        appKey: token.appKey,
        accountId: token.accountId,
        enableCloudConversation: true,
        messageReceiptEndpoint:"/api/bff/admin/im/messages",
        onReceiptStatus:({pending,failed,persistent})=>{if(pending&&(failed||!persistent))setNotice(NIM_RECEIPT_PENDING+(!persistent?"本地恢复记录未保存，请在离开前恢复登记。":""));else if(!pending)setNotice(current=>current?.startsWith(NIM_RECEIPT_PENDING)?undefined:current);},
        messageAuthorization: async ({ conversationId, operation,...intent }) => {
          const value = await adminRequest<{ authorized?: unknown }>(messageAccessPath(conversationId, operation,intent));
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
        },
        tokenProvider: async (accountId) => {
          const refreshed = await readImToken(connectionIdRef.current);
          if (refreshed.accountId !== accountId || refreshed.accountId !== token.accountId) throw new Error("云信账号不匹配");
          return refreshed.token;
        },
      });
      const handle = await factory(context);
      // The token was bound before login, but a takeover can happen while the SDK
      // is logging in. Re-check this exact instance before exposing the client; if
      // it lost the slot, dispose what just logged in instead of keeping two
      // clients on one account.
      try {
        const lease = await adminRequest<ConnectionLease>("/im/presence/connection", { connectionId: connectionIdRef.current }, "POST");
        if (!lease.ok) throw new AdminApiError(
          lease.reason === "LOCKED" ? 423 : lease.reason === "SESSION_INVALID" ? 401 : 409,
          lease.reason,
          undefined,
          "/im/presence/connection",
        );
      } catch (error) {
        try { await handle.dispose(); }
        catch (disposeError) {
          throw markImDisposeFailure(
            error instanceof Error ? error : new Error("IM connection was taken over after login", { cause: error }),
            disposeError,
          );
        }
        throw error;
      }
      return handle;
    });
    lifecycleRef.current = lifecycle;
    const connectionGeneration = ++nimGenerationRef.current;
    terminalConnectionRef.current = undefined;
    // Wait for every prior effect's real NIM close, not only the immediately
    // preceding one. Rapid reconnects must not chain two overlapping clients.
    const previousHandoff = handoffRef.current;
    const current = () => !cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator;
    const readQueueForReadOnly = async () => {
      const queueResult = await readConsultations().catch((cause) => {
        if (current()) setNotice(friendlyError(cause));
        return null;
      });
      if (!current()) return;
      if (queueResult) onQueueRef.current(queueResult);
    };
    const run = async () => {
      try {
        await previousHandoff;
      } catch {
        if (current()) {
          applyConnection("AUTH_FAILED");
          setConnectionLeaseActive(false);
          setNotice("旧连接未安全关闭，请刷新页面后重试。");
        }
        return;
      }
      try {
        // Ownership is decided before any NIM login: a second browser (or a reader
        // without presence permission) must never kick the reception holder.
        let initialPresence: Presence | null = null;
        let initialPresenceError: unknown;
        if (canPresence) {
          try { initialPresence = await adminRequest<Presence>("/im/presence"); }
          catch (cause) { initialPresenceError = cause; }
        }
        if (!current()) return;
        if (initialPresence) rememberPresence(initialPresence);
        if (initialPresence?.ownedByAnotherSession && initialPresence.availability === "AVAILABLE") {
          markReadyOperator(operator);
          setLocalLeader(true);
          setConnectionLeaseActive(false);
          applyConnection("idle");
          await readQueueForReadOnly();
          return;
        }
        if (canPresence && !initialPresence) {
          applyConnection("error");
          const status = httpStatus(initialPresenceError);
          if (status !== undefined && status < 500 && status !== 408 && status !== 429) {
            setNotice("登录状态或接待权限已失效，请重新登录或联系管理员。");
            return;
          }
          setNotice("接待状态读取失败，稍后自动重试。");
          await waitForRetry(5_000);
          if (current()) setReconnectEpoch((value) => value + 1);
          return;
        }
        // One tab per administrator/NIM account owns the single IM login, even
        // when two browser profiles have different auth sessions. The server claim
        // below is the cross-browser authority; this lock only serializes tabs.
        const lease = tabLease = acquireSupportTabLease(`zzsh-im-support:${adminUserId}`, leaseAbort.signal);
        setLocalLeader(!lease.supported);
        // Directory reads do not need NIM. Let a waiting tab render the queue and
        // order workbench while the current holder keeps the only IM login.
        markReadyOperator(operator);
        void readQueueForReadOnly();
        const acquired = await lease.acquired;
        if (!acquired) {
          if (current()) { applyConnection("idle"); setNotice("云信连接锁不可用，本页保持只读。"); }
          return;
        }
        if (!current()) return;
        setLocalLeader(true);
        markReadyOperator(operator);
        applyConnection("CONNECTING");
        // Server-side connection claim must run before any NIM login. Two browser
        // sessions that both see an empty presence race on the same row.
        if (current()) {
          let claimed: ConnectionClaim | null = null;
          let claimError: unknown;
          try { claimed = await adminRequest<ConnectionClaim>("/im/presence/connect", { connectionId: connectionIdRef.current }, "POST"); }
          catch (cause) { claimError = cause; }
          if (!current()) return;
          if (!claimed?.ok) {
            const latest = canPresence ? await adminRequest<Presence>("/im/presence").catch(() => null) : null;
            if (!current()) return;
            if (latest) rememberPresence(latest);
            // No NIM client exists yet on this path, so releasing the local lock
            // immediately is safe; a waiting tab may try the server claim next.
            lease.release();
            // A server-side OTHER_WINDOW means this tab is the read-only fallback,
            // including the no-Web-Locks case; it must not present as the holder.
            const waitingForOwnLease = claimed?.reason === "OTHER_WINDOW"
              && (latest?.ownedByAnotherSession === false || latest?.availability !== "AVAILABLE");
            const status = httpStatus(claimError);
            const retryNetwork = !claimed && (status === undefined || status >= 500 || status === 408 || status === 429);
            setLocalLeader(claimed?.reason === "OTHER_WINDOW" ? false : true);
            applyConnection(retryNetwork ? "error" : "idle");
            setConnectionLeaseActive(false);
            setNotice(waitingForOwnLease
              ? "上一个接待连接尚未释放，系统会自动尝试恢复。"
              : claimed?.reason === "OTHER_WINDOW" ? "其他窗口已持有云信连接，本页保持只读。"
              : claimed?.reason === "LOCKED" ? "当前会话已锁屏，解锁后再连接。"
                : retryNetwork ? "消息服务暂不可用，正在自动重试。"
                : "接待权限或登录状态已失效，暂不能连接云信。");
            await readQueueForReadOnly();
            if (waitingForOwnLease || retryNetwork) {
              await waitForRetry(waitingForOwnLease ? 15_000 : 5_000);
              if (current()) setReconnectEpoch((value) => value + 1);
            }
            return;
          }
          presenceVersionRef.current = claimed.version ?? presenceVersionRef.current;
          presenceStateRevisionRef.current = claimed.stateRevision ?? presenceStateRevisionRef.current;
          setConnectionLeaseActive(true);
          setPresence((currentPresence) => ({
            ...currentPresence,
            version: claimed.version ?? currentPresence.version,
            stateRevision: claimed.stateRevision ?? currentPresence.stateRevision,
          }));
        }
        let client: NimWebClientLike | null = null;
        const delays = [3_000, 5_000, 10_000, 30_000, 60_000];
        for (let attempt = 0; !client; attempt += 1) {
          if (!current()) return;
          try {
            client = await lifecycle.open(adminUserId);
          } catch (cause) {
            if (!current()) return;
            if (cause instanceof NimLoginTerminalError) {
              if (cause.state === "AUTH_FAILED" && authRetryRef.current < 2) {
                // The first token/login attempt can fail on a stale credential.
                // Re-request the token a bounded number of times; KICKED is never
                // retried, and both terminal states still stop after the limit.
                authRetryRef.current += 1;
                applyConnection("AUTH_FAILED");
                setNotice("云信登录认证失败，正在重新获取登录凭据。");
                void heartbeatPresence("AUTH_FAILED", connectionGeneration, null);
                await waitForRetry(authRetryRef.current === 1 ? 5_000 : 15_000);
                continue;
              }
              terminalConnectionRef.current = cause.state;
              applyConnection(cause.state);
              setNotice(cause.state === "KICKED" ? "云信连接已被其他客户端下线。点击“在此接待”可重新连接。" : "云信登录认证失败，请点击“重新连接”。");
              void heartbeatPresence(cause.state, connectionGeneration, null);
              return;
            }
            if (terminalConnectionRef.current) {
              applyConnection(terminalConnectionRef.current);
              return;
            }
            if (isImDisposeFailure(cause)) {
              terminalConnectionRef.current = "AUTH_FAILED";
              applyConnection("AUTH_FAILED");
              setNotice("旧连接未安全关闭，请刷新页面后重试。");
              return;
            }
            const status = httpStatus(cause);
            if (status === 409) {
              applyConnection("idle");
              setLocalLeader(false);
              setConnectionLeaseActive(false);
              setNotice("其他窗口已接管云信连接，本页保持只读。");
              return;
            }
            if (status === 401 || status === 403 || status === 423) {
              applyConnection("AUTH_FAILED");
              setNotice("登录状态已失效，请重新登录后再连接云信。");
              return;
            }
            // Transport/API failure: keep a controlled retry alive (and wake on
            // `online`) while the session still permits reading. Explicit auth
            // failure or kick is a terminal branch above and is never looped.
            applyConnection(attempt === 0 ? "error" : "RECONNECTING");
            setNotice("消息服务暂不可用，正在自动重连；接待计时与派单暂停由服务端规则保持。");
            await waitForRetry(delays[Math.min(attempt, delays.length - 1)] ?? 60_000);
          }
        }
        if (!current()) return;
        if (!client) return;
        clientRef.current = client;
        markReadyOperator(operator);
        // Register before the first presence/queue read: a disconnect during those
        // requests must not be lost behind a stale CONNECTED state.
        client.onConnectionStateChange((state, details) => {
          if (!current() || clientRef.current !== client) return;
          applyConnection(state);
          let beatGeneration = connectionGeneration;
          if (state === "KICKED" || state === "AUTH_FAILED") {
            terminalConnectionRef.current = state;
            if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined; }
            retryWake?.();
            // Invalidate any in-flight CONNECTED response from the previous state.
            beatGeneration = ++nimGenerationRef.current;
          } else if (state === "CONNECTED") {
            terminalConnectionRef.current = undefined;
            authRetryRef.current = 0;
            logoutRetryRef.current = false;
          }
          if (state === "KICKED") {
            const reason = details?.kickedReasonDesc ? `：${details.kickedReasonDesc}` : "";
            setNotice(`云信连接已被其他客户端下线${reason}。点击“在此接待”可重新连接。`);
          } else if (state === "AUTH_FAILED") {
            setNotice("云信登录认证失败，正在重新获取登录凭据。");
          }
          if (canPresenceRef.current && localLeaderRef.current && !presenceRef.current.ownedByAnotherSession) {
            void heartbeatPresence(connectionForPresence(state), beatGeneration, client);
          }
          if (state === "DISCONNECTED" && details?.kind === "LOGOUT" && !logoutRetryRef.current && presenceRef.current.availability === "AVAILABLE") {
            logoutRetryRef.current = true;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, 0);
          } else if (state === "AUTH_FAILED" && authRetryRef.current < 2) {
            authRetryRef.current += 1;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, authRetryRef.current === 1 ? 5_000 : 15_000);
          }
        });
        const initialConnection = client.getConnectionState();
        if (initialConnection === "CONNECTED") {
          authRetryRef.current = 0;
          logoutRetryRef.current = false;
          terminalConnectionRef.current = undefined;
        } else if (initialConnection === "KICKED") {
          terminalConnectionRef.current = "KICKED";
          setNotice("云信连接已被其他客户端下线。点击“在此接待”可重新连接。");
        } else if (initialConnection === "AUTH_FAILED") {
          terminalConnectionRef.current = "AUTH_FAILED";
          setNotice("云信登录认证失败，正在重新获取登录凭据。");
          if (authRetryRef.current < 2 && retryTimer === undefined) {
            authRetryRef.current += 1;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, authRetryRef.current === 1 ? 5_000 : 15_000);
          }
        }
        applyConnection(initialConnection);
        const [presenceResult, queueResult] = await Promise.allSettled([
          canPresence ? adminRequest<Presence>("/im/presence") : Promise.resolve(undefined),
          readConsultations(),
        ]);
        if (!current() || clientRef.current !== client) return;
        if (presenceResult.status === "fulfilled" && presenceResult.value) rememberPresence(presenceResult.value);
        if (queueResult.status === "fulfilled") onQueueRef.current(queueResult.value);
        else setNotice(friendlyError(queueResult.reason));
        if (canPresence && !presenceRef.current.ownedByAnotherSession) {
          void heartbeatPresence(connectionForPresence(client.getConnectionState()), connectionGeneration, client);
        }
        client.onMessages((incoming) => {
          if (!current() || clientRef.current !== client) return;
          onIncomingRef.current(incoming, client);
        });
      } catch (cause) {
        if (current()) { applyConnection("error"); setNotice(friendlyError(cause)); }
      }
    };
    void run();
    return () => {
      cancelled = true;
      leaseAbort.abort();
      retryWake?.();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      clientRef.current = null;
      setConnectionLeaseActive(false);
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) markReadyOperator(null);
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      // Dispose the old NIM connection (including a login that is still opening)
      // before the next effect may claim again. A failed cleanup keeps the lock:
      // an unproven handoff is not a safe handoff.
      const handoff = previousHandoff.then(async () => {
        try {
          await lifecycle.close();
        } catch (error) {
          setNotice("旧连接未安全关闭，请刷新页面后重试。");
          throw error;
        }
        tabLease?.release();
      });
      handoffRef.current = handoff;
      void handoff.catch(() => undefined);
    };
  }, [canPresence, canRead, readClientKey, adminUserId, sessionLocked, reconnectEpoch, heartbeatPresence, rememberPresence, applyConnection, markReadyOperator, setNotice]);

  // Browser connectivity recovery for a client that was already open. The NIM SDK
  // usually reconnects itself; this is the user-visible fallback when it does not.
  useEffect(() => {
    if (!canRead || !localLeader || sessionLocked) return;
    const onOnline = () => {
      if (terminalConnectionRef.current) return;
      if (["DISCONNECTED", "RECONNECTING", "error"].includes(connectionRef.current)) {
        setReconnectEpoch((value) => value + 1);
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [canRead, localLeader, sessionLocked]);

  // One heartbeat for every connection state. It runs without CONNECTED so a
  // disconnect is reported once, a short reconnect keeps the same interval, and
  // the server can return TAKEN_OVER/ENDED before the next UI action.
  useEffect(() => {
    if (!canPresence || !localLeader || presence.ownedByAnotherSession || presence.unbound
      || presence.availability !== "AVAILABLE" || sessionLocked
      || connection === "idle" || connection === "error") return;
    const beat = () => { void heartbeatPresence(connectionForPresence(connectionRef.current), nimGenerationRef.current, clientRef.current); };
    const timer = window.setInterval(beat, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") beat(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", beat);
    window.addEventListener("pageshow", beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", beat);
      window.removeEventListener("pageshow", beat);
    };
  }, [canPresence, localLeader, connection, presence.availability, presence.ownedByAnotherSession, presence.unbound, sessionLocked, heartbeatPresence]);

  // Off-duty pages still own the exclusive connection slot. Renew the bounded
  // connection lease so a crashed/closed window can recover after it expires.
  useEffect(() => {
    if (!connectionLeaseActive || !localLeader) return;
    let cancelled = false;
    const renew = () => {
      void adminRequest<ConnectionLease>("/im/presence/connection", { connectionId: connectionIdRef.current }, "POST")
        .then((value) => {
          if (cancelled || value?.ok) return;
          if (value.reason !== "OTHER_WINDOW" && value.reason !== "STALE_CONNECTION") return;
          setConnectionLeaseActive(false);
          clientRef.current = null;
          nimGenerationRef.current += 1;
          applyConnection("idle");
          setLocalLeader(false);
          void lifecycleRef.current?.close();
          setNotice("其他窗口已接管云信连接，本页保持只读。");
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(renew, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyConnection, connectionLeaseActive, localLeader, setNotice]);

  // Best-effort page-close notice: it only advances the first disconnect time, so
  // a lost beacon (crash, sleep) simply falls back to the last confirmed liveness.
  useEffect(() => {
    if (!localLeader || presence.ownedByAnotherSession) return;
    const onPageHide = (event: PageTransitionEvent) => {
      // bfcache keeps the page (and its SDK) alive; do not hand off on a freeze.
      if (event.persisted) return;
      if (presence.availability === "AVAILABLE") {
        const stateRevision = presenceStateRevisionRef.current;
        if (stateRevision !== null) {
          void fetch(`${API_ROOT}/im/presence/heartbeat`, {
            method: "POST",
            credentials: "include",
            keepalive: true,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connectionState: "DISCONNECTED", stateRevision, connectionId: connectionIdRef.current }),
          }).catch(() => undefined);
        }
      }
      // Dispose every prior effect's SDK, then this effect's client, before
      // clearing the server claim. lifecycleRef may already point at a new effect
      // whose open is still waiting on the old handoff chain; releasing early would
      // let a standby tab log in while the old client is still alive. If any close
      // is unproven or the page unloads first, the bounded lease is the recovery path.
      void (async () => {
        try { await handoffRef.current; } catch { return; }
        const lifecycle = lifecycleRef.current;
        if (lifecycle) {
          try { await lifecycle.close(); } catch { return; }
        }
        await fetch(`${API_ROOT}/im/presence/release`, {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: connectionIdRef.current }),
        }).catch(() => undefined);
      })();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [localLeader, presence.availability, presence.ownedByAnotherSession]);

  const applyPresence = async (availability: Presence["availability"], options?: { takeover?: boolean }): Promise<boolean> => {
    if (!canPresence) return false;
    const busyOwner = beginBusy();
    setNotice(undefined);
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try {
      const value = await writePresence(availability, connectionForPresence(connection), options);
      return canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator
        && presenceWriteSucceeded(value, availability);
    }
    catch (cause) { if (canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(friendlyError(cause)); return false; }
    finally { endBusy(busyOwner); }
  };
  const reconnect = () => setReconnectEpoch((value) => value + 1);
  const restartConnection = () => { terminalConnectionRef.current = undefined; setReconnectEpoch((value) => value + 1); };

  return {
    presence, connection, localLeader, busy, readyOperator,
    clientRef, connectionIdRef, operatorRef, operatorGenerationRef,
    beginBusy, endBusy, applyPresence, writePresence, reconnect, restartConnection,
  };
}

/** 顶栏在线运行时：通知铃、接待状态、今日时长、接待开关与通道异常提示。 */
export function SupportRuntimeBar({ canPresence, presence, connection, busy, localLeader, sessionLocked, notifyPermission, notifyEnabled, notifyUnreadCount, isLocalFake, onToggleNotifications, onTogglePresence, onEndReception }: {
  canPresence: boolean;
  presence: Presence;
  connection: NimWebConnectionState | "idle" | "error";
  busy: boolean;
  localLeader: boolean;
  sessionLocked: boolean;
  notifyPermission: string;
  notifyEnabled: boolean;
  notifyUnreadCount: number;
  isLocalFake: boolean;
  onToggleNotifications: () => void;
  onTogglePresence: () => void;
  onEndReception: () => void;
}) {
  // Availability is the server's reception intent; the label must still show a broken
  // message channel instead of claiming "可接待". Ending presence stays available so
  // the operator can clear a stale AVAILABLE row even while the IM channel reconnects.
  const runtime = presenceRuntimeState(
    presence.availability,
    connection,
    busy,
    presence.ownedByAnotherSession === true,
    presence.unbound === true,
    localLeader,
    presence.dispatchable !== false,
  );
  return <>
    <div className="im-wb-runtime">
      <ActionTooltip content={notifyPermission === "denied" ? "浏览器已屏蔽通知，请在站点设置中允许" : notifyEnabled && notifyPermission === "granted" ? "消息提醒已开启（需保持标签页打开）" : "开启浏览器通知与提示音"}>
        <button type="button" className="im-wb-btn im-wb-btn-icon im-wb-notify" data-action="toggle-notifications"
          data-state={notifyPermission === "denied" ? "denied" : notifyEnabled && notifyPermission === "granted" ? "on" : "prompt"}
          aria-label={notifyEnabled && notifyPermission === "granted" ? "关闭消息提醒" : "开启消息提醒"}
          onClick={onToggleNotifications}>
          {notifyPermission === "denied" || notifyPermission === "unsupported" ? <BellOff size={15} /> : <Bell size={15} />}
          {notifyUnreadCount > 0 ? <b className="im-wb-notify-count" aria-label={`${notifyUnreadCount} 条未读`}>{notifyUnreadCount > 99 ? "99+" : notifyUnreadCount}</b> : null}
        </button>
      </ActionTooltip>
      <span className="im-wb-runtime-divider" aria-hidden="true" />
      {canPresence ? <>
        <span className="im-wb-state im-wb-runtime-state" data-tone={runtime.tone}><i className={presence.availability === "AVAILABLE" && runtime.connected ? "on" : ""} />{runtime.label}</span>
        <span className="im-wb-runtime-divider" aria-hidden="true" />
        <TodayDuration seconds={presence.today?.seconds} active={canPresence && localLeader && presence.availability === "AVAILABLE" && !sessionLocked} />
        <ActionTooltip content={runtime.toggleTitle}><span className="im-wb-tooltip-anchor"><button type="button" className="im-wb-btn im-wb-btn-outline im-wb-presence-toggle im-wb-runtime-action" data-action="toggle-presence" onClick={onTogglePresence} disabled={runtime.toggleDisabled}>{runtime.toggleLabel}</button></span></ActionTooltip>
        {presence.availability === "AVAILABLE" && localLeader && (connection === "KICKED" || connection === "AUTH_FAILED")
          ? <button type="button" className="im-wb-btn im-wb-btn-outline im-wb-runtime-action" data-action="end-reception" onClick={onEndReception} disabled={busy}>结束接待</button>
          : null}
      </> : <span className="im-wb-state">无在线状态权限</span>}
      {connection !== "CONNECTED" ? <>
        <span className="im-wb-runtime-divider" aria-hidden="true" />
        <span className="im-wb-state im-wb-runtime-warning" data-tone="warn"><i />消息服务异常</span>
      </> : null}
    </div>
    {isLocalFake ? <span className="im-wb-state im-wb-local">本地测试</span> : null}
  </>;
}

/** 暂停/下线前的未完成会话清单：只提示与提供交接入口，不阻断暂停。 */
export function OffDutyDialog({ open, onOpenChange, consultations, canTransfer, busy, onGoTransfer, onConfirmPause }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consultations: Consultation[];
  canTransfer: boolean;
  busy: boolean;
  onGoTransfer: (consultationId: string) => void;
  onConfirmPause: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="im-wb-dialog" aria-label="暂停接待确认" showCloseButton={false}>
      <div className="im-wb-dialog-head"><div><strong>暂停接待</strong><span>还有 {consultations.length} 条未完成咨询</span></div>
        <ActionTooltip content="关闭暂停确认"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => onOpenChange(false)} aria-label="关闭暂停确认"><X size={14} /></button></ActionTooltip></div>
      <p className="im-wb-dialog-hint">暂停后不再接新会话，已有会话不会自动结束；你可以先逐条交接，也可以直接暂停。</p>
      <ul className="im-wb-offduty-list" aria-label="未完成咨询">
        {consultations.map((item) => <li key={item.id} data-consultation-id={item.id}>
          <div><strong>{item.user?.name || item.user?.username || "平台用户"}</strong><span>{typeLabel(item.type)} · {scopeStateLabel(item)}</span></div>
          <ActionTooltip content={!canTransfer ? "无转交权限" : item.messageScopeState !== "READY" ? "会话尚未就绪，暂不可转交" : undefined}><span className="im-wb-tooltip-anchor"><button type="button" className="im-wb-btn" data-action="offduty-transfer" disabled={!canTransfer || item.messageScopeState !== "READY" || busy}
            onClick={() => onGoTransfer(item.id)}>去交接</button></span></ActionTooltip>
        </li>)}
      </ul>
      <div className="im-wb-dialog-actions">
        <button type="button" className="im-wb-btn" onClick={() => onOpenChange(false)}>继续接待</button>
        <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-pause-presence" disabled={busy}
          onClick={onConfirmPause}>仍然暂停</button>
      </div>
    </DialogContent>
  </Dialog>;
}

/** 未开始接待时接入会 503；先给客服一个可操作的开始接待入口，而不是暴露请求编号。 */
export function ReceptionDialog({ open, onOpenChange, connection, busy, onStart }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: NimWebConnectionState | "idle" | "error";
  busy: boolean;
  onStart: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="im-wb-dialog" aria-label="需要先开始接待" showCloseButton={false}>
      <div className="im-wb-dialog-head"><div><strong>还不能接入会话</strong><span>当前未开始接待</span></div>
        <ActionTooltip content="关闭接待提醒"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => onOpenChange(false)} aria-label="关闭接待提醒"><X size={14} /></button></ActionTooltip></div>
      <p className="im-wb-dialog-hint">你当前还没有开始接待，直接接入会被服务端拒绝。先开始接待，平台会把你的状态更新为“可接待”，然后自动接入当前会话。</p>
      {connection !== "CONNECTED" ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />消息服务未连接，暂不能开始接待。</p> : null}
      <div className="im-wb-dialog-actions">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        <Button type="button" data-action="start-reception-and-claim" disabled={busy || connection !== "CONNECTED"} onClick={onStart}>开始接待并接入</Button>
      </div>
    </DialogContent>
  </Dialog>;
}