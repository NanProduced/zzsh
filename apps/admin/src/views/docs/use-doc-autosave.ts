import { useCallback, useEffect, useRef, useState } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import { isConflict, isForbidden, saveDocContent } from "./docs-api";
import { newWriteKey, normalizeRevision, type DocContentSaveResult } from "./docs-model";

/**
 * 内部文档自动保存：停顿 2s PUT content（expectedRevision 乐观锁）。
 * 同一时刻只有一个请求在飞，期间修改并入下一次；409 停自动保存进冲突态；
 * 其它失败指数退避重试 3 次（1s/2s/4s，重试复用同一 Idempotency-Key 与同一报文），
 * 仍失败提示「未保存，请复制内容后刷新」。beforeunload 只提示，不作保存保证。
 */

export type DocSavePhase = "idle" | "dirty" | "saving" | "saved" | "conflict" | "failed";

export type DocAutosaveOptions = {
  docId: string | null;
  enabled: boolean;
  onSaved?: (result: DocContentSaveResult) => void;
  onConflict?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** 测试 seam：生产默认 2000ms 停顿与 1000ms 退避基数。 */
  timings?: { debounceMs?: number; backoffBaseMs?: number };
};

const DIRTY_PHASES: ReadonlySet<DocSavePhase> = new Set(["dirty", "saving", "conflict", "failed"]);
const MAX_RETRIES = 3;

type Internal = {
  seq: number;
  docId: string | null;
  revision: string;
  latest: PlateDocumentEnvelope | null;
  savedSnapshot: PlateDocumentEnvelope | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  stopped: boolean;
  retries: number;
};

export function useDocAutosave(options: DocAutosaveOptions) {
  const { docId, enabled } = options;
  const debounceMs = options.timings?.debounceMs ?? 2000;
  const backoffBaseMs = options.timings?.backoffBaseMs ?? 1000;
  const [phase, setPhaseState] = useState<DocSavePhase>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ref = useRef<Internal>({ seq: 0, docId, revision: "", latest: null, savedSnapshot: null, timer: null, retryTimer: null, inFlight: false, stopped: false, retries: 0 });
  const callbacks = useRef(options);
  callbacks.current = options;

  const setPhase = useCallback((next: DocSavePhase, nextMessage: string | null = null) => {
    setPhaseState(next);
    setMessage(nextMessage);
    callbacks.current.onDirtyChange?.(DIRTY_PHASES.has(next));
  }, []);

  const clearTimers = useCallback(() => {
    const state = ref.current;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
  }, []);

  const startAttempt = useCallback(() => {
    const state = ref.current;
    const snapshot = state.latest;
    if (!snapshot || !state.docId || state.stopped || state.inFlight) return;
    if (snapshot === state.savedSnapshot) { setPhase("saved"); return; }
    const seq = state.seq;
    const current = () => ref.current.seq === seq && ref.current.docId === state.docId;
    const key = newWriteKey();
    const body = { expectedRevision: state.revision, document: snapshot };
    state.inFlight = true;
    setPhase("saving");
    const run = async (attemptKey: string, attemptBody: typeof body, attemptSnapshot: PlateDocumentEnvelope) => {
      try {
        const result = await saveDocContent(state.docId!, attemptBody, attemptKey);
        if (!current()) return;
        state.inFlight = false;
        state.retries = 0;
        state.revision = normalizeRevision(result.revision);
        state.savedSnapshot = attemptSnapshot;
        setSavedAt(result.savedAt);
        callbacks.current.onSaved?.(result);
        if (state.latest !== attemptSnapshot) { startAttempt(); return; }
        setPhase("saved");
      } catch (failure) {
        if (!current()) return;
        state.inFlight = false;
        if (isConflict(failure)) {
          state.stopped = true;
          clearTimers();
          setPhase("conflict", "别人刚改过，刷新后再改");
          callbacks.current.onConflict?.();
          return;
        }
        if (isForbidden(failure)) {
          state.stopped = true;
          clearTimers();
          setPhase("failed", "没有权限");
          return;
        }
        state.retries += 1;
        if (state.retries <= MAX_RETRIES) {
          setPhase("saving", `保存失败，正在重试（${state.retries}/${MAX_RETRIES}）…`);
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            if (!current() || state.stopped) return;
            if (state.latest !== attemptSnapshot) { startAttempt(); return; }
            state.inFlight = true;
            void run(attemptKey, attemptBody, attemptSnapshot);
          }, backoffBaseMs * 2 ** (state.retries - 1));
          return;
        }
        state.stopped = true;
        setPhase("failed", "未保存，请复制内容后刷新");
      }
    };
    void run(key, body, snapshot);
  }, [backoffBaseMs, clearTimers, setPhase]);

  const schedule = useCallback((document: PlateDocumentEnvelope) => {
    const state = ref.current;
    if (!enabled || state.stopped || !state.docId) return;
    state.latest = document;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; state.retries = 0; }
    if (!state.inFlight) setPhase("dirty");
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (ref.current.stopped) return;
      if (ref.current.inFlight) return; // 在飞期间的修改并入下一次：run 完成后检测 latest 变化自动续发。
      startAttempt();
    }, debounceMs);
  }, [debounceMs, enabled, setPhase, startAttempt]);

  /** 详情加载 / 冲突后刷新：重置到服务端最新 revision，清空本地待保存态。 */
  const reset = useCallback((revision: string, at?: string | null) => {
    const state = ref.current;
    state.seq += 1;
    clearTimers();
    state.docId = docId;
    state.revision = normalizeRevision(revision);
    state.latest = null;
    state.savedSnapshot = null;
    state.inFlight = false;
    state.stopped = false;
    state.retries = 0;
    setSavedAt(at ?? null);
    setPhase(at ? "saved" : "idle");
  }, [clearTimers, docId, setPhase]);

  /** 改名 / 移动 / 回滚等其它写成功后采纳新 revision，不触发内容保存。 */
  const adoptRevision = useCallback((revision: string) => {
    ref.current.revision = normalizeRevision(revision);
  }, []);

  /** 其它写接口收到 409：与内容保存冲突同一处置。 */
  const conflict = useCallback(() => {
    const state = ref.current;
    state.stopped = true;
    clearTimers();
    setPhase("conflict", "别人刚改过，刷新后再改");
    callbacks.current.onConflict?.();
  }, [clearTimers, setPhase]);

  useEffect(() => {
    const state = ref.current;
    state.docId = docId;
    state.seq += 1;
    clearTimers();
    state.latest = null;
    state.savedSnapshot = null;
    state.inFlight = false;
    state.stopped = false;
    state.retries = 0;
    setSavedAt(null);
    setPhase("idle");
  }, [docId, clearTimers, setPhase]);

  useEffect(() => () => {
    ref.current.seq += 1;
    clearTimers();
    callbacks.current.onDirtyChange?.(false);
  }, [clearTimers]);

  useEffect(() => {
    if (!DIRTY_PHASES.has(phase)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  return {
    phase,
    savedAt,
    message,
    schedule,
    reset,
    adoptRevision,
    conflict,
    getRevision: () => ref.current.revision,
    hasPendingChanges: () => ref.current.inFlight || ref.current.latest !== ref.current.savedSnapshot,
    localDocument: () => ref.current.latest,
  };
}
