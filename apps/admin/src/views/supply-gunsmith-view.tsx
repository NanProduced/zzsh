import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import {
  adminRequest,
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
import {
  codeMatchesFilters,
  ENTITY_LABEL,
  firearmMatchesQuery,
  groupFirearms,
  pendingGunsmithKey,
  parsePendingGunsmith,
  reviewTimeInput,
  type GunsmithEntity,
  type PendingGunsmithWrite,
} from "./supply-gunsmith/model";
import { GunsmithWorkspace } from "./supply-gunsmith/workspace";
import { createGunsmithCommands, type Editor } from "./supply-gunsmith/gunsmith-commands";
import { GunsmithOverlays } from "./supply-gunsmith/overlays";

type UnknownWrite = PendingGunsmithWrite | null;

const EMPTY_LIST: never[] = [];

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
  const data = dataScope.current === scope ? loadedData : null;

  const classifications = data?.classifications ?? EMPTY_LIST;
  const firearms = data?.firearms ?? EMPTY_LIST;
  const aliases = data?.aliases ?? EMPTY_LIST;
  const codes = data?.codes ?? EMPTY_LIST;
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
    setGameId(""); gamesScope.current = "";
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

  const { runWrite, saveEditor, recoverOriginalResult } = createGunsmithCommands({
    writeBusy, writeSeq, recoverySeq, scopeRef, actorRef, scope, snapshot, gameId, editor, unknownWrite,
    storageBlocked, recovering, busy, loadData, reloadCatalog, setUnknownWrite, setStorageBlocked, setError,
    setSaving, setFieldError, setSuccess, setEditor, setMediaPicking, setFirearmId, setRecovering,
  });

  if (!canManage) {
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有改枪码目录维护权限。" /></section>;
  }

  return (
    <div className="space-y-4">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h1 className="text-2xl leading-9 font-semibold">改枪码目录</h1>
            <p>按枪械维护《三角洲行动》的多套改装方案，管理代码原文、适用模式和方案说明。</p>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(editor)} onClick={() => { setEditor(null); setTermsOpen(true); }}>管理基础目录</Button>
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

      <GunsmithOverlays
        editor={editor}
        setEditor={setEditor}
        busy={busy}
        saving={saving}
        editorDirty={editorDirty}
        fieldError={fieldError}
        error={error}
        firearm={firearm}
        firearms={firearms}
        classifications={classifications}
        aliases={aliases}
        codes={codes}
        discardEditor={discardEditor}
        setDiscardEditor={setDiscardEditor}
        saveEditor={saveEditor}
        statusTarget={statusTarget}
        setStatusTarget={setStatusTarget}
        runWrite={runWrite}
        pendingSwitch={pendingSwitch}
        setPendingSwitch={setPendingSwitch}
        applySwitch={applySwitch}
        termsOpen={termsOpen}
        setTermsOpen={setTermsOpen}
        closeMediaPicker={closeMediaPicker}
        startEditor={startEditor}
        mediaPicking={mediaPicking}
        mediaOptions={mediaOptions}
        mediaError={mediaError}
        mediaLoading={mediaLoading}
        mediaNextCursor={mediaNextCursor}
        mediaRetryCursor={mediaRetryCursor}
        openMediaPicker={openMediaPicker}
        loadMediaPage={loadMediaPage}
      />
    </div>
  );
}
