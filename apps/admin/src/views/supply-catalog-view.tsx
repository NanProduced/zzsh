import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { adminRequest, friendlyError, hasPermission, type AdminCatalogResponse, type CatalogEntitlement, type CatalogItem, type CatalogMediaOption, type CatalogRarity, type CatalogSkin, type CatalogSkinCategory, type MediaOptionsResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

type CatalogKind = "items" | "categories" | "skins" | "rarities" | "entitlements";
type EditorState = { kind: CatalogKind; id?: string; values: Record<string, string> };

const TAB_LABELS: Record<CatalogKind, string> = {
  items: "计费物品",
  categories: "皮肤分类",
  skins: "皮肤",
  rarities: "稀有度",
  entitlements: "账号权益",
};

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="space-y-1 text-xs block">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";

function editorValuesFor(kind: CatalogKind, record?: Record<string, unknown>): Record<string, string> {
  const base: Record<string, string> = { code: "", name: "" };
  if (kind === "items") return { ...base, unit: "PIECE", quantityScale: "0", required: "false", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "", sourceNote: "" };
  if (kind === "categories") return { ...base, parentId: "", sortOrder: "0", enabled: "true", formVisible: "true" };
  if (kind === "skins") return { ...base, categoryId: "", rarityCode: "", sortOrder: "0", enabled: "true", formVisible: "true", sourceField: "", sourceToken: "" };
  if (kind === "rarities") return { ...base, sortOrder: "0", enabled: "true" };
  return { ...base, valueKind: "FLAG", expiryKind: "PERMANENT", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "" };
}

function recordValues(kind: CatalogKind, record: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) values[key] = "";
    else values[key] = typeof value === "boolean" ? String(value) : String(value);
  }
  return values;
}

function toPayload(kind: CatalogKind, values: Record<string, string>, editing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const put = (field: string, key: string, parse: (value: string) => unknown = (value) => value) => {
    if (values[field] === undefined || values[field] === "") return;
    payload[key] = parse(values[field]!);
  };
  if (!editing) {
    payload.code = values.code;
  }
  payload.name = values.name;
  if (kind === "items") {
    put("unit", "unit");
    put("quantityScale", "quantityScale", Number);
    put("required", "required", (value) => value === "true");
    put("enabled", "enabled", (value) => value === "true");
    put("sortOrder", "sortOrder", Number);
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
    put("sourceNote", "sourceNote");
    // Editing only: mediaId binds an approved public ITEM_MEDIA asset; an empty
    // value unbinds. New items are created without an image.
    if (editing && values.mediaId !== undefined) {
      payload.mediaId = values.mediaId === "" ? null : values.mediaId;
    }
  } else if (kind === "categories") {
    payload.parentId = values.parentId === "" ? null : values.parentId;
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("formVisible", "formVisible", (value) => value === "true");
  } else if (kind === "skins") {
    put("categoryId", "categoryId");
    payload.rarityCode = values.rarityCode === "" ? null : values.rarityCode;
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("formVisible", "formVisible", (value) => value === "true");
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
  } else if (kind === "rarities") {
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
  } else {
    put("valueKind", "valueKind");
    put("expiryKind", "expiryKind");
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
  }
  return payload;
}

function validateEditor(kind: CatalogKind, values: Record<string, string>, editing: boolean): string | undefined {
  if (!editing && !CODE_PATTERN.test(values.code ?? "")) return "稳定 code 需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。";
  if (!values.name || values.name.trim().length === 0) return "名称不能为空。";
  if (kind === "items" && !["HAFF_BASE", "ROUND", "PIECE", "DAY"].includes(values.unit ?? "")) return "单位无效。";
  if (kind === "skins" && !values.categoryId) return "皮肤必须选择所属分类。";
  return undefined;
}

export function SupplyCatalogView({
  snapshot,
  onDirtyChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
}) {
  const canManage = hasPermission(snapshot, "supply.catalog.manage");
  const isBoss = snapshot.security.isBoss;
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [catalog, setCatalog] = useState<AdminCatalogResponse | null>(null);
  const [tab, setTab] = useState<CatalogKind>("items");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [gameDraft, setGameDraft] = useState({ code: "", name: "", description: "" });
  const [mediaOptions, setMediaOptions] = useState<CatalogMediaOption[]>([]);
  const [mediaOptionsLoading, setMediaOptionsLoading] = useState(false);
  const [mediaOptionsError, setMediaOptionsError] = useState<string>();
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  // Monotonic sequence guards against late responses: any fetch only commits
  // its result when the sequence still matches. The media picker lifecycle is
  // bound to the editor identity (kind+id) and the selected game, NOT to every
  // draft keystroke, so typing in ordinary fields must not reset the picker.
  const mediaPickSeq = useRef(0);
  const editorIdentity = editor ? `${editor.kind}:${editor.id ?? ""}` : null;
  // Cursor of the most recent request; kept when the request fails so the "重试"
  // button reloads exactly the failed page (null = first page).
  const [mediaRetryCursor, setMediaRetryCursor] = useState<string | null>(null);

  const loadGames = useCallback(async () => {
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    setGames(result.games);
    setGameId((current) => (current && result.games.some((game) => game.id === current) ? current : result.games[0]?.id ?? ""));
  }, []);

  const loadCatalog = useCallback(async (targetGameId: string) => {
    if (!targetGameId) {
      setCatalog(null);
      return;
    }
    setCatalog(await adminRequest<AdminCatalogResponse>(`/supply/games/${targetGameId}/catalog`));
  }, []);

  useEffect(() => {
    if (!canManage) return;
    setError(undefined);
    loadGames().catch((failure) => setError(friendlyError(failure)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, refreshNonce]);

  useEffect(() => {
    if (!gameId) {
      setCatalog(null);
      return;
    }
    setError(undefined);
    setLoading(true);
    loadCatalog(gameId)
      .catch((failure) => setError(friendlyError(failure)))
      .finally(() => setLoading(false));
  }, [gameId, loadCatalog, refreshNonce]);

  useEffect(() => {
    onDirtyChange(Boolean(editor));
    return () => onDirtyChange(false);
  }, [editor, onDirtyChange]);

  const createGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    if (!CODE_PATTERN.test(gameDraft.code)) {
      setError("游戏 code 无效：需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。");
      return;
    }
    if (!gameDraft.name.trim()) {
      setError("游戏名称不能为空。");
      return;
    }
    setLoading(true);
    try {
      await adminRequest("/supply/games", { code: gameDraft.code, name: gameDraft.name.trim(), ...(gameDraft.description.trim() ? { description: gameDraft.description.trim() } : {}) });
      setSuccess("游戏已创建；目录从空开始，旧资料需按来源映射另行核验。");
      setGameDraft({ code: "", name: "", description: "" });
      await loadGames();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const openCreate = (kind: CatalogKind) => {
    if (kind === "skins" && (catalog?.categories.length ?? 0) === 0) {
      setError("请先维护至少一个皮肤分类，再创建皮肤。");
      return;
    }
    setSuccess(undefined);
    setEditor({ kind, values: editorValuesFor(kind) });
  };

  const openEdit = (kind: CatalogKind, record: CatalogItem | CatalogSkinCategory | CatalogSkin | CatalogRarity | CatalogEntitlement) => {
    setSuccess(undefined);
    setEditor({ kind, id: record.id, values: { ...editorValuesFor(kind), ...recordValues(kind, record as unknown as Record<string, unknown>) } });
  };

  const saveEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const validation = validateEditor(editor.kind, editor.values, Boolean(editor.id));
    if (validation) {
      setError(validation);
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const payload = toPayload(editor.kind, editor.values, Boolean(editor.id));
      if (editor.id) {
        await adminRequest(`/supply/${editor.kind}/${editor.id}`, payload, "PUT");
        setSuccess(`${TAB_LABELS[editor.kind]}已更新；稳定 code 不会随改名改变。`);
      } else {
        await adminRequest(`/supply/games/${gameId}/${EDITOR_COLLECTION[editor.kind]}`, payload);
        setSuccess(`${TAB_LABELS[editor.kind]}已创建。`);
      }
      setEditor(null);
      await loadCatalog(gameId);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (kind: CatalogKind, record: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => {
    setError(undefined);
    try {
      await adminRequest(`/supply/${kind}/${record.id}`, { [field]: !record[field] }, "PUT");
      await loadCatalog(gameId);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  useEffect(() => {
    // Editor identity or game changed (not draft values): dismiss the picker,
    // invalidate any in-flight request and clear every transient state so a
    // late response can never reach the current editor's picker.
    mediaPickSeq.current += 1;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  }, [editorIdentity, gameId]);

  const dismissMediaPicker = () => {
    mediaPickSeq.current += 1;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  };

  const loadMediaOptionsPage = async (cursor: string | null) => {
    if (!editor || editor.kind !== "items" || !editor.id || !gameId) return;
    if (!cursor) {
      // A fresh open clears stale candidates before the request starts.
      setMediaOptions([]);
      setMediaNextCursor(null);
    }
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(true);
    setMediaRetryCursor(cursor);
    const seq = ++mediaPickSeq.current;
    try {
      const params = new URLSearchParams({ purpose: "ITEM_MEDIA", limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<MediaOptionsResponse>(`/supply/games/${gameId}/media-options?${params.toString()}`);
      if (seq !== mediaPickSeq.current) return;
      setMediaOptions((current) => (cursor ? [...current, ...result.items] : result.items));
      setMediaNextCursor(result.nextCursor);
      setMediaRetryCursor(null);
    } catch (failure) {
      if (seq !== mediaPickSeq.current) return;
      setMediaOptionsError(friendlyError(failure));
      if (!cursor) {
        // No stale candidates may remain clickable when the first load fails.
        setMediaOptions([]);
        setMediaNextCursor(null);
      }
      // mediaRetryCursor stays at the failed cursor so the retry reloads it.
    } finally {
      if (seq === mediaPickSeq.current) setMediaOptionsLoading(false);
    }
  };

  const openMediaPicker = () => {
    if (!editor || editor.kind !== "items" || !editor.id) return;
    setMediaPickerOpen(true);
    void loadMediaOptionsPage(null);
  };

  const pickMedia = (mediaId: string) => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId } });
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  };

  const unbindMedia = () => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId: "" } });
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
    setSuccess("已解除绑定；保存成功后目录将不再投影该图片。");
  };

  const categories = catalog?.categories ?? [];
  const descendantsOf = useMemo(() => {
    if (!editor || editor.kind !== "categories" || !editor.id) return new Set<string>();
    const result = new Set<string>([editor.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const category of categories) {
        if (category.parentId && result.has(category.parentId) && !result.has(category.id)) {
          result.add(category.id);
          changed = true;
        }
      }
    }
    return result;
  }, [categories, editor]);

  if (!canManage) {
    return <section className="section-panel"><StatusMessage error="当前账号没有供给目录维护权限；Boss 也需按游戏对象范围操作。" /></section>;
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>目录维护</h3>
            <p>计费物品、皮肤分类、皮肤与权益分开维护；稳定 code 创建后不可改名；已引用词条只能停用，不能物理删除。皮肤与稀有度不参与自动定价。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-4">
          <Field label="游戏">
            <select value={gameId} onChange={(event) => { setEditor(null); setGameId(event.target.value); }} className={selectClass}>
              {games.length === 0 ? <option value="">暂无可维护游戏</option> : null}
              {games.map((game) => <option key={game.id} value={game.id}>{game.name}（{game.code}）</option>)}
            </select>
          </Field>
          {catalog ? <span className="text-[11px] text-muted-foreground pb-2">目录版本 {catalog.game.catalogRevision}{catalog.game.enabled ? "" : " · 已停用"}</span> : null}
        </div>
        <StatusMessage error={error} success={success} className="mt-3" />
      </section>

      {isBoss && games.length === 0 ? (
        <section className="section-panel">
          <h3 className="text-sm font-semibold mb-2">创建首个游戏</h3>
          <form onSubmit={createGame} className="grid grid-cols-1 md:grid-cols-3 gap-3" noValidate>
            <Field label="稳定 code"><input value={gameDraft.code} onChange={(event) => setGameDraft({ ...gameDraft, code: event.target.value })} className={inputClass} placeholder="delta" /></Field>
            <Field label="名称"><input value={gameDraft.name} onChange={(event) => setGameDraft({ ...gameDraft, name: event.target.value })} className={inputClass} placeholder="三角洲行动" /></Field>
            <Field label="描述（可选）"><input value={gameDraft.description} onChange={(event) => setGameDraft({ ...gameDraft, description: event.target.value })} className={inputClass} /></Field>
            <Button type="submit" size="sm" loading={loading}>创建游戏</Button>
          </form>
          {!isBoss ? <StatusMessage error="仅 Boss 可以创建游戏对象。" className="mt-3" /> : null}
        </section>
      ) : null}

      {catalog ? (
        <section className="section-panel">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAB_LABELS) as CatalogKind[]).map((kind) => (
              <Button key={kind} type="button" size="sm" variant={tab === kind ? "primary" : "secondary"} onClick={() => { setEditor(null); setTab(kind); }}>{TAB_LABELS[kind]}</Button>
            ))}
          </div>

          {editor ? (
            <form onSubmit={saveEditor} className="mt-4 border border-border rounded-md p-4 space-y-3">
              <h4 className="text-xs font-semibold">{editor.id ? `编辑${TAB_LABELS[editor.kind]}` : `新增${TAB_LABELS[editor.kind]}`}</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="稳定 code" hint={editor.id ? "已创建不可修改" : "小写字母开头，仅字母数字 _ : -"}>
                  <input value={editor.values.code} disabled={Boolean(editor.id)} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, code: event.target.value } })} className={inputClass} />
                </Field>
                <Field label="名称"><input value={editor.values.name} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, name: event.target.value } })} className={inputClass} /></Field>
                {editor.kind === "items" ? (
                  <Field label="单位">
                    <select value={editor.values.unit} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, unit: event.target.value } })} className={selectClass}>
                      <option value="HAFF_BASE">HAFF_BASE（哈夫币基础单位）</option>
                      <option value="ROUND">ROUND（发）</option>
                      <option value="PIECE">PIECE（件）</option>
                      <option value="DAY">DAY（天）</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "categories" ? (
                  <Field label="父分类">
                    <select value={editor.values.parentId ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, parentId: event.target.value } })} className={selectClass}>
                      <option value="">（一级分类）</option>
                      {categories.filter((category) => !descendantsOf.has(category.id)).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "skins" ? (
                  <>
                    <Field label="分类">
                      <select value={editor.values.categoryId} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, categoryId: event.target.value } })} className={selectClass}>
                        <option value="">请选择</option>
                        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                      </select>
                    </Field>
                    <Field label="稀有度（可空）">
                      <select value={editor.values.rarityCode ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, rarityCode: event.target.value } })} className={selectClass}>
                        <option value="">未标注（不默认金色）</option>
                        {(catalog.rarities ?? []).map((rarity) => <option key={rarity.id} value={rarity.code}>{rarity.name}</option>)}
                      </select>
                    </Field>
                  </>
                ) : null}
                {editor.kind === "entitlements" ? (
                  <>
                    <Field label="值类型">
                      <select value={editor.values.valueKind} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, valueKind: event.target.value } })} className={selectClass}>
                        <option value="FLAG">FLAG</option>
                        <option value="LEVEL">LEVEL</option>
                        <option value="CAPACITY">CAPACITY</option>
                      </select>
                    </Field>
                    <Field label="有效类型">
                      <select value={editor.values.expiryKind} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, expiryKind: event.target.value } })} className={selectClass}>
                        <option value="PERMANENT">PERMANENT</option>
                        <option value="TIMED">TIMED</option>
                      </select>
                    </Field>
                  </>
                ) : null}
                <Field label="排序"><input type="number" value={editor.values.sortOrder} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sortOrder: event.target.value } })} className={inputClass} /></Field>
                {"enabled" in editor.values ? (
                  <Field label="启用">
                    <select value={editor.values.enabled} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, enabled: event.target.value } })} className={selectClass}>
                      <option value="true">启用</option>
                      <option value="false">停用</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "categories" || editor.kind === "skins" ? (
                  <Field label="表单展示">
                    <select value={editor.values.formVisible} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, formVisible: event.target.value } })} className={selectClass}>
                      <option value="true">展示</option>
                      <option value="false">隐藏</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "items" ? (
                  <>
                    <Field label="发布必填"><select value={editor.values.required} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, required: event.target.value } })} className={selectClass}><option value="false">可选</option><option value="true">必填</option></select></Field>
                    <Field label="数量精度"><input type="number" min={0} max={6} value={editor.values.quantityScale} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, quantityScale: event.target.value } })} className={inputClass} /></Field>
                  </>
                ) : null}
                {editor.kind === "items" || editor.kind === "skins" ? (
                  <>
                    <Field label="旧来源字段（可选）"><input value={editor.values.sourceField ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceField: event.target.value } })} className={inputClass} placeholder="如 knifeSkin" /></Field>
                    <Field label="旧原始值（受限保留）"><input value={editor.values.sourceToken ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceToken: event.target.value } })} className={inputClass} /></Field>
                  </>
                ) : null}
              </div>
              {editor.kind === "items" && editor.id ? (
                <div className="mt-4 border border-border rounded-md p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold">物品图片</h4>
                    {editor.values.mediaId ? (
                      <Button type="button" size="sm" variant="secondary" onClick={unbindMedia}>解除绑定</Button>
                    ) : null}
                  </div>
                  {editor.values.mediaId ? (
                    <div className="flex items-center gap-3">
                      <span className="relative">
                        {/* Approved-public derivative only; never the private
                            evidence endpoint. A revoked asset renders 404 here. */}
                        <img
                          src={`/api/v1/supply/media/${editor.values.mediaId}/content`}
                          alt="当前绑定物品图"
                          className="w-20 h-20 object-cover rounded border border-border"
                          loading="lazy"
                          onLoad={(event) => {
                            event.currentTarget.style.display = "";
                            event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden");
                          }}
                          onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }}
                        />
                        <span data-fallback className="hidden text-[11px] text-muted-foreground">图片加载失败或已不可公开展示（临时网络问题也可能触发本提示）。保存后如需更换，可重新选择或解除绑定。</span>
                      </span>
                      <span className="text-[11px] text-muted-foreground font-mono truncate">{editor.values.mediaId}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">当前未绑定物品图；公开目录将不投影任何图片。</p>
                  )}
                  {mediaPickerOpen ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">服务端已按游戏与用途过滤：ITEM_MEDIA、已审核且允许公开（候选以公共衍生图预览，无需审核读取权限）。</span>
                        <Button type="button" size="sm" variant="ghost" onClick={dismissMediaPicker}>关闭</Button>
                      </div>
                      <StatusMessage error={mediaOptionsError} className="mt-1" />
                      {mediaOptionsLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
                      {!mediaOptionsLoading && !mediaOptionsError && mediaOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">没有可绑定图片；请先在“平台素材审核”上传并审核公开 ITEM_MEDIA 素材。</p>
                      ) : null}
                      {mediaOptions.length > 0 ? (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {mediaOptions.map((option) => (
                              <button type="button" key={option.id} className="rounded border border-border overflow-hidden text-left hover:border-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/70" onClick={() => pickMedia(option.id)}>
                                <span className="relative block">
                                  <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="w-full h-16 object-cover" loading="lazy"
                                    onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                                    onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                                  <span data-fallback className="hidden absolute inset-0 grid place-items-center text-[10px] text-muted-foreground bg-surface">预览不可用</span>
                                </span>
                                <span className="block px-1.5 py-1 text-[10px] text-muted-foreground font-mono truncate">{option.id.slice(0, 18)}… · {option.width}×{option.height} · {option.mime}</span>
                              </button>
                            ))}
                          </div>
                          <div className="flex justify-end">
                            {mediaNextCursor && !mediaOptionsError ? (
                              <Button type="button" size="sm" variant="secondary" loading={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaNextCursor)}>加载更多</Button>
                            ) : null}
                            {mediaOptionsError ? (
                              <Button type="button" size="sm" variant="secondary" loading={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaRetryCursor)}>重试</Button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" onClick={openMediaPicker}>选择图片</Button>
                  )}
                </div>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={loading}>保存</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setEditor(null)}>取消</Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end mt-4"><Button type="button" size="sm" onClick={() => openCreate(tab)}>新增{TAB_LABELS[tab]}</Button></div>
          )}

          <div className="mt-4">
            {tab === "items" ? (
              <CatalogTable
                rows={catalog.items}
                columns={["code", "name", "unit", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", unit: "单位", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("items", row)}
                onToggle={(row, field) => void toggle("items", row, field)}
              />
            ) : null}
            {tab === "categories" ? (
              <CatalogTable
                rows={catalog.categories}
                columns={["code", "name", "parentId", "sortOrder", "enabled", "formVisible"]}
                labels={{ code: "稳定 code", name: "名称", parentId: "父分类", sortOrder: "排序", enabled: "状态", formVisible: "表单展示" }}
                onEdit={(row) => openEdit("categories", row)}
                onToggle={(row, field) => void toggle("categories", row, field)}
              />
            ) : null}
            {tab === "skins" ? (
              <CatalogTable
                rows={catalog.skins}
                columns={["code", "name", "categoryId", "rarityCode", "sortOrder", "enabled", "formVisible"]}
                labels={{ code: "稳定 code", name: "名称", categoryId: "分类", rarityCode: "稀有度", sortOrder: "排序", enabled: "状态", formVisible: "表单展示" }}
                onEdit={(row) => openEdit("skins", row)}
                onToggle={(row, field) => void toggle("skins", row, field)}
              />
            ) : null}
            {tab === "rarities" ? (
              <CatalogTable
                rows={catalog.rarities}
                columns={["code", "name", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("rarities", row)}
                onToggle={(row, field) => void toggle("rarities", row, field)}
              />
            ) : null}
            {tab === "entitlements" ? (
              <CatalogTable
                rows={catalog.entitlements}
                columns={["code", "name", "valueKind", "expiryKind", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", valueKind: "值类型", expiryKind: "有效类型", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("entitlements", row)}
                onToggle={(row, field) => void toggle("entitlements", row, field)}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const EDITOR_COLLECTION: Record<CatalogKind, string> = {
  items: "items",
  categories: "categories",
  skins: "skins",
  rarities: "rarities",
  entitlements: "entitlements",
};

function CatalogTable({
  rows,
  columns,
  labels,
  onEdit,
  onToggle,
}: {
  rows: Array<Record<string, unknown> & { id: string; enabled?: boolean; formVisible?: boolean }>;
  columns: string[];
  labels: Record<string, string>;
  onEdit: (row: never) => void;
  onToggle: (row: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => void;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground py-6 text-center">暂无词条；未配置不代表有效，未知旧值不会被默认成有效词条。</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr>{columns.map((column) => <th key={column}>{labels[column] ?? column}</th>)}<th>操作</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td key={column}>
                  {column === "enabled" || column === "formVisible"
                    ? <button type="button" className={row[column] ? "text-emerald-400" : "text-muted-foreground"} onClick={() => onToggle(row, column)}>{row[column] ? "已启用 / 显示" : "已停用 / 隐藏"}</button>
                    : row[column] === null || row[column] === undefined || row[column] === ""
                      ? <span className="text-muted-foreground">未标注</span>
                      : <span className="font-mono text-[11px]">{String(row[column])}</span>}
                </td>
              ))}
              <td><Button type="button" size="sm" variant="secondary" onClick={() => onEdit(row as never)}>编辑</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
