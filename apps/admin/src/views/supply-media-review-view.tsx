import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SupplyWriteLockError, withSupplyWriteLock } from "@/lib/supply-write-lock";
import { cn } from "@/lib/utils";

import { adminRequest, friendlyError, hasPermission, type MediaAssetReview, type MediaReviewPage, type SessionSnapshot, type SupplyGame, type UploadedAssetResponse } from "../api";
import { Lightbox } from "./supply-review/lightbox";
import { type ZoomTarget } from "./supply-review/model";
import { MediaDetailPanel } from "./supply-media/detail-panel";
import {
  actionsFor,
  isExemptReview,
  OWNERSHIP_LABELS,
  PURPOSE_LABELS,
  queueParams,
  REVIEWED_STATES,
  reviewReasonError,
  STATE_LABELS,
  visibilityReasonError,
  type MediaAction,
  type OwnershipFilter,
  type QueueState,
  type ReviewTab,
  type ReviewedState,
  type UploadPurpose,
} from "./supply-media/model";
import { UploadMediaDialog, emptyUploadDialog, type UploadDialogState } from "./supply-media/upload-dialog";
import {
  classifyWriteError,
  clearRecordIfMatch,
  isUploadRecord,
  loadRecord,
  newIdempotencyKey,
  PersistBlockedError,
  readOperationResult,
  recoveryQuery,
  requestFingerprint,
  saveRecord,
  sameRecord,
  storageKey,
  uploadBytesFingerprint,
  uploadIntentFingerprint,
  verifyRecordIntegrity,
  type SimpleWriteKind,
  type SimpleWriteRecord,
  type UploadWriteRecord,
  type WriteRecord,
} from "./supply-media/write-intent";
import { MediaAbandonSheet, MediaConfirmDialog, MediaNarrowDetailDialog } from "./supply-media-review-dialogs";
import { MediaReviewHeader } from "./supply-media-review-header";
import { MediaReviewQueue } from "./supply-media-review-queue";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

const API_UPLOADS = "/api/bff/admin/supply/media/uploads";
const isReviewState = (value: unknown): value is MediaAssetReview["reviewState"] => value === "PENDING" || REVIEWED_STATES.some((state) => state === value);

function useIsWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1280px)");
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    mql.addEventListener("change", onChange);
    setWide(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return wide;
}


const lockNotice = (failure: unknown): string =>
  failure instanceof SupplyWriteLockError
    ? failure.message
    : failure instanceof PersistBlockedError
      ? "本地无法保存操作意图，操作未发送；请检查浏览器存储后重试。"
    : "写入锁异常，操作未发送；请稍后重试。";

type ReviewScope = "all" | "reviewable" | "exempt";

export type Props = {
  snapshot: Snapshot;
  refreshNonce?: number;
  onOpenPath?: (path: string) => void;
};

export function SupplyMediaReviewView({
  snapshot,
  refreshNonce = 0,
  onOpenPath,
}: Props) {
  const canRead = hasPermission(snapshot, "supply.review.read");
  const canDecide = hasPermission(snapshot, "supply.review.decide");
  const canUpload = hasPermission(snapshot, "supply.catalog.manage");
  const wide = useIsWide();

  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesState, setGamesState] = useState<"loading" | "ok" | "failed">("loading");
  const [tab, setTab] = useState<ReviewTab>("pending");
  const [reviewedState, setReviewedState] = useState<ReviewedState>("APPROVED");
  const [ownershipKind, setOwnershipKind] = useState<OwnershipFilter>("PLATFORM_CATALOG");
  const [pageView, setPageView] = useState<{ key: string; data: MediaReviewPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<MediaAssetReview | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<ZoomTarget | undefined>(undefined);
  const [uploadState, setUploadState] = useState<UploadDialogState>(emptyUploadDialog);
  const [writeRecord, setWriteRecord] = useState<WriteRecord | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(true);
  const [storedProblem, setStoredProblem] = useState<"corrupt" | "foreign" | null>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ asset: MediaAssetReview; action: MediaAction } | null>(null);
  const [unresolvedNotice, setUnresolvedNotice] = useState<string | null>(null);

  const writeBusyRef = useRef(false);
  const writeSeq = useRef(0);
  const loadSeq = useRef(0);
  const cursorStack = useRef<string[]>([""]);
  const uploadMemory = useRef<{ intentId: string; token: string; file: File } | null>(null);
  const filterKeyRef = useRef("");
  const scopeRef = useRef("");
  const mountedRef = useRef(true);
  const problemRecordRef = useRef<{ raw: string | null; readable: boolean } | null>(null);
  const headingRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [asideHeight, setAsideHeight] = useState<number>();

  const queueState: QueueState = tab === "pending" ? "PENDING" : reviewedState;
  const filterKey = `${snapshot.adminUserId}|${snapshot.session.id}|${queueState}|${ownershipKind}`;
  const writeScope = JSON.stringify([snapshot.adminUserId, snapshot.session.id, snapshot.session.locked, snapshot.security.status, snapshot.permissions.slice().sort()]);
  scopeRef.current = writeScope;
  filterKeyRef.current = filterKey;
  const gameNames = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const page = pageView && pageView.key === filterKey ? pageView.data : null;
  const [reviewScope, setReviewScope] = useState<ReviewScope>("all");
  const pageItems = page?.items ?? [];
  const reviewableCount = pageItems.filter((asset) => actionsFor(asset, { canDecide, canUpload }).actions.length > 0).length;
  const exemptCount = pageItems.filter(isExemptReview).length;
  const visibleItems = reviewScope === "all"
    ? pageItems
    : pageItems.filter((asset) => reviewScope === "exempt" ? isExemptReview(asset) : actionsFor(asset, { canDecide, canUpload }).actions.length > 0);
  const scopeLabel = reviewScope === "reviewable" ? "可审核" : reviewScope === "exempt" ? "免审核对" : "全部";
  const [pageIndex, setPageIndex] = useState(0);
  const pageIndexRef = useRef(0);
  const reasonFor = (asset: MediaAssetReview) => reasons[asset.id] ?? "";
  const setReasonFor = (asset: MediaAssetReview, value: string) => setReasons((current) => ({ ...current, [asset.id]: value }));
  // 异步读取在调用时取游标，避免过期闭包翻错页。
  const cursorNow = () => cursorStack.current[pageIndexRef.current] || undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; writeSeq.current += 1; loadSeq.current += 1; };
  }, []);

  useEffect(() => {
    if (!wide || !asideRef.current) return;
    const measure = () => {
      const top = asideRef.current?.getBoundingClientRect().top;
      if (top !== undefined) setAsideHeight(Math.max(0, window.innerHeight - Math.max(8, top) - 16));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (headingRef.current) observer?.observe(headingRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [wide, selected?.id, writeRecord, storedProblem, notice]);

  /* ---------- 读取（绑定 actor/session/filterKey，过期闭包不发请求） ---------- */

  const loadGames = useCallback(async () => {
    setGamesState("loading");
    try {
      const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
      if (!result || !Array.isArray(result.games) || result.games.some((game) => !game || typeof game.id !== "string" || !game.id || typeof game.name !== "string")) throw new Error("游戏目录返回格式无效");
      setGames(result.games);
      setGamesState("ok");
    } catch {
      setGames([]);
      setGamesState("failed");
    }
  }, []);

  const loadQueue = useCallback(async (cursor?: string, syncSelection = false): Promise<MediaReviewPage | null> => {
    const boundKey = filterKey;
    const boundScope = writeScope;
    if (!mountedRef.current || filterKeyRef.current !== boundKey || scopeRef.current !== boundScope) return null;
    const seq = ++loadSeq.current;
    setLoading(true);
    setListError(null);
    try {
      const params = queueParams({ state: queueState, ownershipKind, cursor, limit: 20 });
      const query = new URLSearchParams({ state: params.state, ownershipKind: params.ownershipKind, limit: String(params.limit) });
      if (params.cursor) query.set("cursor", params.cursor);
      const result = await adminRequest<MediaReviewPage>(`/supply/media/reviews?${query.toString()}`);
      if (!result || !Array.isArray(result.items) || result.items.some((item) => !item || typeof item.id !== "string" || typeof item.gameId !== "string") || (result.nextCursor !== null && typeof result.nextCursor !== "string")) throw new Error("素材队列返回格式无效");
      if (seq !== loadSeq.current || filterKeyRef.current !== boundKey || scopeRef.current !== boundScope) return null;
      setPageView({ key: boundKey, data: result });
      if (syncSelection) {
        // 目标不在当前结果时丢弃旧详情，不把旧状态称最新。
        setSelected((previous) => {
          if (!previous) return null;
          const fresh = result.items.find((item) => item.id === previous.id);
          return fresh ?? null;
        });
      }
      return result;
    } catch (failure) {
      if (seq !== loadSeq.current || filterKeyRef.current !== boundKey) return null;
      const status = failure && typeof failure === "object" && "status" in failure ? failure.status : null;
      if (status === 401 || status === 403 || status === 404) { setSelected(null); setPageView(null); setZoom(undefined); setConfirm(null); }
      setListError(`素材队列读取失败：${friendlyError(failure)}`);
      return null;
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filterKey, writeScope, queueState, ownershipKind]);

  useEffect(() => {
    if (!canRead) return;
    void loadGames();
  }, [canRead, loadGames]);

  useEffect(() => {
    if (!canRead) return;
    setSelected(null);
    setPageView(null);
    setReviewScope("all");
    cursorStack.current = [""];
    pageIndexRef.current = 0;
    setPageIndex(0);
    void loadQueue(undefined);
  }, [canRead, filterKey, loadQueue, refreshNonce]);

  useEffect(() => {
    if (!canRead) {
      setGames([]);
      setPageView(null);
      setSelected(null);
    }
  }, [canRead]);

  /* ---------- 写意图：共同临界区与作用域 ---------- */

  const isCurrentWrite = useCallback((seq: number) => mountedRef.current && writeSeq.current === seq && scopeRef.current === writeScope, [writeScope]);
  const markStoredProblem = useCallback((reason: "corrupt" | "foreign") => {
    try { problemRecordRef.current = { raw: window.localStorage.getItem(storageKey(snapshot.adminUserId)), readable: true }; }
    catch { problemRecordRef.current = { raw: null, readable: false }; }
    setStoredProblem(reason);
  }, [snapshot.adminUserId]);

  // 初次摘要、保存与清理都在同一锁内；恢复使用存储中的当前阶段，不信旧闭包。
  const withRecordLock = useCallback(async (seq: number, expected: WriteRecord | null, task: (current: WriteRecord | null) => Promise<void>) => {
    await withSupplyWriteLock(storageKey(snapshot.adminUserId), async () => {
      if (!isCurrentWrite(seq)) return;
      const stored = loadRecord(snapshot.adminUserId);
      if (!stored.ok && stored.reason !== "missing") {
        markStoredProblem(stored.reason);
        setNotice("本地恢复记录已损坏或不属于当前身份，操作未发送；原请求需先核对。");
        return;
      }
      if (stored.ok && await verifyRecordIntegrity(stored.record) !== "ok") {
        if (isCurrentWrite(seq)) { markStoredProblem("corrupt"); setNotice("原请求摘要与恢复记录不一致，已阻止操作；不会覆盖原记录。"); }
        return;
      }
      if (!isCurrentWrite(seq)) return;
      if (expected ? !stored.ok || !sameRecord(stored.record, expected) : stored.ok) {
        if (!expected && stored.ok) setWriteRecord(stored.record);
        setRecoveryChecked(true);
        setNotice("本地原记录已变化，本次操作未发送；请核对原窗口与原请求，不会覆盖或清除当前记录。");
        return;
      }
      await task(stored.ok ? stored.record : null);
    });
  }, [snapshot.adminUserId, isCurrentWrite, markStoredProblem]);

  const retainRecord = useCallback((seq: number, record: WriteRecord, message: string) => {
    if (!isCurrentWrite(seq)) return;
    let persisted = true;
    try { saveRecord(record); } catch { persisted = false; }
    setWriteRecord(record);
    setRecoveryChecked(true);
    setNotice(persisted ? message : `${message} 本地记录无法更新，请保留当前窗口；先前保存的原请求仍需核对。`);
  }, [isCurrentWrite]);

  const resolveRecord = useCallback((seq: number, record: WriteRecord, message: string): boolean => {
    if (!isCurrentWrite(seq)) return false;
    if (!clearRecordIfMatch(record.adminId, record)) {
      setRecoveryChecked(true);
      setNotice("原命令已确认，但本地记录未能匹配清理；请核对当前记录，不会清除另一请求。");
      return false;
    }
    setWriteRecord(null);
    setRecoveryChecked(true);
    setNotice(message);
    if (isUploadRecord(record)) {
      uploadMemory.current = null;
      setUploadState((current) => ({ ...current, step: "done", stepState: { intent: "done", bytes: "done", readback: "done" }, message, error: null }));
    }
    return true;
  }, [isCurrentWrite]);

  const nonemptyId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  const simpleReceiptMatches = (record: SimpleWriteRecord, result: Record<string, unknown>) => record.kind === "cover"
    ? result.gameId === record.targetId
    : result.id === record.targetId;
  const byteReceiptMatches = (record: UploadWriteRecord, result: Record<string, unknown>) => nonemptyId(result.assetId) && (!record.resultAssetId || result.assetId === record.resultAssetId);

  const finishUploadStage = useCallback(async (seq: number, record: UploadWriteRecord, assetId: string) => {
    if (!isCurrentWrite(seq)) return;
    const accepted: UploadWriteRecord = { ...record, resultAssetId: assetId, bytes: { ...record.bytes, status: "accepted" }, phase: "accepted_readback" };
    saveRecord(accepted);
    setWriteRecord(accepted);
    setUploadState((current) => ({ ...current, step: "readback", stepState: { intent: "done", bytes: "done", readback: "active" }, message: "字节原回执已确认；正在读取最新队列…", error: null }));
    const ok = await loadQueue(undefined, true);
    if (!isCurrentWrite(seq)) return;
    if (ok) resolveRecord(seq, accepted, `素材 ${assetId} 已上传并进入待审核；上传时默认私有，字节回执与最新队列均已确认。`);
    else {
      setRecoveryChecked(true);
      setNotice("字节上传已确认，最新状态未确认：队列回读失败或读取范围已变化；可重新读取，不会重复上传。");
      setUploadState((current) => ({ ...current, step: "readback", stepState: { intent: "done", bytes: "done", readback: "failed" }, message: "字节上传已确认，最新状态未确认：队列回读失败或读取范围已变化；请重新读取，不会重复上传。", error: null }));
    }
  }, [isCurrentWrite, loadQueue, resolveRecord]);

  /* ---------- 恢复：只查原回执，不以列表证明写入 ---------- */

  const runRecoveryCheck = useCallback(async (expected: WriteRecord) => {
    if (!mountedRef.current || writeBusyRef.current || storedProblem) return;
    const seq = ++writeSeq.current;
    writeBusyRef.current = true;
    setWriteBusy(true);
    setRecoveryChecked(false);
    try {
      await withRecordLock(seq, expected, async (current) => {
        if (!current) return;
        let record = current;
        if (record.phase === "sending") { record = { ...record, phase: "unknown" }; saveRecord(record); setWriteRecord(record); }
        if (isUploadRecord(record)) {
          if (record.intent.status === "accepted") {
            if (!record.bytes.fingerprint) {
              setRecoveryChecked(true);
              setNotice("上传意图已建立，字节尚未发送，上传未完成；不生成新上传冒充恢复。");
              return;
            }
            const result = await readOperationResult({ operation: "supply.media.upload", resourceId: record.intent.intentId!, fingerprint: record.bytes.fingerprint, key: record.bytes.key });
            if (!isCurrentWrite(seq)) return;
            if (result.receipt === "RECORDED" && result.responseStatus >= 200 && result.responseStatus < 300 && result.echoOperation === "supply.media.upload" && result.echoResourceId === record.intent.intentId && byteReceiptMatches(record, result.result)) {
              await finishUploadStage(seq, record, result.result.assetId as string);
            } else {
              setRecoveryChecked(true);
              setNotice(result.receipt === "RECORDED" ? "字节回执的阶段、目标或素材ID不匹配，上传结果仍待核；原记录未清除。" : "未查到可确认的字节原回执，上传结果仍待核；未查到不等于未执行。");
            }
            return;
          }
          if (!record.intent.fingerprint) { setRecoveryChecked(true); return; }
          const result = await readOperationResult({ operation: "supply.media.upload_intent.create", fingerprint: record.intent.fingerprint, key: record.intent.key });
          if (!isCurrentWrite(seq)) return;
          if (result.receipt === "RECORDED" && result.responseStatus >= 200 && result.responseStatus < 300 && result.echoOperation === "supply.media.upload_intent.create" && result.echoResourceId === null && nonemptyId(result.result.intentId) && (!record.intent.intentId || result.result.intentId === record.intent.intentId)) {
            const updated: UploadWriteRecord = { ...record, intent: { ...record.intent, status: "accepted", intentId: result.result.intentId }, phase: "unknown" };
            saveRecord(updated);
            setWriteRecord(updated);
            setRecoveryChecked(true);
            setNotice("上传意图已确认建立，字节尚未上传，上传未完成；只可继续原上传或显式结束恢复。");
          } else {
            setRecoveryChecked(true);
            setNotice(result.receipt === "RECORDED" ? "意图回执的阶段或目标不匹配，原结果仍待核；不会当成字节完成。" : "上传意图原回执尚未确认；未查到不等于未执行。");
          }
          return;
        }
        if (record.phase === "accepted_readback" && !record.recoverable) {
          const ok = await loadQueue(cursorNow(), true);
          if (!isCurrentWrite(seq)) return;
          if (ok) resolveRecord(seq, record, "此前写回执已受理，最新队列已读取；该操作没有独立原结果读取合同。");
          else { setRecoveryChecked(true); setNotice("此前写回执已受理，最新队列未确认；请重新读取，不重复提交。"); }
          return;
        }
        const query = recoveryQuery(record);
        if (!query) { setRecoveryChecked(true); return; }
        const result = await readOperationResult(query);
        if (!isCurrentWrite(seq)) return;
        if (result.receipt === "RECORDED" && result.responseStatus >= 200 && result.responseStatus < 300 && result.echoOperation === record.operation && result.echoResourceId === record.targetId && simpleReceiptMatches(record, result.result)) {
          const accepted: SimpleWriteRecord = { ...record, phase: "accepted_readback" };
          saveRecord(accepted);
          setWriteRecord(accepted);
          setSelected((previous) => previous?.id === record.targetId ? { ...previous, reviewState: isReviewState(result.result.reviewState) ? result.result.reviewState : previous.reviewState, accessClass: result.result.accessClass === "PUBLIC_DISPLAY" || result.result.accessClass === "PRIVATE_REVIEW" ? result.result.accessClass : previous.accessClass } : previous);
          const ok = await loadQueue(cursorNow(), true);
          if (!isCurrentWrite(seq)) return;
          if (ok) resolveRecord(seq, accepted, `${record.targetLabel}：原命令回执已确认成功，最新队列已读取。`);
          else { setRecoveryChecked(true); setNotice("原命令回执已确认成功，最新状态回读失败或读取范围已变化；可重新读取，不重复提交。"); }
        } else {
          setRecoveryChecked(true);
          setNotice(result.receipt === "RECORDED" ? "恢复回执与原命令不匹配，原结果仍待核；原记录未清除。" : "原回执尚未确认；未查到不等于未执行，原key与原体继续保留。");
        }
      });
    } catch (failure) {
      if (isCurrentWrite(seq)) { setRecoveryChecked(true); setNotice(failure instanceof SupplyWriteLockError ? failure.message : `原结果恢复读取失败：${friendlyError(failure)} 原key与原体仍保留。`); }
    } finally {
      if (isCurrentWrite(seq)) { writeBusyRef.current = false; setWriteBusy(false); }
    }
  }, [storedProblem, withRecordLock, isCurrentWrite, finishUploadStage, loadQueue, resolveRecord]);

  useEffect(() => {
    if (!canRead) return;
    const stored = loadRecord(snapshot.adminUserId);
    if (stored.ok) { setWriteRecord(stored.record); void runRecoveryCheck(stored.record); }
    else if (stored.reason !== "missing") markStoredProblem(stored.reason);
    // 恢复只从本次挂载的原记录开始；阶段更新必须在共同锁内。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!writeRecord && !writeBusy && !storedProblem) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [writeRecord, writeBusy, storedProblem]);

  /* ---------- 审核、公开、封面：新命令与原key重放 ---------- */

  const runWrite = useCallback(async (expected: SimpleWriteRecord | null, create?: () => Promise<SimpleWriteRecord>) => {
    if (!mountedRef.current || scopeRef.current !== writeScope || writeBusyRef.current || storedProblem) return;
    const seq = ++writeSeq.current;
    writeBusyRef.current = true;
    setWriteBusy(true);
    setNotice(null);
    try {
      await withRecordLock(seq, expected, async (current) => {
        const record = current && !isUploadRecord(current) ? current : create ? await create() : null;
        if (!record || !isCurrentWrite(seq)) return;
        const wasUnknown = record.phase === "unknown" || record.phase === "accepted_readback";
        const sending: SimpleWriteRecord = { ...record, phase: "sending" };
        saveRecord(sending);
        setWriteRecord(sending);
        try {
          const path = record.kind === "cover" ? `/supply/games/${record.targetId}/cover` : `/supply/media/${record.targetId}/${record.kind}`;
          const receipt = await adminRequest<Record<string, unknown>>(path, record.body, record.kind === "cover" ? "PUT" : "POST", { "idempotency-key": record.key });
          if (!isCurrentWrite(seq)) return;
          if (!receipt || !simpleReceiptMatches(record, receipt)) {
            retainRecord(seq, { ...sending, phase: "unknown" }, "写回执的目标不匹配或标识缺失，原命令结果未知；原key与原体仍保留。");
            return;
          }
          const accepted: SimpleWriteRecord = { ...sending, phase: "accepted_readback" };
          saveRecord(accepted);
          setWriteRecord(accepted);
          if (record.kind !== "cover") setSelected((previous) => previous?.id === record.targetId ? { ...previous, reviewState: isReviewState(receipt.reviewState) ? receipt.reviewState : previous.reviewState, accessClass: receipt.accessClass === "PUBLIC_DISPLAY" || receipt.accessClass === "PRIVATE_REVIEW" ? receipt.accessClass : previous.accessClass, reviewReason: typeof receipt.reviewReason === "string" || receipt.reviewReason === null ? receipt.reviewReason : previous.reviewReason } : previous);
          const ok = await loadQueue(cursorNow(), record.kind !== "review");
          if (!isCurrentWrite(seq)) return;
          if (ok) resolveRecord(seq, accepted, `${record.targetLabel}：${record.kind === "review" ? "审核决定" : record.kind === "visibility" ? "可见性变更" : "封面关联"}已成功。`);
          else { setRecoveryChecked(true); setNotice(`${record.targetLabel}：原写回执已受理，最新队列读取未确认；可重新读取，不重复提交。`); }
        } catch (failure) {
          if (!isCurrentWrite(seq)) return;
          if (classifyWriteError(failure, wasUnknown) === "unknown") retainRecord(seq, { ...sending, phase: "unknown" }, `${record.targetLabel}：请求结果未知，不能当作未执行；原key与原体保留，只能核对或按原请求重放。`);
          else resolveRecord(seq, sending, `${record.targetLabel}：${friendlyError(failure)}`);
        }
      });
    } catch (failure) { if (isCurrentWrite(seq)) setNotice(lockNotice(failure)); }
    finally { if (isCurrentWrite(seq)) { writeBusyRef.current = false; setWriteBusy(false); } }
  }, [writeScope, storedProblem, withRecordLock, isCurrentWrite, loadQueue, resolveRecord, retainRecord]);

  const startSimpleWrite = useCallback(async (action: MediaAction, asset: MediaAssetReview) => {
    if (writeRecord || storedProblem) return;
    const reasonText = reasonFor(asset).trim();
    const problem = action.kind === "review" ? reviewReasonError(asset, action.decision, reasonText) : action.kind === "visibility" ? visibilityReasonError(reasonText) : null;
    if (problem) { setNotice(problem); return; }
    const kind: SimpleWriteKind = action.kind;
    const body = action.kind === "review" ? { decision: action.decision, ...(reasonText ? { reason: reasonText } : {}), visibility: "PRIVATE_REVIEW" }
      : action.kind === "visibility" ? { visibility: action.visibility, ...(reasonText ? { reason: reasonText } : {}) } : { mediaId: asset.id };
    const operation = kind === "cover" ? "supply.game.cover" : `supply.media.${kind}`;
    const targetId = kind === "cover" ? asset.gameId : asset.id;
    await runWrite(null, async () => ({
      v: 1, kind, adminId: snapshot.adminUserId, sessionId: snapshot.session.id, operation, targetId,
      targetLabel: `${PURPOSE_LABELS[asset.purpose] ?? asset.purpose} ${asset.id}`, gameId: asset.gameId, body,
      key: newIdempotencyKey(), fingerprint: await requestFingerprint(operation, targetId, body), phase: "sending",
      recoverable: true,
      createdAt: new Date().toISOString(),
    }));
  }, [writeRecord, storedProblem, reasonFor, snapshot, runWrite]);

  /* ---------- 上传：同锁、原文件、双阶段原回执 ---------- */

  const runUploadCommand = useCallback(async (input: { gameId: string; purpose: UploadPurpose; file: File } | null) => {
    if (!mountedRef.current || scopeRef.current !== writeScope || writeBusyRef.current || storedProblem || (input && writeRecord)) return;
    const expected = input ? null : writeRecord && isUploadRecord(writeRecord) ? writeRecord : null;
    if (!input && !expected) return;
    const seq = ++writeSeq.current;
    writeBusyRef.current = true;
    setWriteBusy(true);
    try {
      await withRecordLock(seq, expected, async (current) => {
        let record = current && isUploadRecord(current) ? current : null;
        if (!record && input) {
          record = { v: 1, kind: "upload", adminId: snapshot.adminUserId, sessionId: snapshot.session.id, targetLabel: `${PURPOSE_LABELS[input.purpose]} ${input.file.name}`, gameId: input.gameId, purpose: input.purpose,
            file: { name: input.file.name, size: input.file.size, mime: input.file.type }, intent: { key: newIdempotencyKey(), fingerprint: null, status: "idle", intentId: null }, bytes: { key: newIdempotencyKey(), fingerprint: null, status: "idle" }, phase: "idle", recoverable: true, createdAt: new Date().toISOString() };
          uploadMemory.current = { intentId: "", token: "", file: input.file };
        }
        if (!record) return;
        const wasUnknown = record.phase === "unknown" || record.phase === "accepted_readback";
        if (record.bytes.status === "accepted") { setNotice("字节已经受理，只能核对原回执与重新读取队列，不重复发送字节。"); return; }
        const confirmedIntent = record.intent.status === "accepted";
        const needsToken = confirmedIntent && uploadMemory.current?.file && (!uploadMemory.current.token || uploadMemory.current.intentId !== record.intent.intentId);
        if (!confirmedIntent || needsToken) {
          setUploadState((currentState) => ({ ...currentState, step: "intent", stepState: { ...currentState.stepState, intent: "active" }, error: null, message: null }));
          const fingerprint = await uploadIntentFingerprint({ gameId: record.gameId, purpose: record.purpose, mime: record.file.mime, size: record.file.size });
          if (!isCurrentWrite(seq)) return;
          const sending: UploadWriteRecord = { ...record, intent: { ...record.intent, fingerprint, status: confirmedIntent ? "accepted" : "sending" }, phase: "sending" };
          saveRecord(sending);
          record = sending;
          setWriteRecord(record);
          try {
            const intent = await adminRequest<{ intentId: string; uploadToken: string }>("/supply/media/upload-intents", { gameId: record.gameId, purpose: record.purpose, mime: record.file.mime, size: record.file.size }, "POST", { "idempotency-key": record.intent.key });
            if (!isCurrentWrite(seq)) return;
            if (!intent || !nonemptyId(intent.intentId) || typeof intent.uploadToken !== "string" || !intent.uploadToken || (record.intent.intentId && intent.intentId !== record.intent.intentId)) throw new Error("上传意图回执不匹配");
            const accepted: UploadWriteRecord = { ...record, intent: { ...record.intent, status: "accepted", intentId: intent.intentId } };
            saveRecord(accepted);
            record = accepted;
            setWriteRecord(record);
            if (uploadMemory.current) uploadMemory.current = { ...uploadMemory.current, intentId: intent.intentId, token: intent.uploadToken };
          } catch (failure) {
            if (!isCurrentWrite(seq)) return;
            if (classifyWriteError(failure, wasUnknown) === "unknown") {
              retainRecord(seq, { ...record, intent: { ...record.intent, status: confirmedIntent ? "accepted" : "unknown" }, phase: "unknown" }, confirmedIntent ? "原意图已确认，但凭据回执未取得；保留原key与原文件，不新建上传。" : "上传意图结果未知，原key与声明保留；不新建上传冒充恢复。");
              setUploadState((state) => ({ ...state, step: "intent", stepState: { ...state.stepState, intent: confirmedIntent ? "done" : "unknown" }, error: "上传意图凭据回执未确认；仅可核对或按原请求重试。" }));
            } else {
              if (clearRecordIfMatch(record.adminId, record)) { setWriteRecord(null); uploadMemory.current = null; }
              setUploadState((state) => ({ ...state, step: "select", stepState: { intent: "failed", bytes: "idle", readback: "idle" }, error: friendlyError(failure) }));
            }
            return;
          }
        }
        const mem = uploadMemory.current;
        if (!mem || !mem.file.size || !mem.token || mem.intentId !== record.intent.intentId) {
          retainRecord(seq, { ...record, phase: "unknown" }, "上传文件或凭据未保留，字节不能继续；上传未完成，原意图仍保留，不自动重建。");
          setUploadState((state) => ({ ...state, step: "bytes", stepState: { ...state.stepState, intent: "done", bytes: record!.bytes.fingerprint ? "unknown" : "idle" }, error: "刷新后文件与凭据不保留；原结果待核，不生成新上传。" }));
          return;
        }
        if (mem.file.name !== record.file.name || mem.file.size !== record.file.size || mem.file.type !== record.file.mime) { markStoredProblem("corrupt"); return; }
        setUploadState((state) => ({ ...state, step: "bytes", stepState: { intent: "done", bytes: "active", readback: "idle" }, error: null }));
        const fingerprint = await uploadBytesFingerprint(mem.intentId, mem.token, new Uint8Array(await mem.file.arrayBuffer()));
        if (!isCurrentWrite(seq)) return;
        if (record.bytes.fingerprint && record.bytes.fingerprint !== fingerprint) { markStoredProblem("corrupt"); setNotice("原文件字节与原请求摘要不一致，已阻止续传。"); return; }
        const sending: UploadWriteRecord = { ...record, bytes: { ...record.bytes, fingerprint, status: "sending" }, phase: "sending" };
        saveRecord(sending);
        record = sending;
        setWriteRecord(record);
        try {
          const response = await fetch(`${API_UPLOADS}/${encodeURIComponent(record.intent.intentId!)}`, { method: "PUT", credentials: "include", headers: { "content-type": record.file.mime, "x-upload-token": mem.token, "idempotency-key": record.bytes.key }, body: mem.file });
          const payload = await response.json().catch(() => null) as (UploadedAssetResponse & { error?: { code?: string } }) | null;
          if (!isCurrentWrite(seq)) return;
          if (!response.ok) {
            if (classifyWriteError({ status: response.status, code: payload?.error?.code ?? "ERR" }, wasUnknown) !== "unknown") {
              if (clearRecordIfMatch(record.adminId, record)) { setWriteRecord(null); uploadMemory.current = null; }
              setUploadState((state) => ({ ...state, step: "select", stepState: { intent: "done", bytes: "failed", readback: "idle" }, error: "字节上传未受理，请检查文件及权限。" }));
              return;
            }
            throw new Error("字节结果待核");
          }
          if (!payload || !byteReceiptMatches(record, payload) || (payload.gameId !== undefined && payload.gameId !== record.gameId) || (payload.purpose !== undefined && payload.purpose !== record.purpose) || (payload.mime !== undefined && payload.mime !== record.file.mime) || (payload.byteSize !== undefined && payload.byteSize !== record.file.size)) throw new Error("字节回执不匹配");
          await finishUploadStage(seq, record, payload.assetId);
        } catch {
          if (!isCurrentWrite(seq)) return;
          retainRecord(seq, { ...record, bytes: { ...record.bytes, status: "unknown" }, phase: "unknown" }, "字节回执未确认或不匹配，上传结果未知；原意图、原key与原文件继续保留。");
          setUploadState((state) => ({ ...state, step: "bytes", stepState: { intent: "done", bytes: "unknown", readback: "idle" }, error: "字节上传结果未知，只可核对或按原请求重试；不能当成未执行。" }));
        }
      });
    } catch (failure) {
      if (isCurrentWrite(seq)) {
        setNotice(lockNotice(failure));
        setUploadState((state) => ({ ...state, step: expected ? state.step : "select", stepState: expected ? state.stepState : { intent: "idle", bytes: "idle", readback: "idle" }, error: lockNotice(failure) }));
      }
    } finally { if (isCurrentWrite(seq)) { writeBusyRef.current = false; setWriteBusy(false); } }
  }, [writeScope, storedProblem, writeRecord, snapshot, withRecordLock, isCurrentWrite, retainRecord, finishUploadStage, markStoredProblem]);

  const replayWrite = useCallback(async () => {
    if (!writeRecord || writeBusyRef.current || storedProblem) return;
    if (writeRecord.phase === "accepted_readback") { await runRecoveryCheck(writeRecord); return; }
    if (isUploadRecord(writeRecord)) await runUploadCommand(null);
    else await runWrite(writeRecord);
  }, [writeRecord, storedProblem, runWrite, runUploadCommand, runRecoveryCheck]);
  const readbackAgain = useCallback(async () => { if (writeRecord) await runRecoveryCheck(writeRecord); }, [writeRecord, runRecoveryCheck]);

  const abandonRecovery = useCallback(async () => {
    const expected = writeRecord;
    if (!expected || !mountedRef.current || writeBusyRef.current) return;
    const seq = ++writeSeq.current;
    writeBusyRef.current = true; setWriteBusy(true); setAbandonOpen(false);
    try {
      await withRecordLock(seq, expected, async (record) => {
        if (!record || !isCurrentWrite(seq)) return;
        if (!clearRecordIfMatch(record.adminId, record)) { setNotice("当前原记录未能匹配清理，未结束恢复；请核对原窗口。"); return; }
        setWriteRecord(null); setRecoveryChecked(true); uploadMemory.current = null;
        setUploadState((state) => ({ ...state, step: "select", stepState: { intent: "idle", bytes: "idle", readback: "idle" } }));
        setUnresolvedNotice(`${record.targetLabel}：已放弃恢复（仅结束本地恢复），原写入结果仍未确认；不等于撤销或未执行，请先核对对象状态。`);
      });
    } catch (failure) { if (isCurrentWrite(seq)) setNotice(lockNotice(failure)); }
    finally { if (isCurrentWrite(seq)) { writeBusyRef.current = false; setWriteBusy(false); } }
  }, [writeRecord, withRecordLock, isCurrentWrite]);

  const acknowledgeStoredProblem = useCallback(async () => {
    if (!mountedRef.current || writeBusyRef.current) return;
    const expected = problemRecordRef.current;
    if (!expected?.readable) { setNotice("本地存储不可读取，未清除恢复记录；请保留原窗口并检查浏览器。 "); return; }
    const seq = ++writeSeq.current;
    writeBusyRef.current = true; setWriteBusy(true);
    try {
      await withSupplyWriteLock(storageKey(snapshot.adminUserId), async () => {
        if (!isCurrentWrite(seq)) return;
        if (window.localStorage.getItem(storageKey(snapshot.adminUserId)) !== expected.raw) { setNotice("恢复记录已被更新，未清除；请重新读取并核对原请求。"); return; }
        window.localStorage.removeItem(storageKey(snapshot.adminUserId));
        problemRecordRef.current = null;
        setStoredProblem(null); setWriteRecord(null); setRecoveryChecked(true);
        setUnresolvedNotice("已显式清除匹配的损坏本地记录；此前原写入结果仍未知，清除不等于撤销，请先核对对象状态。");
      });
    } catch (failure) { if (isCurrentWrite(seq)) setNotice(lockNotice(failure)); }
    finally { if (isCurrentWrite(seq)) { writeBusyRef.current = false; setWriteBusy(false); } }
  }, [snapshot.adminUserId, isCurrentWrite]);


  /* ---------- 队列分页（真实游标栈） ---------- */

  const goNext = () => {
    if (!page?.nextCursor) return;
    cursorStack.current = [...cursorStack.current.slice(0, pageIndexRef.current + 1), page.nextCursor];
    pageIndexRef.current = cursorStack.current.length - 1;
    setPageIndex(pageIndexRef.current);
    setSelected(null);
    void loadQueue(page.nextCursor);
  };
  const goPrev = () => {
    if (pageIndexRef.current === 0) return;
    pageIndexRef.current -= 1;
    setPageIndex(pageIndexRef.current);
    setSelected(null);
    void loadQueue(cursorStack.current[pageIndexRef.current] || undefined);
  };

  /* ---------- 渲染 ---------- */

  if (!canRead) {
    return (
      <section className="section-panel">
        <p className="text-sm text-muted-foreground">当前账号没有媒体审核读取权限；游戏目录权限不等于可查看私有凭证。</p>
      </section>
    );
  }

  const writeLocked = Boolean(writeRecord) || writeBusy || Boolean(storedProblem) || (Boolean(writeRecord) && !recoveryChecked);
  const nextAsset = tab === "pending" && selected && page ? visibleItems.find((item) => item.id !== selected.id && item.reviewState === "PENDING") ?? null : null;
  const filterSummary = tab === "reviewed" ? `${STATE_LABELS[queueState]} · ${OWNERSHIP_LABELS[ownershipKind]}` : `待审核 · ${OWNERSHIP_LABELS[ownershipKind]}`;
  const confirmReasonError =
    confirm && confirm.action.kind === "review"
      ? reviewReasonError(confirm.asset, confirm.action.decision, reasonFor(confirm.asset))
      : confirm && confirm.action.kind === "visibility"
        ? visibilityReasonError(reasonFor(confirm.asset))
        : null;

  const showAside = wide && Boolean(selected);

  const detail = selected ? (
    <MediaDetailPanel
      asset={selected}
      games={games}
      canDecide={canDecide}
      canUpload={canUpload}
      onZoom={setZoom}
      onOpenPath={onOpenPath}
      busy={writeLocked}
      hideHeading={!wide}
      onAction={(action) => setConfirm({ asset: selected, action })}
      onNext={nextAsset ? () => setSelected(nextAsset) : undefined}
      onClose={wide ? () => setSelected(null) : undefined}
      hasNext={Boolean(nextAsset)}
    />
  ) : null;


  return (
    <div className="space-y-4">
      <MediaReviewHeader headingRef={headingRef} canUpload={canUpload} pageItems={pageItems} writeLocked={writeLocked} setUploadState={setUploadState} writeRecord={writeRecord} writeBusy={writeBusy} replayWrite={replayWrite} readbackAgain={readbackAgain} runRecoveryCheck={runRecoveryCheck} setAbandonOpen={setAbandonOpen} recoveryChecked={recoveryChecked} uploadMemory={uploadMemory} storedProblem={storedProblem} acknowledgeStoredProblem={acknowledgeStoredProblem} unresolvedNotice={unresolvedNotice} notice={notice} tab={tab} setTab={setTab} reviewedState={reviewedState} setReviewedState={setReviewedState} ownershipKind={ownershipKind} setOwnershipKind={setOwnershipKind}/>

      <div className={cn("grid grid-cols-1 gap-5", showAside ? "xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_420px]" : "w-full")}>
        <MediaReviewQueue filterSummary={filterSummary} page={page} pageItems={pageItems} reviewScope={reviewScope} setReviewScope={setReviewScope} setSelected={setSelected} reviewableCount={reviewableCount} exemptCount={exemptCount} loading={loading} loadQueue={loadQueue} cursorNow={cursorNow} listError={listError} wide={wide} visibleItems={visibleItems} selected={selected} gameNames={gameNames} tab={tab} setTab={setTab} setReviewedState={setReviewedState} pageIndex={pageIndex} goPrev={goPrev} goNext={goNext} scopeLabel={scopeLabel}/>

        {wide && showAside ? (
          <aside
            ref={asideRef}
            className="section-panel hidden self-start overflow-hidden xl:min-h-0 xl:flex-col xl:sticky xl:top-2 xl:flex"
            style={selected && asideHeight !== undefined ? { height: asideHeight } : undefined}
            aria-label="素材详情"
          >
            {detail}
          </aside>
        ) : null}
        {!wide ? (
          <MediaNarrowDetailDialog selected={selected} confirm={confirm} setSelected={setSelected} detail={detail}/>
        ) : null}
      </div>

      {canUpload ? (
        <UploadMediaDialog
          open={uploadState.open}
          onOpenChange={(open) => setUploadState((current) => ({ ...current, open }))}
          games={games}
          gamesState={gamesState}
          state={uploadState}
          onSubmit={(input) => void runUploadCommand(input)}
          onRetry={() => void replayWrite()}
          onReadback={() => void readbackAgain()}
        />
      ) : null}

      {zoom ? <Lightbox {...zoom} onClose={() => setZoom(undefined)} /> : null}

      {/* 审核确认：父级承载（完整 assetId＋action 锚定），切换右栏/Sheet 不丢失。 */}
      <MediaConfirmDialog confirm={confirm} setConfirm={setConfirm} gameNames={gameNames} reasonFor={reasonFor} setReasonFor={setReasonFor} confirmReasonError={confirmReasonError} startSimpleWrite={startSimpleWrite}/>

      <MediaAbandonSheet abandonOpen={abandonOpen} setAbandonOpen={setAbandonOpen} writeRecord={writeRecord} abandonRecovery={abandonRecovery}/>
    </div>
  );
}
