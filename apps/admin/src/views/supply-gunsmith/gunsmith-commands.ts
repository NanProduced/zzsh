import type { Dispatch, SetStateAction } from "react";

import { adminRequest, AdminApiError, friendlyError, type AdminGunsmithResponse, type SessionSnapshot } from "../../api";
import { SupplyWriteLockError, withSupplyWriteLock } from "@/lib/supply-write-lock";
import { readOperationResult, requestFingerprint } from "../supply-media/write-intent";
import {
  CODE_MIN_LENGTH,
  ENTITY_LABEL,
  gunsmithRecoveryTarget,
  parsePendingGunsmith,
  pendingGunsmithKey,
  reviewTimeUtc,
  type GunsmithEntity,
  type PendingGunsmithWrite,
} from "./model";

export type Editor = { entity: GunsmithEntity; id?: string; firearmId?: string; values: Record<string, string>; revision?: string; baseline?: string };

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

export type GunsmithCommandDeps = {
  writeBusy: { current: boolean };
  writeSeq: { current: number };
  recoverySeq: { current: number };
  scopeRef: { current: string };
  actorRef: { current: string };
  scope: string;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  gameId: string;
  editor: Editor | null;
  unknownWrite: PendingGunsmithWrite | null;
  storageBlocked: boolean;
  recovering: boolean;
  busy: boolean;
  loadData: (targetGameId: string) => Promise<AdminGunsmithResponse | null>;
  reloadCatalog: () => Promise<void>;
  setUnknownWrite: Dispatch<SetStateAction<PendingGunsmithWrite | null>>;
  setStorageBlocked: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setFieldError: Dispatch<SetStateAction<{ key: string; message: string } | null>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setEditor: Dispatch<SetStateAction<Editor | null>>;
  setMediaPicking: Dispatch<SetStateAction<boolean>>;
  setFirearmId: Dispatch<SetStateAction<string>>;
  setRecovering: Dispatch<SetStateAction<boolean>>;
};

export function createGunsmithCommands(deps: GunsmithCommandDeps) {
  const {
    writeBusy, writeSeq, recoverySeq, scopeRef, actorRef, scope, snapshot, gameId, editor, unknownWrite,
    storageBlocked, recovering, busy, loadData, reloadCatalog, setUnknownWrite, setStorageBlocked, setError,
    setSaving, setFieldError, setSuccess, setEditor, setMediaPicking, setFirearmId, setRecovering,
  } = deps;

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

  return { runWrite, saveEditor, recoverOriginalResult };
}
