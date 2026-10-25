import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";

import { Badge, InlineStatus } from "@/components/ui/badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SupplySelect } from "@/components/supply/supply-select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  adminRequest,
  AdminApiError,
  friendlyError,
  hasPermission,
  type AdminGunsmithCode,
  type AdminGunsmithResponse,
  type CatalogMediaOption,
  type MediaOptionsResponse,
  type SessionSnapshot,
  type SupplyGame,
} from "../api";
import { StatusMessage } from "../components/ui-elements";
import { SupplyWriteLockError, withSupplyWriteLock } from "../lib/supply-write-lock";
import { CellInput, CellSelect, CopyCode } from "./supply-catalog/catalog-table";
import {
  aliasCount,
  codeCount,
  codeMatchesFilters,
  CODE_MIN_LENGTH,
  EMPTY_HINT,
  ENTITY_LABEL,
  firearmMatchesQuery,
  groupFirearms,
  gunsmithRecoveryTarget,
  MODE_ITEMS,
  modeLabel,
  reviewTimeInput,
  reviewTimeUtc,
  pendingGunsmithKey,
  parsePendingGunsmith,
  type PendingGunsmithWrite,
  type GunsmithEntity,
} from "./supply-gunsmith/model";
import { GunsmithWorkspace } from "./supply-gunsmith/workspace";
import { readOperationResult, requestFingerprint } from "./supply-media/write-intent";

type Editor = { entity: GunsmithEntity; id?: string; firearmId?: string; values: Record<string, string>; revision?: string; baseline?: string };
type UnknownWrite = PendingGunsmithWrite | null;

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;
const EMPTY_GAMES: SupplyGame[] = [];
const EMPTY_LIST: never[] = [];
const enableItems = [{ value: "true", label: "启用" }, { value: "false", label: "停用" }];

export function SupplyGunsmithView({
  snapshot,
  onDirtyChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
}) {
  const canManage = hasPermission(snapshot, "supply.gunsmith.manage");
  const actorScope = `${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.permissions.slice().sort().join(",")}:${canManage}`;
  const [loadedGames, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [loadedData, setLoadedData] = useState<AdminGunsmithResponse | null>(null);
  const [firearmId, setFirearmId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [mediaPicking, setMediaPicking] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<null | { type: "game" | "firearm"; value: string }>(null);
  const [unknownWrite, setUnknownWrite] = useState<UnknownWrite>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [firearmQuery, setFirearmQuery] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  const [codeMode, setCodeMode] = useState("all");
  const [codeStatus, setCodeStatus] = useState("all");
  const [discardEditor, setDiscardEditor] = useState(false);
  const [statusTarget, setStatusTarget] = useState<AdminGunsmithCode | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<{ key: string; message: string } | null>(null);
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mediaOptions, setMediaOptions] = useState<CatalogMediaOption[]>(EMPTY_LIST);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string>();
  const [mediaRetryCursor, setMediaRetryCursor] = useState<string | null>(null);

  const gamesSeq = useRef(0), dataSeq = useRef(0), mediaSeq = useRef(0), writeSeq = useRef(0), recoverySeq = useRef(0);
  const writeBusy = useRef(false);
  const scope = `${actorScope}|${gameId}`;
  const scopeRef = useRef(scope), actorRef = useRef(actorScope);
  scopeRef.current = scope; actorRef.current = actorScope;
  const gamesScope = useRef(""), dataScope = useRef("");
  const games = gamesScope.current === actorScope ? loadedGames : EMPTY_GAMES;
  const data = dataScope.current === scope ? loadedData : null;

  const classifications = data?.classifications ?? EMPTY_LIST;
  const firearms = data?.firearms ?? EMPTY_LIST;
  const aliases = data?.aliases ?? EMPTY_LIST;
  const codes = data?.codes ?? EMPTY_LIST;
  const game = games.find((entry) => entry.id === gameId);
  const service = game?.services?.find((entry) => entry.serviceCode === "GUNSMITH");
  const firearm = firearms.find((entry) => entry.id === firearmId) ?? null;
  const groups = useMemo(() => groupFirearms(classifications, firearms.filter((entry) => firearmMatchesQuery(entry, aliases, firearmQuery))), [classifications, firearms, aliases, firearmQuery]);
  const firearmAliases = useMemo(() => aliases.filter((entry) => entry.firearmId === firearm?.id), [aliases, firearm?.id]);
  const firearmCodes = useMemo(() => codes.filter((entry) => entry.firearmId === firearm?.id && codeMatchesFilters(entry, codeQuery, codeMode, codeStatus)), [codes, firearm?.id, codeQuery, codeMode, codeStatus]);
  const editorDirty = !saving && Boolean(editor) && editor!.baseline !== JSON.stringify(editor!.values);

  useEffect(() => {
    writeSeq.current += 1; recoverySeq.current += 1; writeBusy.current = false; setSaving(false); setRecovering(false);
  }, [actorScope]);
  useEffect(() => {
    const read = () => {
      try {
        const raw = window.localStorage.getItem(pendingGunsmithKey(snapshot.adminUserId));
        const pending = parsePendingGunsmith(raw, snapshot.adminUserId);
        if (raw && !pending) throw new Error("原恢复记录无法校验");
        setUnknownWrite(pending); setStorageBlocked(false);
      } catch { setStorageBlocked(true); setError("无法读取原操作恢复记录，暂不允许新提交；请联系维护者核对。"); }
    };
    read();
    const changed = (event: StorageEvent) => { if (!writeBusy.current && event.key === pendingGunsmithKey(snapshot.adminUserId)) read(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [snapshot.adminUserId, actorScope]);
  useEffect(() => {
    if (!editorDirty && !saving && !unknownWrite) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty, saving, unknownWrite]);

  const loadGames = useCallback(async () => {
    const token = ++gamesSeq.current, actor = actorRef.current;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    if (token !== gamesSeq.current || actor !== actorRef.current) return;
    if (!Array.isArray(result?.games)) throw new Error("游戏目录响应不完整。");
    gamesScope.current = actor;
    setGames(result.games);
    setGameId((current) => (current && result.games.some((entry) => entry.id === current) ? current : result.games.find((entry) => entry.code === "delta")?.id ?? result.games[0]?.id ?? ""));
  }, []);

  const loadData = useCallback(async (targetGameId: string) => {
    const token = ++dataSeq.current;
    if (!targetGameId) { setLoadedData(null); return null; }
    const context = `${actorRef.current}|${targetGameId}`;
    const result = await adminRequest<AdminGunsmithResponse>(`/supply/games/${targetGameId}/firearms`);
    if (token !== dataSeq.current || scopeRef.current !== context) return null;
    if (!Array.isArray(result?.firearms) || !Array.isArray(result.classifications) || !Array.isArray(result.aliases) || !Array.isArray(result.codes)) throw new Error("改枪码目录响应不完整。");
    dataScope.current = context;
    setLoadedData(result);
    return result;
  }, []);

  useEffect(() => {
    setGameId(""); setGames([]); gamesScope.current = "";
    if (!canManage) return;
    const actor = actorScope;
    void loadGames().catch((failure) => { if (actorRef.current === actor) setError(friendlyError(failure)); });
    return () => { gamesSeq.current += 1; };
  }, [actorScope, canManage, loadGames]);

  useEffect(() => {
    if (!canManage || refreshNonce === 0) return;
    const actor = actorScope;
    void loadGames().catch((failure) => { if (actorRef.current === actor) setError(friendlyError(failure)); });
  }, [refreshNonce, canManage, actorScope, loadGames]);

  useEffect(() => {
    setEditor(null); setTermsOpen(false); setMediaPicking(false); setFirearmId(""); setFirearmQuery(""); setCodeQuery("");
    const context = scope;
    if (!gameId || gamesScope.current !== actorScope) { setLoadedData(null); return; }
    setLoading(true);
    void loadData(gameId).catch((failure) => { if (scopeRef.current === context) { setLoadedData(null); setError(friendlyError(failure)); } })
      .finally(() => { if (scopeRef.current === context) setLoading(false); });
  }, [gameId, actorScope, scope, loadData, refreshNonce]);

  useEffect(() => {
    onDirtyChange(Boolean(editor) || saving || Boolean(unknownWrite));
    return () => onDirtyChange(false);
  }, [editor, unknownWrite, saving, onDirtyChange]);

  const busy = saving || Boolean(unknownWrite) || storageBlocked;

  const runWrite = async (entity: GunsmithEntity, path: string, body: Record<string, unknown>, method: "POST" | "PUT", action: string, key: string) => {
    if (writeBusy.current || unknownWrite || storageBlocked) return;
    const storageKey = pendingGunsmithKey(snapshot.adminUserId);
    const pending: PendingGunsmithWrite = { schema: 1, adminId: snapshot.adminUserId, gameId, entity, action, key, path, method, body: JSON.parse(JSON.stringify(body)), accepted: false };
    const sequence = ++writeSeq.current, context = scope;
    const current = () => scopeRef.current === context && writeSeq.current === sequence;
    const clearOwnRecord = () => {
      if (parsePendingGunsmith(window.localStorage.getItem(storageKey), pending.adminId)?.key !== key) throw new Error("恢复记录已变化，保留待核记录。");
      window.localStorage.removeItem(storageKey);
    };
    writeBusy.current = true; setSaving(true); setError(undefined); setFieldError(null); setSuccess(undefined);
    try {
      await withSupplyWriteLock(storageKey, async () => {
        if (!current()) return;
        let sent = false, accepted = false;
        try {
          const raw = window.localStorage.getItem(storageKey);
          if (raw) {
            const existing = parsePendingGunsmith(raw, pending.adminId);
            if (!existing) throw new Error("原恢复记录无法校验，未提交新请求。");
            setUnknownWrite(existing); setError("已有原操作待核，本次未提交；请先核对原结果。"); return;
          }
          window.localStorage.setItem(storageKey, JSON.stringify(pending));
          sent = true;
          await adminRequest(path, pending.body, method, { "idempotency-key": key });
          accepted = true;
          window.localStorage.setItem(storageKey, JSON.stringify({ ...pending, accepted: true }));
          if (!current()) return;
          const edited = editor;
          setEditor(null); setMediaPicking(false);
          setSuccess(`${ENTITY_LABEL[entity]}已提交；稳定 ID 与历史记录保持不变。`);
          const refreshed = await loadData(gameId);
          if (!current()) return;
          if (!refreshed) throw new Error("操作已受理，目录回读尚未完成。");
          clearOwnRecord();
          if (edited?.entity === "firearm" && !edited.id && edited.values.code) {
            const created = refreshed.firearms.find((entry) => entry.code === edited.values.code);
            if (created) setFirearmId(created.id);
          }
        } catch (failure) {
          if (!current()) return;
          if (!sent) { setStorageBlocked(true); setError(failure instanceof Error ? failure.message : "无法保存恢复记录，未提交。"); return; }
          if (accepted || !(failure instanceof AdminApiError) || failure.status === 0 || failure.status >= 500) {
            setUnknownWrite({ ...pending, accepted });
            setError(accepted ? "操作已受理，但回读或保存恢复状态失败；不会重复提交。" : `未能确认「${ENTITY_LABEL[entity]}·${action}」的结果。保留原请求，不要重发或更换提交内容。`);
          } else {
            try { clearOwnRecord(); }
            catch { setStorageBlocked(true); setError("恢复记录已变化，未清除他人原请求；请重新进入核对。"); return; }
            setError(failure.status === 409
              ? `${ENTITY_LABEL[entity]}版本已变化（他人已修改或目录已刷新）。输入已保留，请取消后重新打开读取最新版本。`
              : friendlyError(failure));
          }
        }
      });
    } catch (failure) {
      if (current()) setError(failure instanceof SupplyWriteLockError ? failure.message : "操作保护无法取得，未提交本次请求。");
    } finally {
      if (writeSeq.current === sequence) { writeBusy.current = false; setSaving(false); }
    }
  };

  const saveEditor = () => {
    if (!editor || !gameId || busy) return;
    const values = editor.values;
    const name = (values.name ?? "").trim();
    const inSheet = editor.entity === "code" || editor.entity === "alias";
    type KeyedError = Error & { field?: string };
    const fail = (message: string, field?: string): never => { throw Object.assign(new Error(message), { field }); };
    try {
      if ((editor.entity === "classification" || editor.entity === "firearm") && !editor.id && !CODE_PATTERN.test(values.code ?? "")) fail("稳定 code 需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。", "code");
      if (editor.entity !== "code" && !name) fail("名称不能为空。", "name");
      if (editor.entity === "code" && (values.code ?? "").trim().length < CODE_MIN_LENGTH) fail(`改枪码至少需要 ${CODE_MIN_LENGTH} 个字符。`, "code");
      if (editor.entity === "code") {
        try { reviewTimeUtc(values.lastReviewedAt ?? "", values.originalReviewedAt); }
        catch (failure) { fail(failure instanceof Error ? failure.message : "复核时间无法识别。", "lastReviewedAt"); }
      }
      if ((editor.entity === "alias" || editor.entity === "code") && !editor.firearmId) throw new Error("请保留此表单绑定的武器后再保存。");
    } catch (failure) {
      const key = (failure as KeyedError).field;
      const message = failure instanceof Error ? failure.message : "请检查填写内容。";
      if (inSheet && key) setFieldError({ key, message });
      else { setFieldError(null); setError(message); }
      return;
    }
    const key = `idem_${crypto.randomUUID().replaceAll("-", "")}`;
    if (editor.entity === "classification") {
      const body = editor.id
        ? { expectedRevision: editor.revision, name, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder ?? 0) }
        : { code: values.code, name, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder ?? 0) };
      void runWrite("classification", editor.id ? `/supply/firearm-classifications/${editor.id}` : `/supply/games/${gameId}/firearm-classifications`, body, editor.id ? "PUT" : "POST", editor.id ? "更新分类" : "新建分类", key);
      return;
    }
    if (editor.entity === "firearm") {
      const body = {
        ...(editor.id ? { expectedRevision: editor.revision } : { code: values.code }),
        name,
        classificationId: values.classificationId || null,
        mediaId: values.mediaId || null,
        enabled: values.enabled === "true",
        sortOrder: Number(values.sortOrder ?? 0),
      };
      void runWrite("firearm", editor.id ? `/supply/firearms/${editor.id}` : `/supply/games/${gameId}/firearms`, body, editor.id ? "PUT" : "POST", editor.id ? "更新武器" : "新建武器", key);
      return;
    }
    if (editor.entity === "alias") {
      const body = editor.id
        ? { expectedRevision: editor.revision, name, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder ?? 0) }
        : { locale: values.locale || "zh-CN", name, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder ?? 0) };
      void runWrite("alias", editor.id ? `/supply/firearm-aliases/${editor.id}` : `/supply/games/${gameId}/firearms/${editor.firearmId}/aliases`, body, editor.id ? "PUT" : "POST", editor.id ? "更新别名" : "新建别名", key);
      return;
    }
    const body = editor.id
      ? { expectedRevision: editor.revision, code: values.code, note: values.note ?? "", modeCode: values.modeCode || null, lastReviewedAt: reviewTimeUtc(values.lastReviewedAt ?? "", values.originalReviewedAt) }
      : { gameId, firearmId: editor.firearmId, code: values.code, note: values.note ?? "", modeCode: values.modeCode || null, ...(values.lastReviewedAt ? { lastReviewedAt: reviewTimeUtc(values.lastReviewedAt, values.originalReviewedAt) } : {}) };
    void runWrite("code", editor.id ? `/supply/gunsmith/codes/${editor.id}` : "/supply/gunsmith/codes", body, editor.id ? "PUT" : "POST", editor.id ? "更新改枪码" : "新建改枪码", key);
  };

  const toggleStatus = (code: AdminGunsmithCode) => {
    if (busy) return;
    setStatusTarget(code);
  };

  const startEditor = (next: Editor) => {
    if (busy) return;
    setEditor({ ...next, baseline: JSON.stringify(next.values) });
    setError(undefined);
    setFieldError(null);
    if (next.entity === "classification" || next.entity === "firearm") setTermsOpen(true);
  };

  const applySwitch = (type: "game" | "firearm", value: string) => {
    setPendingSwitch(null);
    setEditor(null);
    if (type === "game") { setGameId(value); return; }
    setFirearmId(value);
    setCodeQuery(""); setCodeMode("all"); setCodeStatus("all");
  };

  const requestSwitch = (type: "game" | "firearm", value: string) => {
    if (busy) return;
    if (editorDirty) { setPendingSwitch({ type, value }); return; }
    applySwitch(type, value);
  };

  const loadMediaPage = async (cursor: string | null) => {
    if (!gameId) return;
    setMediaError(undefined);
    setMediaRetryCursor(cursor);
    setMediaLoading(true);
    const sequence = ++mediaSeq.current, context = scope;
    try {
      const params = new URLSearchParams({ purpose: "FIREARM_MEDIA", limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<MediaOptionsResponse>(`/supply/games/${gameId}/media-options?${params.toString()}`);
      if (sequence !== mediaSeq.current || scopeRef.current !== context) return;
      setMediaOptions((current) => (cursor ? [...current, ...result.items] : result.items));
      setMediaNextCursor(result.nextCursor);
      setMediaRetryCursor(null);
    } catch (failure) {
      if (sequence !== mediaSeq.current || scopeRef.current !== context) return;
      setMediaError(friendlyError(failure));
      if (!cursor) { setMediaOptions([]); setMediaNextCursor(null); }
    } finally {
      if (sequence === mediaSeq.current && scopeRef.current === context) setMediaLoading(false);
    }
  };

  const closeMediaPicker = () => { mediaSeq.current += 1; setMediaPicking(false); setMediaOptions([]); setMediaNextCursor(null); setMediaError(undefined); };

  const openMediaPicker = () => {
    if (!editor) return;
    setMediaPicking(true);
    setMediaOptions([]); setMediaNextCursor(null); setMediaError(undefined);
    void loadMediaPage(null);
  };

  const reloadCatalog = async () => {
    setError(undefined); setLoading(true);
    try { await loadData(gameId); } catch (failure) { setError(friendlyError(failure)); } finally { setLoading(false); }
  };

  /** 原结果读取：只有服务端回执与本次待核记录完全匹配才解除该记录。 */
  const recoverOriginalResult = async () => {
    const record = unknownWrite;
    if (!record || writeBusy.current || recovering) return;
    const target = gunsmithRecoveryTarget(record);
    if (!target) { setError("无法从该恢复记录确定原操作，保留待核；请交维护者按原请求核对。"); return; }
    const lockKey = pendingGunsmithKey(snapshot.adminUserId), context = scope, actor = actorRef.current, attempt = ++recoverySeq.current;
    const current = () => scopeRef.current === context && actorRef.current === actor && recoverySeq.current === attempt;
    setRecovering(true); setError(undefined);
    try {
      const fingerprint = await requestFingerprint(target.operation, target.resourceId, record.body);
      const result = await readOperationResult({ operation: target.operation, resourceId: target.resourceId, fingerprint, key: record.key });
      if (!current()) return;
      const recorded = result.receipt === "RECORDED" ? result : null;
      const targetId = recorded && typeof recorded.result.id === "string" ? recorded.result.id : "";
      const matches = Boolean(recorded
        && recorded.responseStatus >= 200 && recorded.responseStatus < 300
        && recorded.echoOperation === target.operation && recorded.echoResourceId === (target.resourceId ?? null)
        && (target.resourceId ? targetId === target.resourceId : Boolean(targetId)));
      if (!matches) {
        setError(result.receipt === "RECORDED"
          ? "原回执的操作、对象或请求指纹不匹配，结果仍待核；保留原记录，不会更换提交标识重发。"
          : "未查到可确认的原回执，结果仍待核；未查到不等于未执行。");
        return;
      }
      await withSupplyWriteLock(lockKey, async () => {
        const raw = window.localStorage.getItem(lockKey);
        const existing = raw ? parsePendingGunsmith(raw, record.adminId) : null;
        if (!existing || existing.key !== record.key) throw new Error("恢复记录已变化，未清除他人原请求。");
        window.localStorage.removeItem(lockKey);
      });
      if (!current()) return;
      setUnknownWrite(null);
      setSuccess(`${ENTITY_LABEL[record.entity]}·${record.action}：原命令回执已确认，已按原对象解除待核并重读目录。`);
      await reloadCatalog();
    } catch (failure) {
      if (current()) setError(failure instanceof SupplyWriteLockError ? failure.message : failure instanceof Error && failure.message ? failure.message : "原结果读取失败，结果仍待核。");
    } finally {
      // Busy belongs to this attempt only: a superseded or de-authenticated run can
      // never write results back, and must never leave the button stuck on 核对中.
      if (recoverySeq.current === attempt) setRecovering(false);
    }
  };

  if (!canManage) {
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有改枪码目录维护权限。" /></section>;
  }

  const editing = (entity: GunsmithEntity, id?: string) => editor?.entity === entity && editor?.id === id;
  const editValue = (key: string, fallback = "") => editor?.values[key] ?? fallback;
  const fieldMessage = (key: string) => (fieldError?.key === key ? fieldError.message : undefined);
  const setEditValue = (key: string, value: string) => setEditor((current) => (current ? { ...current, values: { ...current.values, [key]: value } } : current));
  const classificationItems = [{ value: "", label: "未分类" }, ...classifications.map((entry) => ({ value: entry.id, label: entry.name }))];

  const rowSaveCancel = (id?: string) => (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" size="sm" disabled={busy} onClick={saveEditor}>保存</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => { setEditor(null); closeMediaPicker(); }}>{busy ? "关闭（稍后核对）" : "取消"}</Button>
      {id ? <span className="text-[10px] text-muted-foreground">版本 {editor?.revision ?? "未提供"}</span> : null}
    </span>
  );

  const mediaBlock = (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">武器图片</span>
        {editValue("mediaId") ? <Button type="button" size="sm" variant="outline" onClick={() => setEditValue("mediaId", "")}>解除绑定</Button> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">只绑定本平台已审核且允许公开的 FIREARM_MEDIA 衍生图；本页不上传字节，撤权后公开页自动降级为无图。</p>
      {editValue("mediaId") ? (
        <div className="flex items-center gap-3">
          <img src={`/api/v1/supply/media/${editValue("mediaId")}/content`} alt="当前绑定武器图" className="h-16 w-16 rounded border border-border object-cover" loading="lazy" />
          <span className="font-mono text-[11px] break-all text-muted-foreground">{editValue("mediaId")}</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">当前未绑定图片。</p>
      )}
      {mediaPicking ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">候选已按游戏与用途过滤：FIREARM_MEDIA、已审核且允许公开。</span>
            <Button type="button" size="sm" variant="ghost" onClick={closeMediaPicker}>收起候选</Button>
          </div>
          <StatusMessage themeAware error={mediaError} />
          {mediaLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
          {!mediaLoading && !mediaError && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">没有可绑定图片；请先在平台素材审核上传并审核公开 FIREARM_MEDIA 素材。</p> : null}
          {mediaOptions.length > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {mediaOptions.map((option) => (
                  <Button type="button" variant="outline" key={option.id} aria-label={`绑定候选 ${option.id}`} className="h-auto flex-col items-stretch gap-0 overflow-hidden p-0 text-left" onClick={() => { setEditValue("mediaId", option.id); closeMediaPicker(); }}>
                    <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="h-14 w-full object-cover" loading="lazy" />
                    <span className="block truncate px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{option.id.slice(0, 14)}… · {option.width}×{option.height}</span>
                  </Button>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                {mediaNextCursor && !mediaError ? <Button type="button" size="sm" variant="outline" disabled={mediaLoading} onClick={() => void loadMediaPage(mediaNextCursor)}>加载更多</Button> : null}
                {mediaError ? <Button type="button" size="sm" variant="outline" disabled={mediaLoading} onClick={() => void loadMediaPage(mediaRetryCursor)}>重试</Button> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={openMediaPicker}>选择图片</Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h1 className="text-2xl leading-9 font-semibold">改枪码目录</h1>
            <p>按枪械维护多套改装方案，管理代码原文、适用模式和方案说明。</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <Field label="游戏" composite>
              <SupplySelect label="游戏" value={gameId} options={games.map((entry) => ({ value: entry.id, label: `${entry.name}（${entry.code}）` }))} onValueChange={next => requestSwitch("game", next)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
            {service
              ? <><InlineStatus tone={service.enabled && service.supported ? "info" : "neutral"}>{!service.supported ? "该游戏未完成适配" : service.enabled ? "玩家端服务已启用" : "玩家端服务未启用"}</InlineStatus><span className="text-xs text-muted-foreground">服务开关不在本页操作。</span></>
              : <InlineStatus tone="unknown">服务状态未提供（接口未返回该游戏的服务事实）。</InlineStatus>}
          </div>
          <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={busy || Boolean(editor)} onClick={() => { setEditor(null); setTermsOpen(true); }}>管理基础目录</Button>
        </div>
        <StatusMessage themeAware error={error} success={success} className="mt-3" />
        {unknownWrite ? (
          <Alert variant="warning" role="status" className="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{unknownWrite.accepted ? "已受理，回读待核" : "结果尚未确认"}：{ENTITY_LABEL[unknownWrite.entity]}·{unknownWrite.action}</AlertTitle>
            <AlertDescription>
              <p>原操作已保留。可读取该操作的原命令回执；只有回执与原请求匹配才会解除待核，刷新目录只能辅助核对，不能证明原请求是否执行。</p>
              <p>影响：确认前禁止新提交，不会更换提交标识重发原请求。</p>
              <p className="select-text break-all font-mono">原请求：{unknownWrite.key}</p>
            </AlertDescription>
            <AlertAction>
              <Button type="button" size="sm" disabled={loading || recovering} onClick={() => void recoverOriginalResult()}>{recovering ? "核对中…" : "核对原结果"}</Button>
              <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void reloadCatalog()}>{loading ? "读取中…" : "刷新目录核对"}</Button>
              <span className="text-xs text-muted-foreground">两条入口都只读取，不重发原请求、不更换提交标识。</span>
            </AlertAction>
          </Alert>
        ) : null}
      </section>

      {loading && !data ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">正在读取枪械与方案…</p> : null}
      {data ? <GunsmithWorkspace
        groups={groups} classifications={classifications} firearm={firearm} codes={firearmCodes} aliases={firearmAliases} totalFirearms={firearms.length}
        allCodes={codes}
        firearmQuery={firearmQuery} codeQuery={codeQuery} mode={codeMode} status={codeStatus} busy={busy} editing={Boolean(editor)}
        onFirearmQuery={setFirearmQuery} onCodeQuery={setCodeQuery} onMode={setCodeMode} onStatus={setCodeStatus}
        onSelect={id => requestSwitch("firearm", id)}
        onNew={() => firearm && startEditor({ entity: "code", firearmId: firearm.id, values: { code: "", note: "", modeCode: "", lastReviewedAt: "" } })}
        onEdit={entry => startEditor({ entity: "code", id: entry.id, firearmId: entry.firearmId, revision: entry.revision, values: { code: entry.code, note: entry.note ?? "", modeCode: entry.modeCode ?? "", lastReviewedAt: reviewTimeInput(entry.lastReviewedAt), originalReviewedAt: entry.lastReviewedAt ?? "" } })}
        onStatusChange={toggleStatus}
        onAlias={() => firearm && startEditor({ entity: "alias", firearmId: firearm.id, values: { name: "", locale: "zh-CN", sortOrder: "0", enabled: "true" } })}
        onEditAlias={entry => startEditor({ entity: "alias", id: entry.id, firearmId: entry.firearmId, revision: entry.revision, values: { name: entry.name, locale: entry.locale, sortOrder: String(entry.sortOrder), enabled: String(entry.enabled) } })}
        onEditFirearm={() => firearm && startEditor({ entity: "firearm", id: firearm.id, revision: firearm.revision, values: { code: firearm.code, name: firearm.name, classificationId: firearm.classificationId ?? "", mediaId: firearm.mediaId ?? "", sortOrder: String(firearm.sortOrder), enabled: String(firearm.enabled) } })}
        onCatalog={() => setTermsOpen(true)} onRefresh={() => void reloadCatalog()}
      /> : null}

      <Sheet open={Boolean(editor && (editor.entity === "code" || editor.entity === "alias"))} onOpenChange={open => { if (!open && !busy) { if (editorDirty) setDiscardEditor(true); else setEditor(null); } }}>
        <SheetContent showCloseButton={!busy} closeLabel="关闭编辑窗口" className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
          <SheetHeader className="border-b"><SheetTitle>{editor?.id ? "编辑" : "新增"}{editor?.entity === "alias" ? "枪械别名" : "改枪码"}</SheetTitle><SheetDescription>所属枪械：{firearms.find(f => f.id === editor?.firearmId)?.name ?? "未提供"}。保存维护内容，不会开启玩家端服务。</SheetDescription></SheetHeader>
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            {editor?.entity === "code" ? <>
              <Field label="改枪码原文" required hint="保留完整原文或短码，不用目录code格式校验；不会自动添加枪名或模式。" error={fieldMessage("code")}><Textarea value={editValue("code")} disabled={busy} onChange={e => setEditValue("code", e.target.value)} className="min-h-32 font-mono"/></Field>
              <Field label="模式" composite hint="依实际方案标注，不能仅凭代码内容自动判定。"><SupplySelect label="模式" value={editValue("modeCode")} options={MODE_ITEMS} disabled={busy} onValueChange={v => setEditValue("modeCode", v)}/></Field>
              <Field label="方案说明" hint="例如：低成本腰射、满改红点。说明用于区分同一枪械的不同方案。"><Input value={editValue("note")} disabled={busy} onChange={e => setEditValue("note", e.target.value)}/></Field>
              <Field
                label={
                  <span className="flex items-center justify-between w-full">
                    <span>最近人工复核（北京时间）</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const now = new Date();
                        const beijingTime = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 16);
                        setEditValue("lastReviewedAt", beijingTime);
                      }}
                      className="h-5 px-1 text-[11px] font-normal text-primary hover:underline hover:bg-transparent"
                    >
                      设为当前时间
                    </Button>
                  </span>
                }
                hint="留空表示未记录。填写时间不代表代码已在游戏内验证成功。"
                error={fieldMessage("lastReviewedAt")}
              >
                <Input type="datetime-local" value={editValue("lastReviewedAt")} disabled={busy} onChange={e => setEditValue("lastReviewedAt", e.target.value)}/>
              </Field>
              <p className="text-xs text-muted-foreground">收录状态、玩家端开放状态、游戏内可用性分别核对。</p>
            </> : editor?.entity === "alias" ? <>
              <Field label="别名" required hint="用于查找当前枪械，不是另一条改枪方案。" error={fieldMessage("name")}><Input value={editValue("name")} disabled={busy} onChange={e => setEditValue("name", e.target.value)}/></Field>
              <Field label="语言"><Input value={editValue("locale")} disabled={busy || Boolean(editor?.id)} onChange={e => setEditValue("locale", e.target.value)}/></Field>
              <Field label="启用" composite><SupplySelect label="启用" value={editValue("enabled")} options={enableItems} disabled={busy} onValueChange={v => setEditValue("enabled", v)}/></Field>
              <Field label="排序"><Input type="number" value={editValue("sortOrder")} disabled={busy} onChange={e => setEditValue("sortOrder", e.target.value)}/></Field>
            </> : null}
            <StatusMessage themeAware error={error}/>
          </div>
          <div className="flex justify-end gap-2 border-t p-4"><Button type="button" variant="outline" disabled={busy} onClick={() => editorDirty ? setDiscardEditor(true) : setEditor(null)}>取消</Button><Button type="button" disabled={busy} onClick={saveEditor}>{saving ? "保存中…" : "保存"}</Button></div>
        </SheetContent>
      </Sheet>
      <Dialog open={discardEditor} onOpenChange={setDiscardEditor}><DialogContent closeLabel="关闭窗口"><DialogHeader><DialogTitle>放弃未保存修改？</DialogTitle><DialogDescription>当前输入尚未保存，返回可继续编辑。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDiscardEditor(false)}>保留编辑</Button><Button type="button" variant="destructive" onClick={() => { setDiscardEditor(false); setEditor(null); }}>放弃修改</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(statusTarget)} onOpenChange={open => { if (!open && !busy) setStatusTarget(null); }}>
        <DialogContent closeLabel="关闭窗口" showCloseButton={!busy}><DialogHeader><DialogTitle>{statusTarget?.status === "ACTIVE" ? "撤回这套方案？" : "恢复收录这套方案？"}</DialogTitle><DialogDescription>{statusTarget?.status === "ACTIVE" ? "仅撤回当前方案，保留代码原文与历史资料，其他方案不受影响。" : "仅恢复方案收录，不会开启玩家端服务，也不代表游戏导入已验证。"}</DialogDescription></DialogHeader>
          <p className="text-sm font-medium">{firearms.find(f => f.id === statusTarget?.firearmId)?.name ?? "枪械未提供"} · {statusTarget?.note || "未填写方案说明"}</p><code className="select-text break-all text-xs">{statusTarget?.code}</code><StatusMessage themeAware error={error}/>
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setStatusTarget(null)}>取消</Button><Button type="button" disabled={busy} variant={statusTarget?.status === "ACTIVE" ? "destructive" : "default"} onClick={() => { if (!statusTarget) return; const c = statusTarget; void runWrite("code", `/supply/gunsmith/codes/${c.id}/${c.status === "ACTIVE" ? "withdraw" : "restore"}`, { expectedRevision: c.revision }, "POST", c.status === "ACTIVE" ? "撤回改枪码" : "恢复改枪码", `idem_${crypto.randomUUID().replaceAll("-", "")}`).then(() => setStatusTarget(null)); }}>{statusTarget?.status === "ACTIVE" ? "确认撤回" : "确认恢复"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={termsOpen} onOpenChange={(open) => { if (!open) { if (editorDirty) return; setTermsOpen(false); setEditor(null); closeMediaPicker(); } }}>
        <DialogContent closeLabel="关闭窗口" className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>管理基础目录</DialogTitle>
            <DialogDescription>维护枪械分类与基础资料。枪械改名不会改变已关联的皮肤或改枪方案；方案在主工作区维护。</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">武器类型（分类）</h4>
                <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "classification", values: { code: "", name: "", sortOrder: "0", enabled: "true" } })}>新增分类</Button>
              </div>
              <div className="table-wrap">
                <Table>
                  <TableHeader><TableRow><TableHead>分类</TableHead><TableHead>排序</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {editing("classification", undefined) ? (
                      <TableRow data-editing="new">
                        <TableCell className="whitespace-normal"><div className="space-y-1"><CellInput label="稳定 code" value={editValue("code")} disabled={busy} onValueChange={(value) => setEditValue("code", value)} /><CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} /></div></TableCell>
                        <TableCell className="whitespace-normal"><CellInput label="排序" type="number" value={editValue("sortOrder", "0")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} /></TableCell>
                        <TableCell className="whitespace-normal"><CellSelect label="启用" value={editValue("enabled", "true")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} /></TableCell>
                        <TableCell className="text-right">{rowSaveCancel()}</TableCell>
                      </TableRow>
                    ) : null}
                    {classifications.length === 0 && !editing("classification", undefined) ? (
                      <TableRow><TableCell colSpan={4} className="py-5 text-xs text-muted-foreground">{EMPTY_HINT.classification}</TableCell></TableRow>
                    ) : classifications.map((entry) => (
                      <TableRow key={entry.id} data-editing={editing("classification", entry.id) ? "true" : undefined}>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <div className="space-y-1"><CopyCode code={entry.code} /><CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} /></div> : <div className="space-y-0.5"><span className="text-sm">{entry.name}</span><CopyCode code={entry.code} /></div>}</TableCell>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <CellInput label="排序" type="number" value={editValue("sortOrder")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} /> : <span className="text-xs">{entry.sortOrder}</span>}</TableCell>
                        <TableCell className="whitespace-normal">{editing("classification", entry.id) ? <CellSelect label="启用" value={editValue("enabled")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} /> : <Badge variant={entry.enabled ? "secondary" : "outline"}>{entry.enabled ? "启用" : "停用"}</Badge>}</TableCell>
                        <TableCell className="text-right">{editing("classification", entry.id) ? rowSaveCancel(entry.id) : <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "classification", id: entry.id, revision: entry.revision, values: { code: entry.code, name: entry.name, sortOrder: String(entry.sortOrder), enabled: String(entry.enabled) } })}>编辑</Button>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">武器</h4>
                <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "firearm", values: { code: "", name: "", classificationId: firearm?.classificationId ?? "", mediaId: "", sortOrder: "0", enabled: "true" } })}>新增武器</Button>
              </div>
              <div className="table-wrap">
                <Table>
                  <TableHeader><TableRow><TableHead>武器</TableHead><TableHead>分类</TableHead><TableHead>别名 / 改枪码</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {editing("firearm", undefined) ? (
                      <TableRow data-editing="new">
                        <TableCell className="whitespace-normal" colSpan={4}>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <CellInput label="稳定 code" value={editValue("code")} disabled={busy} onValueChange={(value) => setEditValue("code", value)} />
                            <CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} />
                            <CellSelect label="分类" value={editValue("classificationId")} items={classificationItems} disabled={busy} onValueChange={(value) => setEditValue("classificationId", value)} />
                            <CellInput label="排序" type="number" value={editValue("sortOrder", "0")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} />
                            <CellSelect label="启用" value={editValue("enabled", "true")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} />
                            <p className="self-end text-[11px] text-muted-foreground">新建武器不绑定图片；保存后再编辑即可绑定。</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{rowSaveCancel()}</TableCell>
                      </TableRow>
                    ) : null}
                    {firearms.length === 0 && !editing("firearm", undefined) ? (
                      <TableRow><TableCell colSpan={5} className="py-5 text-xs text-muted-foreground">{EMPTY_HINT.firearm}</TableCell></TableRow>
                    ) : firearms.map((entry) => (
                      <TableRow key={entry.id} data-editing={editing("firearm", entry.id) ? "true" : undefined}>
                        <TableCell className="whitespace-normal">
                          {editing("firearm", entry.id) ? (
                            <div className="space-y-3">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div className="space-y-1"><CopyCode code={entry.code} /><span className="block text-[11px] text-muted-foreground">创建后不可修改</span></div>
                                <CellInput label="名称" value={editValue("name")} disabled={busy} onValueChange={(value) => setEditValue("name", value)} />
                                <CellSelect label="分类" value={editValue("classificationId")} items={classificationItems} disabled={busy} onValueChange={(value) => setEditValue("classificationId", value)} />
                                <CellInput label="排序" type="number" value={editValue("sortOrder")} disabled={busy} onValueChange={(value) => setEditValue("sortOrder", value)} />
                                <CellSelect label="启用" value={editValue("enabled")} items={enableItems} disabled={busy} onValueChange={(value) => setEditValue("enabled", value)} />
                              </div>
                              {mediaBlock}
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <span className="text-sm font-medium">{entry.name}</span>
                              <CopyCode code={entry.code} />
                              {entry.mediaId ? <img src={`/api/v1/supply/media/${entry.mediaId}/content`} alt="" className="h-10 w-10 rounded border border-border object-cover" loading="lazy" /> : null}
                            </div>
                          )}
                        </TableCell>
                        {!editing("firearm", entry.id) ? (
                          <>
                            <TableCell className="text-xs">{classifications.find((item) => item.id === entry.classificationId)?.name ?? "未分类"}</TableCell>
                            <TableCell className="text-xs">{aliasCount(aliases, entry.id)} / {codeCount(codes, entry.id)}</TableCell>
                            <TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{entry.enabled ? "启用" : "停用"}</Badge></TableCell>
                          </>
                        ) : null}
                        <TableCell className="text-right">{editing("firearm", entry.id) ? rowSaveCancel(entry.id) : <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => startEditor({ entity: "firearm", id: entry.id, revision: entry.revision, values: { code: entry.code, name: entry.name, classificationId: entry.classificationId ?? "", mediaId: entry.mediaId ?? "", sortOrder: String(entry.sortOrder), enabled: String(entry.enabled) } })}>编辑</Button>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">停用不删除，历史引用保留；引用影响范围未提供。武器是共享稳定实体，改名不会更换皮肤目录与改枪码引用的 firearm ID。</p>
          </div>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy || editorDirty} onClick={() => { setEditor(null); closeMediaPicker(); setTermsOpen(false); }}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingSwitch)} onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}>
        <DialogContent closeLabel="关闭窗口" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>切换将放弃未保存修改</DialogTitle>
            <DialogDescription>当前编辑内容尚未保存；切换游戏或武器会丢弃这些输入。</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPendingSwitch(null)}>保留编辑</Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => pendingSwitch && applySwitch(pendingSwitch.type, pendingSwitch.value)}>放弃修改并切换</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
