import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  adminRequest,
  friendlyError,
  hasPermission,
  type AdminGunsmithAlias,
  type AdminGunsmithClassification,
  type AdminGunsmithCode,
  type AdminGunsmithFirearm,
  type AdminGunsmithResponse,
  type CatalogMediaOption,
  type MediaOptionsResponse,
  type SessionSnapshot,
  type SupplyGame,
} from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

type EditorKind = "classification" | "firearm" | "alias" | "code";
type Editor = { kind: EditorKind; id?: string; firearmId?: string; values: Record<string, string> };

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;
const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";
const codeClass = "w-full min-h-24 p-2 rounded border border-border bg-surface-raised text-xs font-mono";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="space-y-1 text-xs block"><span className="text-muted-foreground">{label}</span>{children}{hint ? <span className="block text-[11px] text-muted-foreground/80">{hint}</span> : null}</label>;
}

function valuesFor(kind: EditorKind, record?: Record<string, unknown>): Record<string, string> {
  const value = (key: string, fallback = "") => record?.[key] === null || record?.[key] === undefined ? fallback : String(record[key]);
  if (kind === "classification") return { code: value("code"), name: value("name"), sortOrder: value("sortOrder", "0"), enabled: value("enabled", "true"), revision: value("revision") };
  if (kind === "firearm") return { code: value("code"), name: value("name"), classificationId: value("classificationId"), mediaId: value("mediaId"), sortOrder: value("sortOrder", "0"), enabled: value("enabled", "true"), revision: value("revision") };
  if (kind === "alias") return { locale: value("locale", "zh-CN"), name: value("name"), sortOrder: value("sortOrder", "0"), enabled: value("enabled", "true"), revision: value("revision") };
  return { code: value("code"), note: value("note"), modeCode: value("modeCode"), lastReviewedAt: value("lastReviewedAt"), revision: value("revision") };
}

function labelFor(kind: EditorKind): string {
  return kind === "classification" ? "枪械分类" : kind === "firearm" ? "枪械" : kind === "alias" ? "别名" : "改枪码";
}

function modeLabel(mode: AdminGunsmithCode["modeCode"]): string {
  return mode === "HAZARD" ? "烽火地带" : mode === "BATTLEFIELD" ? "全面战场" : mode === "GENERAL" ? "通用" : "未标注";
}

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
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [data, setData] = useState<AdminGunsmithResponse | null>(null);
  const [firearmId, setFirearmId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [mediaOptions, setMediaOptions] = useState<CatalogMediaOption[]>([]);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaOptionsLoading, setMediaOptionsLoading] = useState(false);
  const [mediaOptionsError, setMediaOptionsError] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [dataLoading, setDataLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const gamesSeq = useRef(0);
  const gamesAbort = useRef<AbortController | null>(null);
  const dataSeq = useRef(0);
  const dataAbort = useRef<AbortController | null>(null);
  const mediaSeq = useRef(0);
  const mediaAbort = useRef<AbortController | null>(null);
  const mediaInFlight = useRef<string | null>(null);
  const saveSeq = useRef(0);
  const saveAbort = useRef<AbortController | null>(null);
  const gameIdRef = useRef(gameId);
  const editorRef = useRef(editor);
  const mediaContextRef = useRef("");
  gameIdRef.current = gameId;
  editorRef.current = editor;
  const editorIdentity = editor ? `${editor.kind}:${editor.id ?? "new"}:${editor.firearmId ?? ""}` : "none";
  const mediaContextKey = `${gameId}:${editorIdentity}`;
  mediaContextRef.current = mediaContextKey;

  const loadGames = useCallback(async () => {
    const requestSeq = ++gamesSeq.current;
    gamesAbort.current?.abort();
    const controller = new AbortController();
    gamesAbort.current = controller;
    try {
      const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games", undefined, undefined, {}, controller.signal);
      if (controller.signal.aborted || requestSeq !== gamesSeq.current) return;
      setGames(result.games);
      setGameId((current) => current && result.games.some((game) => game.id === current) ? current : result.games.find((game) => game.code === "delta")?.id ?? result.games[0]?.id ?? "");
    } catch (failure) {
      if (controller.signal.aborted || requestSeq !== gamesSeq.current) return;
      throw failure;
    } finally {
      if (gamesAbort.current === controller) gamesAbort.current = null;
    }
  }, []);

  const loadData = useCallback(async (targetGameId: string) => {
    const requestSeq = ++dataSeq.current;
    dataAbort.current?.abort();
    if (!targetGameId) { setData(null); return requestSeq; }
    const controller = new AbortController();
    dataAbort.current = controller;
    try {
      const result = await adminRequest<AdminGunsmithResponse>(`/supply/games/${targetGameId}/firearms`, undefined, undefined, {}, controller.signal);
      if (controller.signal.aborted || requestSeq !== dataSeq.current || gameIdRef.current !== targetGameId) return requestSeq;
      setData(result);
      return requestSeq;
    } catch (failure) {
      if (controller.signal.aborted || requestSeq !== dataSeq.current || gameIdRef.current !== targetGameId) return requestSeq;
      throw failure;
    } finally {
      if (dataAbort.current === controller) dataAbort.current = null;
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    setError(undefined);
    void loadGames().catch((failure) => setError(friendlyError(failure)));
    return () => {
      gamesSeq.current += 1;
      gamesAbort.current?.abort();
    };
  }, [canManage, loadGames, refreshNonce]);

  useEffect(() => {
    setEditor(null);
    setFirearmId("");
    const targetGameId = gameId;
    setDataLoading(Boolean(targetGameId));
    if (!targetGameId) { setData(null); return; }
    void loadData(targetGameId).then((requestSeq) => {
      if (requestSeq === dataSeq.current && gameIdRef.current === targetGameId) setDataLoading(false);
    }).catch((failure) => {
      if (gameIdRef.current === targetGameId) {
        setError(friendlyError(failure));
        setDataLoading(false);
      }
    });
    return () => {
      dataSeq.current += 1;
      dataAbort.current?.abort();
      setDataLoading(false);
    };
  }, [gameId, loadData, refreshNonce]);

  useEffect(() => {
    mediaSeq.current += 1;
    mediaAbort.current?.abort();
    mediaAbort.current = null;
    mediaInFlight.current = null;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(false);
    setSaving(false);
    saveSeq.current += 1;
    saveAbort.current?.abort();
    saveAbort.current = null;
  }, [gameId, editorIdentity]);

  useEffect(() => () => {
    gamesSeq.current += 1;
    gamesAbort.current?.abort();
    dataSeq.current += 1;
    dataAbort.current?.abort();
    mediaSeq.current += 1;
    mediaAbort.current?.abort();
    saveSeq.current += 1;
    saveAbort.current?.abort();
  }, []);

  useEffect(() => {
    onDirtyChange(Boolean(editor));
    return () => onDirtyChange(false);
  }, [editor, onDirtyChange]);

  const game = games.find((entry) => entry.id === gameId);
  const service = game?.services?.find((entry) => entry.serviceCode === "GUNSMITH");
  const selectedFirearm = data?.firearms.find((entry) => entry.id === firearmId) ?? data?.firearms[0] ?? null;
  const selectedAliases = useMemo(() => data?.aliases.filter((entry) => entry.firearmId === selectedFirearm?.id) ?? [], [data, selectedFirearm?.id]);
  const selectedCodes = useMemo(() => data?.codes.filter((entry) => entry.firearmId === selectedFirearm?.id) ?? [], [data, selectedFirearm?.id]);
  const editorFirearm = editor?.firearmId ? data?.firearms.find((entry) => entry.id === editor.firearmId) ?? null : null;

  const reload = async () => {
    const targetGameId = gameIdRef.current;
    if (!targetGameId) return;
    setError(undefined);
    setDataLoading(true);
    try {
      const requestSeq = await loadData(targetGameId);
      if (requestSeq === dataSeq.current && gameIdRef.current === targetGameId) setDataLoading(false);
    } catch (failure) {
      if (gameIdRef.current === targetGameId) {
        setError(friendlyError(failure));
        setDataLoading(false);
      }
    }
  };

  const toggleService = async () => {
    if (!gameId || !service) return;
    setError(undefined);
    try {
      await adminRequest(`/supply/games/${gameId}/services/GUNSMITH`, { expectedRevision: service.revision, enabled: !service.enabled }, "PUT");
      setSuccess(service.enabled ? "改枪码公开服务已停用；历史目录仍可维护。" : "改枪码公开服务已启用。租赁发布开关不受影响。");
      await loadGames();
    } catch (failure) { setError(friendlyError(failure)); }
  };

  const openCreate = (kind: EditorKind) => {
    if ((kind === "alias" || kind === "code") && !selectedFirearm) { setError("请先选择一把枪械。"); return; }
    setError(undefined);
    setEditor({ kind, firearmId: kind === "alias" || kind === "code" ? selectedFirearm?.id : undefined, values: valuesFor(kind) });
  };

  const closeMediaPicker = () => {
    mediaSeq.current += 1;
    mediaAbort.current?.abort();
    mediaAbort.current = null;
    mediaInFlight.current = null;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(false);
  };

  const loadMediaOptions = useCallback(async (cursor: string | null = null) => {
    const targetGameId = gameIdRef.current;
    if (!targetGameId) return;
    const contextKey = mediaContextRef.current;
    const requestKey = `${contextKey}:${cursor ?? "first"}`;
    if (mediaInFlight.current === requestKey) return;
    mediaSeq.current += 1;
    const requestSeq = mediaSeq.current;
    mediaAbort.current?.abort();
    const controller = new AbortController();
    mediaAbort.current = controller;
    mediaInFlight.current = requestKey;
    setMediaOptionsLoading(true);
    setMediaOptionsError(undefined);
    const active = () => !controller.signal.aborted && requestSeq === mediaSeq.current && gameIdRef.current === targetGameId && mediaContextRef.current === contextKey;
    try {
      const params = new URLSearchParams({ purpose: "FIREARM_MEDIA", limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<MediaOptionsResponse>(`/supply/games/${targetGameId}/media-options?${params.toString()}`, undefined, undefined, {}, controller.signal);
      if (!active()) return;
      setMediaOptions((current) => cursor ? [...current, ...result.items] : result.items);
      setMediaNextCursor(result.nextCursor);
    } catch (failure) {
      if (active()) {
        setMediaOptionsError(friendlyError(failure));
        if (!cursor) { setMediaOptions([]); setMediaNextCursor(null); }
      }
    } finally {
      if (active()) setMediaOptionsLoading(false);
      if (mediaAbort.current === controller) mediaAbort.current = null;
      if (mediaInFlight.current === requestKey) mediaInFlight.current = null;
    }
  }, []);

  const pickMedia = (mediaId: string) => {
    if (!editor) return;
    setEditor({ ...editor, values: { ...editor.values, mediaId } });
    closeMediaPicker();
  };

  const openEdit = (kind: EditorKind, record: Record<string, unknown>) => {
    setError(undefined);
    setEditor({ kind, id: String(record.id), firearmId: kind === "alias" || kind === "code" ? String(record.firearmId ?? "") || undefined : undefined, values: valuesFor(kind, record) });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !gameId) return;
    const targetEditor = editor;
    const targetGameId = gameId;
    const targetFirearmId = targetEditor.firearmId;
    const requestSeq = ++saveSeq.current;
    saveAbort.current?.abort();
    const controller = new AbortController();
    saveAbort.current = controller;
    const values = editor.values;
    const name = values.name ?? "";
    const code = values.code ?? "";
    if ((editor.kind === "classification" || editor.kind === "firearm") && !editor.id && !CODE_PATTERN.test(values.code ?? "")) { setError("稳定 code 需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。"); return; }
    if ((editor.kind === "classification" || editor.kind === "firearm" || editor.kind === "alias") && !name.trim()) { setError("名称不能为空。"); return; }
    if (editor.kind === "code" && code.trim().length < 4) { setError("改枪码至少需要 4 个字符。"); return; }
    if ((editor.kind === "alias" || editor.kind === "code") && !targetFirearmId) { setError("请保留此表单绑定的枪械后再保存。"); return; }
    setSaving(true);
    setError(undefined);
    const active = () => !controller.signal.aborted && requestSeq === saveSeq.current && gameIdRef.current === targetGameId && editorRef.current === targetEditor;
    try {
      let path: string;
      let body: Record<string, unknown>;
      if (editor.kind === "classification") {
        path = editor.id ? `/supply/firearm-classifications/${editor.id}` : `/supply/games/${gameId}/firearm-classifications`;
        body = editor.id ? { expectedRevision: values.revision, name: name.trim(), enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) } : { code, name: name.trim(), enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) };
      } else if (editor.kind === "firearm") {
        path = editor.id ? `/supply/firearms/${editor.id}` : `/supply/games/${gameId}/firearms`;
        body = editor.id ? { expectedRevision: values.revision, name: name.trim(), classificationId: values.classificationId || null, mediaId: values.mediaId || null, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) } : { code, name: name.trim(), classificationId: values.classificationId || null, mediaId: values.mediaId || null, enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) };
      } else if (editor.kind === "alias") {
        path = editor.id ? `/supply/firearm-aliases/${editor.id}` : `/supply/games/${gameId}/firearms/${targetFirearmId}/aliases`;
        body = editor.id ? { expectedRevision: values.revision, name: name.trim(), enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) } : { locale: values.locale || "zh-CN", name: name.trim(), enabled: values.enabled === "true", sortOrder: Number(values.sortOrder) };
      } else {
        path = editor.id ? `/supply/gunsmith/codes/${editor.id}` : "/supply/gunsmith/codes";
        body = editor.id ? { expectedRevision: values.revision, code: values.code, note: values.note, modeCode: values.modeCode || null, ...(values.lastReviewedAt ? { lastReviewedAt: values.lastReviewedAt } : { lastReviewedAt: null }) } : { gameId, firearmId: targetFirearmId, code: values.code, note: values.note, modeCode: values.modeCode || null, ...(values.lastReviewedAt ? { lastReviewedAt: values.lastReviewedAt } : {}) };
      }
      await adminRequest(path, body, editor.id ? "PUT" : "POST", {}, controller.signal);
      if (!active()) return;
      setSaving(false);
      setEditor(null);
      setSuccess(`${labelFor(editor.kind)}已${editor.id ? "更新" : "创建"}；稳定 ID 与历史记录保持不变。`);
      await reload();
    } catch (failure) {
      if (active()) setError(friendlyError(failure));
    } finally {
      if (active()) setSaving(false);
      if (saveAbort.current === controller) saveAbort.current = null;
    }
  };

  const toggle = async (kind: "classification" | "firearm" | "alias", record: { id: string; enabled: boolean; revision: string }) => {
    try {
      const path = kind === "classification" ? `/supply/firearm-classifications/${record.id}` : kind === "firearm" ? `/supply/firearms/${record.id}` : `/supply/firearm-aliases/${record.id}`;
      await adminRequest(path, { expectedRevision: record.revision, enabled: !record.enabled }, "PUT");
      await reload();
    } catch (failure) { setError(friendlyError(failure)); }
  };

  const toggleCode = async (record: AdminGunsmithCode) => {
    try {
      await adminRequest(`/supply/gunsmith/codes/${record.id}/${record.status === "ACTIVE" ? "withdraw" : "restore"}`, { expectedRevision: record.revision });
      await reload();
    } catch (failure) { setError(friendlyError(failure)); }
  };

  if (!canManage) return <section className="section-panel"><StatusMessage error="当前账号没有改枪码目录维护权限。" /></section>;

  return <div className="space-y-6">
    <section className="section-panel">
      <div className="panel-heading"><div><h3>改枪码目录</h3><p>枪械是共享稳定实体；改枪码只引用枪械，不进入计费物品或皮肤目录。代码定义类型与关系，管理员只能维护已定义字段。</p></div></div>
      <div className="flex flex-wrap items-end gap-3 mt-4">
        <Field label="游戏"><select className={selectClass} value={gameId} onChange={(event) => setGameId(event.target.value)}><option value="">暂无可维护游戏</option>{games.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}（{entry.code}）</option>)}</select></Field>
        {service ? <div className="flex items-center gap-2 pb-1"><span className={service.enabled && service.supported ? "text-emerald-400 text-xs" : "text-muted-foreground text-xs"}>{service.supported ? (service.enabled ? "公开服务已启用" : "公开服务已停用") : "该游戏未完成适配"}</span><Button type="button" size="sm" variant="secondary" disabled={!service.supported} onClick={() => void toggleService()}>{service.enabled ? "停用服务" : "启用服务"}</Button></div> : <span className="text-xs text-muted-foreground pb-2">服务状态不可用，请先应用 API 迁移。</span>}
      </div>
      <StatusMessage error={error} success={success} className="mt-3" />
    </section>

    {data ? <>
      <section className="section-panel">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3>分类与枪械</h3><p className="text-xs text-muted-foreground mt-1">分类可排序、停用；枪械名称和图片绑定变化会沿稳定 firearm ID 被改枪码与详情共同读取。</p>{dataLoading ? <p className="text-xs text-muted-foreground mt-1">正在读取当前游戏目录…</p> : null}</div><div className="flex gap-2"><Button type="button" size="sm" variant="secondary" onClick={() => openCreate("classification")}>新增分类</Button><Button type="button" size="sm" onClick={() => openCreate("firearm")}>新增枪械</Button></div></div>
        {data.classifications.length > 0 ? <div className="table-wrap mt-4"><table className="data-table"><thead><tr><th>分类</th><th>code</th><th>排序</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.classifications.map((row) => <tr key={row.id}><td>{row.name}</td><td className="font-mono text-[11px]">{row.code}</td><td>{row.sortOrder}</td><td><button type="button" className={row.enabled ? "text-emerald-400" : "text-muted-foreground"} onClick={() => void toggle("classification", row)}>{row.enabled ? "启用" : "停用"}</button></td><td><Button type="button" size="sm" variant="secondary" onClick={() => openEdit("classification", row as unknown as Record<string, unknown>)}>编辑</Button></td></tr>)}</tbody></table></div> : <p className="text-xs text-muted-foreground py-5">暂无枪械分类。</p>}
        {data.firearms.length > 0 ? <div className="table-wrap mt-4"><table className="data-table"><thead><tr><th>枪械</th><th>分类</th><th>code</th><th>图片</th><th>改枪码</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.firearms.map((row) => <tr key={row.id}><td><button type="button" className="underline underline-offset-2" onClick={() => setFirearmId(row.id)}>{row.name}</button></td><td>{row.classificationName ?? <span className="text-muted-foreground">未分类</span>}</td><td className="font-mono text-[11px]">{row.code}</td><td className="font-mono text-[11px]">{row.mediaId ? "已绑定" : "未绑定"}</td><td>{row.codeCount ?? 0}</td><td><button type="button" className={row.enabled ? "text-emerald-400" : "text-muted-foreground"} onClick={() => void toggle("firearm", row)}>{row.enabled ? "启用" : "停用"}</button></td><td><Button type="button" size="sm" variant="secondary" onClick={() => openEdit("firearm", row as unknown as Record<string, unknown>)}>编辑</Button></td></tr>)}</tbody></table></div> : <p className="text-xs text-muted-foreground py-5">暂无枪械；改枪码不能脱离枪械父实体单独创建。</p>}
      </section>

      <section className="section-panel">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3>枪械关联</h3><p className="text-xs text-muted-foreground mt-1">当前选择：{selectedFirearm?.name ?? "未选择"}。别名用于检索；改枪码按模式标注但不做自动导入或价格计算。</p></div><div className="flex gap-2"><select className={selectClass} value={selectedFirearm?.id ?? ""} onChange={(event) => setFirearmId(event.target.value)}><option value="">选择枪械</option>{data.firearms.map((row) => <option key={row.id} value={row.id}>{row.name}（{row.code}）</option>)}</select><Button type="button" size="sm" variant="secondary" onClick={() => openCreate("alias")}>新增别名</Button><Button type="button" size="sm" onClick={() => openCreate("code")}>新增改枪码</Button></div></div>
        {selectedFirearm ? <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
          <div><h4 className="text-xs font-semibold mb-2">别名</h4>{selectedAliases.length === 0 ? <p className="text-xs text-muted-foreground">暂无别名。</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>名称</th><th>语言</th><th>状态</th><th>操作</th></tr></thead><tbody>{selectedAliases.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.locale}</td><td><button type="button" className={row.enabled ? "text-emerald-400" : "text-muted-foreground"} onClick={() => void toggle("alias", row)}>{row.enabled ? "启用" : "停用"}</button></td><td><Button type="button" size="sm" variant="secondary" onClick={() => openEdit("alias", row as unknown as Record<string, unknown>)}>编辑</Button></td></tr>)}</tbody></table></div>}</div>
          <div><h4 className="text-xs font-semibold mb-2">改枪码</h4>{selectedCodes.length === 0 ? <p className="text-xs text-muted-foreground">暂无改枪码。</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>模式</th><th>代码</th><th>状态</th><th>操作</th></tr></thead><tbody>{selectedCodes.map((row) => <tr key={row.id}><td>{modeLabel(row.modeCode)}</td><td><code className="block max-w-[26rem] whitespace-pre-wrap break-all text-[11px]">{row.code}</code>{row.note ? <span className="text-[11px] text-muted-foreground">{row.note}</span> : null}</td><td><button type="button" className={row.status === "ACTIVE" ? "text-emerald-400" : "text-muted-foreground"} onClick={() => void toggleCode(row)}>{row.status === "ACTIVE" ? "启用" : "撤回"}</button></td><td><Button type="button" size="sm" variant="secondary" onClick={() => openEdit("code", row as unknown as Record<string, unknown>)}>编辑</Button></td></tr>)}</tbody></table></div>}</div>
        </div> : <p className="text-xs text-muted-foreground py-5">请选择枪械后维护别名与改枪码。</p>}
      </section>
    </> : null}

    {editor ? <section className="section-panel"><form onSubmit={save} className="space-y-3"><div className="flex items-center justify-between"><h3>{editor.id ? `编辑${labelFor(editor.kind)}` : `新增${labelFor(editor.kind)}`}</h3><Button type="button" size="sm" variant="secondary" onClick={() => setEditor(null)}>取消</Button></div>{editor.kind === "alias" || editor.kind === "code" ? <p className="text-xs text-muted-foreground">所属枪械：{editorFirearm?.name ?? editor.firearmId ?? "未找到"}；切换上方选择不会改变此表单归属。</p> : null}<fieldset disabled={saving}><div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {(editor.kind === "classification" || editor.kind === "firearm") ? <Field label="稳定 code" hint={editor.id ? "创建后不可修改" : "小写字母开头，仅字母数字 _ : -"}><input className={inputClass} disabled={Boolean(editor.id)} value={editor.values.code} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, code: event.target.value } })} /></Field> : null}
      {(editor.kind === "classification" || editor.kind === "firearm" || editor.kind === "alias") ? <Field label="名称"><input className={inputClass} value={editor.values.name} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, name: event.target.value } })} /></Field> : null}
      {editor.kind === "alias" && !editor.id ? <Field label="语言"><input className={inputClass} value={editor.values.locale} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, locale: event.target.value } })} /></Field> : null}
      {editor.kind === "firearm" ? <><Field label="分类"><select className={selectClass} value={editor.values.classificationId} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, classificationId: event.target.value } })}><option value="">未分类</option>{data?.classifications.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field label="已审核公开图片 ID" hint="仅接受 FIREARM_MEDIA 的平台公开衍生图；撤权后自动降级为无图"><input className={inputClass} value={editor.values.mediaId} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, mediaId: event.target.value } })} /></Field><div className="md:col-span-3 border border-border rounded p-3 space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">图片选择器只列出当前游戏、FIREARM_MEDIA、已审核且允许公开的衍生图。</span><div className="flex gap-2">{editor.values.mediaId ? <Button type="button" size="sm" variant="secondary" onClick={() => setEditor({ ...editor, values: { ...editor.values, mediaId: "" } })}>解除绑定</Button> : null}<Button type="button" size="sm" variant="secondary" onClick={() => { setMediaPickerOpen(true); void loadMediaOptions(); }}>选择图片</Button></div></div>{editor.values.mediaId ? <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><img src={`/api/v1/supply/media/${editor.values.mediaId}/content`} alt="当前枪械公开图片" className="w-16 h-16 object-cover rounded border border-border" /><span className="font-mono truncate">{editor.values.mediaId}</span></div> : <p className="text-xs text-muted-foreground">当前未绑定图片；公开页将使用无图降级。</p>}{mediaPickerOpen ? <div className="space-y-2"><div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">候选图来自现有媒体审核链，目录管理员不获得私有凭证权限。</span><Button type="button" size="sm" variant="ghost" onClick={closeMediaPicker}>关闭</Button></div><StatusMessage error={mediaOptionsError} />{mediaOptionsLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}{!mediaOptionsLoading && !mediaOptionsError && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">暂无可绑定图片，请先审核公开 FIREARM_MEDIA 素材。</p> : null}{mediaOptions.length > 0 ? <><div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{mediaOptions.map((option) => <button type="button" key={option.id} className="rounded border border-border overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/70" onClick={() => pickMedia(option.id)}><img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="w-full h-16 object-cover" /><span className="block px-1.5 py-1 text-[10px] text-muted-foreground font-mono truncate">{option.id.slice(0, 18)}… · {option.width}×{option.height}</span></button>)}</div>{mediaNextCursor ? <div className="flex justify-end"><Button type="button" size="sm" variant="secondary" loading={mediaOptionsLoading} onClick={() => void loadMediaOptions(mediaNextCursor)}>加载更多</Button></div> : null}</> : null}</div> : null}</div></> : null}
      {editor.kind === "code" ? <><Field label="改枪码" hint="按原样保存，不解析、不验证游戏导入结果"><textarea className={codeClass} required value={editor.values.code} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, code: event.target.value } })} /></Field><Field label="模式"><select className={selectClass} value={editor.values.modeCode} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, modeCode: event.target.value } })}><option value="">未标注</option><option value="HAZARD">烽火地带</option><option value="BATTLEFIELD">全面战场</option><option value="GENERAL">通用</option></select></Field><Field label="备注"><textarea className={codeClass} value={editor.values.note} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, note: event.target.value } })} /></Field><Field label="最近核验时间" hint="RFC3339，例如 2026-09-14T12:00:00Z"><input className={inputClass} value={editor.values.lastReviewedAt} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, lastReviewedAt: event.target.value } })} /></Field></> : null}
      {editor.kind !== "code" ? <><Field label="排序"><input className={inputClass} type="number" value={editor.values.sortOrder} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sortOrder: event.target.value } })} /></Field><Field label="状态"><select className={selectClass} value={editor.values.enabled} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, enabled: event.target.value } })}><option value="true">启用</option><option value="false">停用</option></select></Field></> : null}
    </div></fieldset><Button type="submit" size="sm" loading={saving} disabled={saving}>保存</Button></form></section> : null}
  </div>;
}
