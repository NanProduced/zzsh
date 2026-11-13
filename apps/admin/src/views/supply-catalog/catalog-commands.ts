import type { Dispatch, FormEvent, SetStateAction } from "react";

import { adminRequest, AdminApiError, friendlyError, type AdminCatalogResponse, type CatalogMediaOption, type CatalogSkin, type CatalogSkinOwner, type MediaOptionsResponse, type SessionSnapshot, type SupplyGame } from "../../api";
import { SupplyWriteLockError, withSupplyWriteLock } from "@/lib/supply-write-lock";
import { catalogReceipt, ownerPayload, skinPayload, skinValues } from "../catalog-skin-fields";
import { CODE_PATTERN, editorValuesFor, recordValues, toPayload, validateEditor, type EditorState, type WriteIntent, type WritePhase } from "./editor-fields";
import {
  catalogFingerprint,
  catalogOperation,
  catalogResource,
  OBJECT_LABEL,
  objectRows,
  parsePendingCatalog,
  pendingCatalogKey,
  type CatalogFirearmOwner,
  type CatalogKind,
  type CatalogRow,
  type CatalogWriteKind,
} from "./model";

export type CatalogCommandDeps = {
  writeIntent: { current: WriteIntent | null };
  writeBusy: { current: boolean };
  writeSeq: { current: number };
  scopeRef: { current: string };
  scope: string;
  mediaPickSeq: { current: number };
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  gameId: string;
  writePhase: WritePhase;
  canManage: boolean;
  storageBlocked: boolean;
  editor: EditorState | null;
  catalog: AdminCatalogResponse | null;
  contractReady: boolean;
  firearms: CatalogFirearmOwner[] | null;
  isBoss: boolean;
  gameDraft: { code: string; name: string; description: string };
  mediaPickerPurpose: "SKIN_MEDIA" | "ITEM_MEDIA" | null;
  toggleDraft: { kind: CatalogKind; row: CatalogRow; field: "enabled" | "formVisible"; revision: string } | null;
  conflictLoaded: boolean;
  loadGames: () => Promise<SupplyGame[] | undefined>;
  loadCatalog: (targetGameId: string) => Promise<AdminCatalogResponse | null>;
  setWritePhase: Dispatch<SetStateAction<WritePhase>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  setCloseAsked: Dispatch<SetStateAction<boolean>>;
  setConflictLoaded: Dispatch<SetStateAction<boolean>>;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
  setStorageBlocked: Dispatch<SetStateAction<boolean>>;
  setGameDraft: Dispatch<SetStateAction<{ code: string; name: string; description: string }>>;
  setGameAdminOpen: Dispatch<SetStateAction<boolean>>;
  setToggleDraft: Dispatch<SetStateAction<{ kind: CatalogKind; row: CatalogRow; field: "enabled" | "formVisible"; revision: string } | null>>;
  setMediaPickerOpen: Dispatch<SetStateAction<boolean>>;
  setMediaOptions: Dispatch<SetStateAction<CatalogMediaOption[]>>;
  setMediaNextCursor: Dispatch<SetStateAction<string | null>>;
  setMediaOptionsLoading: Dispatch<SetStateAction<boolean>>;
  setMediaOptionsError: Dispatch<SetStateAction<string | undefined>>;
  setMediaRetryCursor: Dispatch<SetStateAction<string | null>>;
};

export function createCatalogCommands(deps: CatalogCommandDeps) {
  const {
    writeIntent, writeBusy, writeSeq, scopeRef, scope, mediaPickSeq,
    snapshot, gameId, writePhase, canManage, storageBlocked, editor, catalog,
    contractReady, firearms, isBoss, gameDraft, mediaPickerPurpose, toggleDraft, conflictLoaded,
    loadGames, loadCatalog,
    setWritePhase, setError, setSuccess, setEditor, setCloseAsked, setConflictLoaded, setDetailOpen,
    setStorageBlocked, setGameDraft, setGameAdminOpen, setToggleDraft, setMediaPickerOpen, setMediaOptions,
    setMediaNextCursor, setMediaOptionsLoading, setMediaOptionsError, setMediaRetryCursor,
  } = deps;

  const storeIntent = (intent: WriteIntent) => {
    const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
    if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) throw new Error("另一窗口已保存其它原提交，本次操作不会覆盖它；请刷新后核对。");
    const { schema, adminId, gameId, kind, id, path, method, body, key, fingerprint, expectedCode, accepted, createdGameId } = intent;
    window.localStorage.setItem(pendingCatalogKey(adminId), JSON.stringify({ schema, adminId, gameId, kind, id, path, method, body, key, fingerprint, expectedCode, accepted, createdGameId }));
  };

  const clearIntent = (intent: WriteIntent) => {
    const storageKey = pendingCatalogKey(intent.adminId), stored = parsePendingCatalog(window.localStorage.getItem(storageKey), intent.adminId);
    if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) throw new Error("原提交记录已变化，不会清除另一窗口的请求；请刷新后核对。");
    window.localStorage.removeItem(storageKey);
  };

  const changeEditor = (next: EditorState | null) => {
    if (next !== null && writePhase !== "idle") return;
    const preservingPending = next === null && ["saving", "unknown", "readback"].includes(writePhase);
    if (!preservingPending) {
      writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false;
      setWritePhase("idle"); setSuccess(undefined); setError(undefined);
    }
    setCloseAsked(false);
    setConflictLoaded(false); if (next === null) setDetailOpen(false); setEditor(next);
  };

  const readback = async (context: string, sequence: number) => {
    const original = writeIntent.current;
    try {
      if (writeIntent.current?.kind === "games") {
        const intent = writeIntent.current, games = await loadGames();
        if (!intent.createdGameId || !games?.some(game => game.id === intent.createdGameId && game.code === intent.body.code)) throw new Error("新游戏身份尚未完成回读核实");
      }
      else if (!await loadCatalog(gameId)) throw new Error("目录回读未完成");
      if (scopeRef.current !== context || sequence !== writeSeq.current) return;
      if (!original) throw new Error("原提交未提供");
      clearIntent(original);
      writeIntent.current = null;
      setWritePhase("idle"); setError(undefined);
    } catch {
      if (scopeRef.current !== context || sequence !== writeSeq.current) return;
      setWritePhase("readback"); setError("提交已成功，但最新目录读取失败；请重新读取，不要重复提交。");
    }
  };

  const runWrite = async (intent: WriteIntent) => {
    if (writeBusy.current || scopeRef.current !== intent.scope || intent.sequence !== writeSeq.current) return;
    writeBusy.current = true; setWritePhase("saving"); setError(undefined); setSuccess(undefined);
    const current = () => scopeRef.current === intent.scope && writeSeq.current === intent.sequence;
    try {
      const result = await adminRequest<unknown>(intent.path, intent.body, intent.method, { "idempotency-key": intent.key });
      if (!current()) return;
      if (intent.kind === "games") {
        intent.accepted = true;
        const game = result && typeof result === "object" ? (result as { game?: { id?: unknown; code?: unknown } }).game : undefined;
        if (!game || typeof game.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(game.id) || game.code !== intent.body.code) { storeIntent(intent); setGameAdminOpen(false); setWritePhase("readback"); setError("游戏创建已收到受理响应，但目标身份尚未核实；请核对原回执，不能再次创建。"); return; }
        intent.createdGameId = game.id;
      }
      if ((intent.kind === "skins" || intent.kind === "skin-owners") && !catalogReceipt(result, intent.kind, intent.body, intent.id, intent.expectedCode)) {
        intent.uncertain = true; setWritePhase("unknown"); setError("尚不能确认提交结果。请核对原提交，不要重新创建或更改提交内容。"); return;
      }
      intent.accepted = true; storeIntent(intent);
      setSuccess(intent.kind === "games" ? "游戏已创建；创建游戏不等于开放供给业务，请继续配置目录、规则与素材。" : `${OBJECT_LABEL[intent.kind]}已保存${intent.kind === "skins" && !intent.id ? "为停用待核草稿；身份确认与启用是独立动作。" : "；稳定身份保持不变。"}`);
      if (intent.kind === "games") { setGameDraft({ code: "", name: "", description: "" }); setGameAdminOpen(false); }
      if (intent.continueWith && intent.kind !== "games") {
        setEditor({ kind: intent.kind, values: { ...editorValuesFor(intent.kind), ...intent.continueWith }, revision: catalog?.game.catalogRevision });
      } else {
        setEditor(null);
      }
      setDetailOpen(false);
      setCloseAsked(false);
      await readback(intent.scope, intent.sequence);
    } catch (failure) {
      if (!current()) return;
      const unknown = intent.accepted || !(failure instanceof AdminApiError) || failure.status === 0 || failure.status >= 500 || (intent.uncertain && [401,403,404,423].includes(failure.status));
      if (unknown) { intent.uncertain = !intent.accepted; setWritePhase(intent.accepted ? "readback" : "unknown"); setError(intent.accepted ? "提交已成功，但回读或恢复状态保存失败；不会重复提交。" : "未能确认提交结果。请恢复当前身份与权限后核对原提交，不要重复新建。"); }
      else {
        try { clearIntent(intent); } catch { setStorageBlocked(true); }
        writeIntent.current = null;
        setWritePhase(failure.status === 409 ? "conflict" : "idle"); setConflictLoaded(false);
        setError(failure.status === 409 ? "目录版本已变化或来源存在冲突，输入已保留。请读取最新目录并核对后重新提交。" : friendlyError(failure));
      }
    } finally { if (current()) writeBusy.current = false; }
  };

  const carryValuesFor = (kind: CatalogKind, values: Record<string, string>): Record<string, string> | undefined => {
    if (kind === "skins") return { categoryId: values.categoryId ?? "", ownerKind: values.ownerKind ?? "AGENT", ownerId: values.ownerKind === "FIREARM" ? "" : values.ownerId ?? "" };
    if (kind === "categories") return { parentId: values.parentId ?? "" };
    return undefined;
  };

  const beginWrite = async (kind: CatalogWriteKind, body: Record<string, unknown>, id?: string, continueWith?: Record<string, string>) => {
    if (writeBusy.current || writePhase !== "idle" || !canManage || storageBlocked) return;
    writeBusy.current = true; setWritePhase("saving");
    const intent: WriteIntent = { schema: 1, adminId: snapshot.adminUserId, gameId, scope, sequence: writeSeq.current, kind, id,
      path: kind === "games" ? "/supply/games" : id ? `/supply/${kind}/${id}` : `/supply/games/${gameId}/${kind}`,
      expectedCode: id && (kind === "skins" || kind === "skin-owners") ? (kind === "skins" ? catalog?.skins : catalog?.owners)?.find(r => r.id === id)?.code : undefined,
      method: id ? "PUT" : "POST", body: JSON.parse(JSON.stringify(body)), key: `idem_${crypto.randomUUID().replaceAll("-", "")}`, fingerprint: "", accepted: false, continueWith };
    try {
      await withSupplyWriteLock(pendingCatalogKey(intent.adminId), async () => {
        if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
        const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
        if (stored) {
          writeIntent.current = { ...stored, scope: intent.scope, sequence: intent.sequence, restored: true, uncertain: !stored.accepted };
          setWritePhase(stored.accepted ? "readback" : "unknown"); setError("另一窗口已有待核提交，本次请求尚未发送；请先核对原结果。"); return;
        }
        intent.fingerprint = await catalogFingerprint(intent);
        if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
        storeIntent(intent);
        writeIntent.current = intent; writeBusy.current = false;
        await runWrite(intent);
      });
    } catch (failure) {
      if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
      if (!(failure instanceof SupplyWriteLockError) || failure.code === "LOCK_UNAVAILABLE") setStorageBlocked(true);
      setWritePhase("idle"); setError(failure instanceof Error ? `${failure.message} 本次请求尚未发送。` : "无法保存原请求，新提交已停用，本次请求尚未发送。");
    } finally { if (scopeRef.current === intent.scope && writeSeq.current === intent.sequence) writeBusy.current = false; }
  };

  const recoverOriginal = async () => {
    const intent = writeIntent.current;
    if (!intent || !canManage || storageBlocked || writeBusy.current || (intent.kind !== "games" && intent.gameId !== gameId)) return;
    writeBusy.current = true; setWritePhase("saving");
    const current = () => scopeRef.current === intent.scope && writeSeq.current === intent.sequence;
    try {
      await withSupplyWriteLock(pendingCatalogKey(intent.adminId), async () => {
        if (!current()) return;
        const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
        if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) {
          writeIntent.current = { ...stored, scope: intent.scope, sequence: intent.sequence, restored: true, uncertain: !stored.accepted };
          setWritePhase(stored.accepted ? "readback" : "unknown"); setError("另一窗口已保存其它原提交，本次核对请求尚未发送；请先核对新的原记录。"); return;
        }
        if (!stored) intent.restored = true;
        if (intent.accepted && !intent.restored && (intent.kind !== "games" || intent.createdGameId)) { await readback(scope, writeSeq.current); return; }
        if (!intent.restored && !intent.accepted) { writeBusy.current = false; await runWrite(intent); return; }
        if (await catalogFingerprint(intent) !== intent.fingerprint) throw new Error("原命令指纹不匹配，请联系维护者核对，不能重新提交。");
        const resourceId = catalogResource(intent);
        const params = new URLSearchParams({ operation: catalogOperation(intent), ...(resourceId ? { resourceId } : {}), fingerprint: intent.fingerprint });
        const receipt = await adminRequest<{ receipt: string; operation?: string; resourceId?: string | null; responseStatus?: number; result?: { id?: string } }>(`/supply/operation-result?${params}`, undefined, "GET", { "idempotency-key": intent.key });
        if (!current()) return;
        if (receipt.receipt !== "RECORDED") { setWritePhase(intent.accepted ? "readback" : "unknown"); setError("原回执尚未找到，不能据此判定未执行。保留原请求，不会静默重新提交。"); return; }
        if (receipt.operation !== catalogOperation(intent) || receipt.resourceId !== (resourceId ?? null) || typeof receipt.responseStatus !== "number" || receipt.responseStatus < 200 || receipt.responseStatus >= 300 || typeof receipt.result?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.result.id) || (intent.id && receipt.result.id !== intent.id)) throw new Error("原回执无法确认，请联系维护者核对。");
        intent.accepted = true; if (intent.kind === "games") intent.createdGameId = receipt.result.id; storeIntent(intent); setSuccess("原提交已由受权回执确认，正在读取目录。");
        await readback(intent.scope, intent.sequence);
      });
    } catch (failure) { if (current()) { if (failure instanceof SupplyWriteLockError && failure.code === "LOCK_UNAVAILABLE") setStorageBlocked(true); setWritePhase(intent.accepted ? "readback" : "unknown"); setError(failure instanceof SupplyWriteLockError ? `${failure.message} 本次核对请求尚未发送，原状态保留。` : failure instanceof AdminApiError ? `${friendlyError(failure)} 原请求仍保留，不会重复提交。` : failure instanceof Error ? failure.message : "原请求仍待核对。"); } }
    finally { if (current()) writeBusy.current = false; }
  };

  const reloadConflict = async () => {
    const context = scope, sequence = writeSeq.current;
    try { const data = await loadCatalog(gameId); if (data && context === scopeRef.current && sequence === writeSeq.current) { setConflictLoaded(true); setSuccess("已读取最新目录。请对照表格核对保留的输入，再采用当前版本。"); } }
    catch (f) { if (context === scopeRef.current && sequence === writeSeq.current) setError(friendlyError(f)); }
  };

  const adoptRevision = () => {
    if (!conflictLoaded || !catalog) return;
    if (editor && (editor.kind === "skins" || editor.kind === "skin-owners")) {
      if (!contractReady) { setError("皮肤目录资料暂时无法确认，请稍后重试。"); return; }
      const latest = editor.id ? (editor.kind === "skins" ? catalog.skins : catalog.owners).find(r => r.id === editor.id) : undefined;
      if (editor.id && !latest) { setError("当前对象已不在可维护目录中，输入保留，请核对范围。"); return; }
      if (editor.kind === "skins" && latest && (latest as CatalogSkin).namingState !== (editor.original as CatalogSkin).namingState) { setError("词条身份状态已变化，请保留输入并重新打开核对。"); return; }
      let values = editor.values;
      if (latest && editor.original) {
        const previous = { ...recordValues(editor.kind, editor.original as unknown as Record<string, unknown>), ...(editor.kind === "skins" ? skinValues(editor.original as CatalogSkin) : {}) };
        const fresh = { ...recordValues(editor.kind, latest as unknown as Record<string, unknown>), ...(editor.kind === "skins" ? skinValues(latest as CatalogSkin) : {}) };
        values = { ...values };
        for (const key of ["name", "categoryId", "rarityCode", "sortOrder", "enabled", "formVisible", "aliases", "ownerKind", "ownerId", "baseName", "mediaId", "sourceNamespace", "sourceField", "sourceToken"]) if (values[key] === previous[key] && fresh[key] !== undefined) values[key] = fresh[key]!;
        for (const key of ["defaultState", "isCollectible", ...(values.changeRarityEvidence === "true" ? [] : ["rarityBasis", "raritySourceName", "rarityEvidenceUrls"]), ...(values.changeMediaSource === "true" ? [] : ["mediaSourceKind", "mediaSourceName", "mediaSourceUrl"])]) if (values[key] === previous[key] && fresh[key] !== undefined) values[key] = fresh[key]!;
      }
      setEditor({ ...editor, revision: catalog.game.catalogRevision, original: latest, values });
    }
    setWritePhase("idle"); setConflictLoaded(false); setError(undefined); setSuccess("已采用当前版本并保留修改过的输入，请核对后手动保存。");
  };

  const createGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isBoss || editor || writeBusy.current || writePhase !== "idle" || storageBlocked) return;
    setError(undefined);
    if (!CODE_PATTERN.test(gameDraft.code)) { setError("游戏 code 无效：需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。"); return; }
    if (!gameDraft.name.trim()) { setError("游戏名称不能为空。"); return; }
    await beginWrite("games", { code: gameDraft.code, name: gameDraft.name.trim(), ...(gameDraft.description.trim() ? { description: gameDraft.description.trim() } : {}) });
  };

  const openCreate = (kind: CatalogKind) => {
    if (storageBlocked || editor) return;
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("皮肤目录资料暂时无法确认，维护暂不可用。"); return; }
    if (kind === "skins" && catalog?.game.code !== "delta" && !catalog?.categories.length) { setError("请先维护至少一个皮肤分类，再创建皮肤。"); return; }
    if (kind === "skins" && catalog?.game.code === "delta" && !catalog.skinCategoryModel?.categorylessWriteReady) { setError("无分类词条创建尚未就绪，请先由维护者更新目录结构。"); return; }
    const created = editorValuesFor(kind);
    changeEditor({ kind, values: created, revision: catalog?.game.catalogRevision, baseline: JSON.stringify(created) });
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        const input = document.querySelector('[data-editing="new"] input') as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    }
  };

  const openEdit = (kind: CatalogKind, record: CatalogRow, confirm = false) => {
    if (storageBlocked) return;
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("皮肤目录资料暂时无法确认，维护暂不可用。"); return; }
    const values = { ...editorValuesFor(kind), ...recordValues(kind, record) };
    if (kind === "skins") Object.assign(values, skinValues(record as unknown as CatalogSkin));
    if (kind === "skin-owners") Object.assign(values, { ownerKind: (record as CatalogSkinOwner).kind, reason: "" });
    changeEditor({ kind, id: record.id, values, revision: catalog?.game.catalogRevision, baseline: JSON.stringify(values), confirm,
      ...(kind === "skins" || kind === "skin-owners" ? { original: record as unknown as CatalogSkin | CatalogSkinOwner } : {}) });
  };

  const saveEditor = (event?: FormEvent<HTMLFormElement>, continueAdd = false) => {
    event?.preventDefault();
    if (!editor || writeBusy.current || writePhase !== "idle" || storageBlocked) return;
    try {
      if (editor.kind === "skins" || editor.kind === "skin-owners") {
        if (!contractReady) throw new Error("皮肤目录资料暂时无法确认，请稍后重试。");
        if (!editor.id && !CODE_PATTERN.test(editor.values.code ?? "")) throw new Error("请填写有效的稳定code。");
        if (editor.kind === "skins" && editor.confirm) {
          const source = editor.values.ownerKind === "FIREARM" ? firearms : catalog!.owners.filter(o => o.kind === editor.values.ownerKind);
          if (!source) throw new Error("当前目录的枪械归属未接入，不能确认枪械所属关系。");
          const chosen = source.find(o => o.id === editor.values.ownerId);
          const old = (editor.original as CatalogSkin)?.ownerRef;
          const standaloneMelee = editor.values.ownerKind === "MELEE_TYPE" && (catalog!.game.code === "delta" || !editor.values.ownerId);
          if (!standaloneMelee && (!chosen || (!chosen.enabled && !(old?.id === chosen.id && old.kind === editor.values.ownerKind && (editor.original as CatalogSkin).namingState === "VERIFIED")))) throw new Error("请选择已读取且可挂接的所属对象。");
        }
        const body = editor.kind === "skins" ? skinPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkin | undefined, editor.confirm, catalog!.game.code) : ownerPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkinOwner | undefined, catalog!.game.code);
        beginWrite(editor.kind, body, editor.id, continueAdd ? carryValuesFor(editor.kind, editor.values) : undefined);
      } else {
        const validation = validateEditor(editor.kind, editor.values, Boolean(editor.id)); if (validation) throw new Error(validation);
        beginWrite(editor.kind, toPayload(editor.kind, editor.values, Boolean(editor.id)), editor.id, continueAdd ? carryValuesFor(editor.kind, editor.values) : undefined);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请检查填写内容。"); }
  };

  const toggleReason = (row: CatalogRow, field: "enabled" | "formVisible"): string | undefined => {
    if (row.namingState && row.namingState !== "VERIFIED" && !row[field]) return "需先核实身份";
    return undefined;
  };

  const toggle = (kind: CatalogKind, record: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => {
    if (writePhase !== "idle") return;
    if (kind === "skin-owners") {
      const owner = catalog?.owners.find(o => o.id === record.id); if (!owner) return;
      openEdit(kind, owner as unknown as CatalogRow); setEditor(current => current ? { ...current, values: { ...current.values, enabled: String(!owner.enabled) } } : current); return;
    }
    if (kind === "skins") {
      const skin = catalog?.skins.find(s => s.id === record.id);
      if (!contractReady || !skin) { setError("皮肤资料暂时无法确认，请稍后重试。"); return; }
      if (!record[field] && skin.namingState !== "VERIFIED") { setError("请先显式确认皮肤身份，再启用或展示。"); return; }
      beginWrite(kind, { [field]: !record[field], expectedCatalogRevision: catalog!.game.catalogRevision }, record.id); return;
    }
    beginWrite(kind, { [field]: !record[field] }, record.id);
  };

  const requestToggle = (kind: CatalogKind, row: CatalogRow, field: "enabled" | "formVisible") => {
    if (writePhase !== "idle" || storageBlocked || editor || !catalog) return;
    if (kind === "skin-owners") { toggle(kind, row, field); return; }
    setToggleDraft({ kind, row, field, revision: catalog.game.catalogRevision });
  };

  const confirmToggle = () => {
    if (!toggleDraft || !catalog) return;
    const current = objectRows(catalog, toggleDraft.kind).find(row => row.id === toggleDraft.row.id);
    if (!current || toggleDraft.revision !== catalog.game.catalogRevision || current[toggleDraft.field] !== toggleDraft.row[toggleDraft.field]) { setToggleDraft(null); setError("对象或目录版本已变化，请重新读取并核对后操作。"); return; }
    toggle(toggleDraft.kind, current, toggleDraft.field); setToggleDraft(null);
  };

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
    if (!editor || !editor.id || !gameId || !mediaPickerPurpose) return;
    if (!cursor) {
      setMediaOptions([]);
      setMediaNextCursor(null);
    }
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(true);
    setMediaRetryCursor(cursor);
    const seq = ++mediaPickSeq.current;
    const context = scopeRef.current;
    try {
      const params = new URLSearchParams({ purpose: mediaPickerPurpose, limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<MediaOptionsResponse>(`/supply/games/${gameId}/media-options?${params.toString()}`);
      if (seq !== mediaPickSeq.current || scopeRef.current !== context) return;
      setMediaOptions((current) => (cursor ? [...current, ...result.items] : result.items));
      setMediaNextCursor(result.nextCursor);
      setMediaRetryCursor(null);
    } catch (failure) {
      if (seq !== mediaPickSeq.current || scopeRef.current !== context) return;
      setMediaOptionsError(friendlyError(failure));
      if (!cursor) {
        setMediaOptions([]);
        setMediaNextCursor(null);
      }
    } finally {
      if (seq === mediaPickSeq.current && scopeRef.current === context) setMediaOptionsLoading(false);
    }
  };

  const openMediaPicker = () => {
    if (!editor || !editor.id || !mediaPickerPurpose) return;
    setMediaPickerOpen(true);
    void loadMediaOptionsPage(null);
  };

  const pickMedia = (mediaId: string) => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId } });
    dismissMediaPicker();
  };

  const unbindMedia = () => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId: "" } });
    dismissMediaPicker();
    setSuccess("已解除绑定；保存成功后目录将不再投影该图片。");
  };

  return {
    changeEditor, recoverOriginal, reloadConflict, adoptRevision, createGame, openCreate, openEdit, saveEditor,
    toggleReason, requestToggle, confirmToggle, dismissMediaPicker, loadMediaOptionsPage, openMediaPicker, pickMedia, unbindMedia,
  };
}
