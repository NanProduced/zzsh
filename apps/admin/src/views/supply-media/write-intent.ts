/**
 * 素材页写意图：稳定幂等键 + 指纹 + 阶段机 + localStorage 恢复。
 * 机制对齐 im-support/审批线既有协议，但记录结构只绑定本页字段。
 * 不持久化 uploadToken、图片字节、私有图片 URL 或凭证内容（token/字节只在内存 ref）。
 * 本地记录不是授权依据：恢复读取与重放都由服务端最终校验。
 */

import { ALLOWED_IMAGE_MIMES, MAX_MEDIA_BYTES, UPLOAD_PURPOSES } from "./model.ts";

// 与 api.ts 的 API_ROOT 同值；此处不值导入 api，保持本模块可在 Node 下独立测试。
const API_ROOT = "/api/bff/admin";

/** AdminApiError 形状（鸭子判定，避免值导入 api.ts）。 */
type ApiErrorLike = { name?: string; status: number; code: string };
function asApiError(failure: unknown): ApiErrorLike | null {
  if (typeof failure !== "object" || failure === null) return null;
  const candidate = failure as { name?: unknown; status?: unknown; code?: unknown };
  return typeof candidate.status === "number" && typeof candidate.code === "string" ? (candidate as ApiErrorLike) : null;
}

export class WriteNetworkError extends Error {
  readonly status = 0;
  readonly code = "NETWORK_ERROR";
  constructor() {
    super("NETWORK_ERROR");
    this.name = "WriteNetworkError";
  }
}

export type WritePhase = "sending" | "unknown" | "accepted_readback";

export type SimpleWriteKind = "review" | "visibility" | "cover";

export type SimpleWriteRecord = {
  v: 1;
  kind: SimpleWriteKind;
  adminId: string;
  sessionId: string;
  operation: string;
  targetId: string;
  targetLabel: string;
  gameId: string;
  body: Record<string, unknown>;
  key: string;
  fingerprint: string;
  phase: WritePhase;
  /** 该操作是否存在 /operation-result 原结果读取（服务端白名单＋归属门）。 */
  recoverable: boolean;
  /** 不可恢复时的原因（用户素材/封面绑定）。 */
  recoverNote?: string;
  createdAt: string;
};

export type UploadStageState = "idle" | "sending" | "accepted" | "unknown";

export type UploadWriteRecord = {
  v: 1;
  kind: "upload";
  adminId: string;
  sessionId: string;
  targetLabel: string;
  gameId: string;
  purpose: string;
  file: { name: string; size: number; mime: string };
  intent: { key: string; fingerprint: string | null; status: UploadStageState; intentId: string | null };
  bytes: { key: string; fingerprint: string | null; status: UploadStageState };
  /** 字节回执确认的素材ID；只有它与回执匹配时才算上传完成。 */
  resultAssetId?: string | null;
  /** 整体阶段：accepted_readback 表示字节已受理但队列回读失败。 */
  phase: WritePhase | "idle";
  recoverable: true;
  createdAt: string;
};

export type WriteRecord = SimpleWriteRecord | UploadWriteRecord;

export type StoredShape =
  | { ok: true; record: WriteRecord }
  | { ok: false; reason: "missing" | "corrupt" | "foreign"; raw?: unknown };

const STORAGE_PREFIX = "zzsh.supply-media.write.";
const MAX_BODY_BYTES = 4096;

export function storageKey(adminId: string): string {
  return `${STORAGE_PREFIX}${adminId}`;
}

export function newIdempotencyKey(): string {
  return `idem_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll("-", "")}`;
}

/* ---------- 校验：读取时验证结构；损坏/他人的记录不直接删除后重提 ---------- */

const SIMPLE_KINDS = new Set(["review", "visibility", "cover"]);
const OPERATION_BY_KIND: Record<SimpleWriteKind, string> = {
  review: "supply.media.review",
  visibility: "supply.media.visibility",
  cover: "supply.game.cover",
};
const PHASES = new Set(["sending", "unknown", "accepted_readback"]);
const STAGE_STATES = new Set(["idle", "sending", "accepted", "unknown"]);
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_RE = /^idem_[A-Za-z0-9_-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validBody(body: unknown): body is Record<string, unknown> {
  if (!isPlainObject(body)) return false;
  try {
    return JSON.stringify(body).length <= MAX_BODY_BYTES;
  } catch {
    return false;
  }
}

function validFingerprint(value: unknown): boolean {
  return value === null || (typeof value === "string" && HEX64.test(value));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function hasFingerprint(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function validUploadStages(record: UploadWriteRecord): boolean {
  if (record.intent.status !== "idle" && !hasFingerprint(record.intent.fingerprint)) return false;
  if (record.intent.status === "accepted" && !validId(record.intent.intentId)) return false;
  if (record.bytes.status !== "idle" && (record.intent.status !== "accepted" || !hasFingerprint(record.bytes.fingerprint))) return false;
  if (record.bytes.status === "accepted") return validId(record.resultAssetId) && record.phase === "accepted_readback";
  return record.phase !== "accepted_readback" && (record.phase !== "idle" || record.bytes.status === "idle");
}

export function validateStored(raw: unknown, adminId: string): StoredShape {
  try {
    if (raw === null || raw === undefined) return { ok: false, reason: "missing" };
    if (!isPlainObject(raw) || raw.v !== 1) return { ok: false, reason: "corrupt", raw };
    if (
      !validId(raw.adminId) || !validId(raw.sessionId) || !validId(raw.gameId) ||
      typeof raw.targetLabel !== "string" || !raw.targetLabel.trim() ||
      typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
      typeof raw.recoverable !== "boolean" ||
      (raw.recoverNote !== undefined && typeof raw.recoverNote !== "string")
    ) return { ok: false, reason: "corrupt", raw };
    if (raw.kind === "upload") {
      const r = raw as unknown as UploadWriteRecord;
      const ok =
        r.recoverable === true &&
        (UPLOAD_PURPOSES as readonly string[]).includes(r.purpose) &&
        isPlainObject(r.file) &&
        typeof r.file.name === "string" && Boolean(r.file.name.trim()) &&
        Number.isSafeInteger(r.file.size) && r.file.size > 0 && r.file.size <= MAX_MEDIA_BYTES &&
        (ALLOWED_IMAGE_MIMES as readonly string[]).includes(r.file.mime) &&
        isPlainObject(r.intent) &&
        typeof r.intent.key === "string" && KEY_RE.test(r.intent.key) &&
        validFingerprint(r.intent.fingerprint) &&
        STAGE_STATES.has(r.intent.status) &&
        (r.intent.intentId === null || validId(r.intent.intentId)) &&
        isPlainObject(r.bytes) &&
        typeof r.bytes.key === "string" && KEY_RE.test(r.bytes.key) &&
        validFingerprint(r.bytes.fingerprint) &&
        STAGE_STATES.has(r.bytes.status) &&
        (r.resultAssetId === undefined || r.resultAssetId === null || validId(r.resultAssetId)) &&
        (r.phase === "idle" || PHASES.has(r.phase)) &&
        validUploadStages(r);
      if (!ok) return { ok: false, reason: "corrupt", raw };
    } else if (typeof raw.kind === "string" && SIMPLE_KINDS.has(raw.kind)) {
      const r = raw as unknown as SimpleWriteRecord;
      const ok =
        r.operation === OPERATION_BY_KIND[r.kind] && validId(r.targetId) &&
        (r.kind !== "cover" || r.targetId === r.gameId) &&
        validBody(r.body) &&
        typeof r.key === "string" && KEY_RE.test(r.key) &&
        hasFingerprint(r.fingerprint) && PHASES.has(r.phase);
      if (!ok) return { ok: false, reason: "corrupt", raw };
    } else {
      return { ok: false, reason: "corrupt", raw };
    }
    if (raw.adminId !== adminId) return { ok: false, reason: "foreign", raw };
    return { ok: true, record: raw as WriteRecord };
  } catch {
    return { ok: false, reason: "corrupt", raw };
  }
}

/* ---------- 持久化：新命令发出前先保存；保存失败阻止提交 ---------- */

export class PersistBlockedError extends Error {
  constructor() {
    super("本地无法保存操作意图");
    this.name = "PersistBlockedError";
  }
}

export function saveRecord(record: WriteRecord): void {
  try {
    const json = JSON.stringify(record);
    if (json.length > 64 * 1024) throw new Error("record too large");
    window.localStorage.setItem(storageKey(record.adminId), json);
  } catch {
    throw new PersistBlockedError();
  }
}

export function loadRecord(adminId: string): StoredShape {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(adminId));
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (raw === null) return { ok: false, reason: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt", raw };
  }
  return validateStored(parsed, adminId);
}

export function clearRecord(adminId: string): void {
  try {
    window.localStorage.removeItem(storageKey(adminId));
  } catch {
    /* 清除失败不阻塞已解决状态；下次保存会覆盖 */
  }
}

/** 同一原命令绑定；phase、时间与展示文案不决定命令身份。未固化的摘要/意图ID不作通配符。 */
export function sameRecord(a: WriteRecord, b: WriteRecord): boolean {
  try {
    if (!validateStored(a, a.adminId).ok || !validateStored(b, b.adminId).ok) return false;
    if (a.kind !== b.kind || a.adminId !== b.adminId || a.sessionId !== b.sessionId || a.gameId !== b.gameId) return false;
    if (isUploadRecord(a) && isUploadRecord(b)) {
      return a.purpose === b.purpose &&
        a.file.name === b.file.name && a.file.size === b.file.size && a.file.mime === b.file.mime &&
        a.intent.key === b.intent.key && a.bytes.key === b.bytes.key &&
        a.intent.fingerprint === b.intent.fingerprint && a.bytes.fingerprint === b.bytes.fingerprint &&
        a.intent.intentId === b.intent.intentId &&
        (!a.resultAssetId || !b.resultAssetId || a.resultAssetId === b.resultAssetId);
    }
    return !isUploadRecord(a) && !isUploadRecord(b) && a.operation === b.operation &&
      a.targetId === b.targetId && a.key === b.key && a.fingerprint === b.fingerprint &&
      JSON.stringify(a.body) === JSON.stringify(b.body);
  } catch {
    return false;
  }
}

/**
 * 调用方持共同写锁，重读并核原身份/操作/目标/摘要，匹配才同步删除。
 * 旧实例迟到回调、另一窗口的新请求都不会被误删。
 */
export function clearRecordIfMatch(adminId: string, expected: WriteRecord): boolean {
  try {
    const current = loadRecord(adminId);
    if (expected.adminId !== adminId || !current.ok || !sameRecord(current.record, expected)) return false;
    window.localStorage.removeItem(storageKey(adminId));
    return true;
  } catch {
    return false;
  }
}

/**
 * 原体摘要校验：恢复/重放前重算指纹并与记录比对，body 被篡改即 fail closed。
 * 字节指纹含 token 派生物、刷新后不可重算，只核格式（提交时已固化）。
 */
export async function verifyRecordIntegrity(record: WriteRecord): Promise<"ok" | "tampered"> {
  try {
    if (!validateStored(record, record.adminId).ok) return "tampered";
    if (isUploadRecord(record)) {
      const intentFingerprint = record.intent.fingerprint
        ? await uploadIntentFingerprint({ gameId: record.gameId, purpose: record.purpose, mime: record.file.mime, size: record.file.size })
        : null;
      if (record.intent.fingerprint && intentFingerprint !== record.intent.fingerprint) return "tampered";
      return "ok";
    }
    const recomputed = await requestFingerprint(record.operation, record.targetId, record.body);
    return recomputed === record.fingerprint ? "ok" : "tampered";
  } catch {
    return "tampered";
  }
}

/* ---------- 指纹：与 apps/api/src/supply/supply-util.ts fingerprintRequest 同构 ---------- */

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256Hex(JSON.stringify([operation, resourceId ?? null, body ?? null])) */
export async function requestFingerprint(operation: string, resourceId: string | undefined, body: unknown): Promise<string> {
  return sha256Hex(JSON.stringify([operation, resourceId ?? null, body ?? null]));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 字节上传指纹：服务端 runMediaUpload 用
 * { intentId, token, contentHash: requestFingerprint("bytes", intentId, base64) }
 * 再取 requestFingerprint("supply.media.upload", intentId, 该对象)。
 * 仅在 token 与字节仍在内存时可算；算完只存 fingerprint，不存 token/字节。
 */
export async function uploadBytesFingerprint(intentId: string, token: string, bytes: Uint8Array): Promise<string> {
  const contentHash = await requestFingerprint("bytes", intentId, toBase64(bytes));
  return requestFingerprint("supply.media.upload", intentId, { intentId, token, contentHash });
}

export function uploadIntentFingerprint(input: { gameId: string; purpose: string; mime: string; size: number }): Promise<string> {
  return requestFingerprint("supply.media.upload_intent.create", undefined, input);
}

/* ---------- 错误分类：错误≠未执行；只有结果不明才进 UNKNOWN ---------- */

export function classifyWriteError(failure: unknown, hadAcceptedHint: boolean): "unknown" | "rejected" {
  const api = asApiError(failure);
  if (!api) return "unknown";
  if (api.status === 0) return "unknown";
  if (api.status >= 500) return "unknown";
  if (hadAcceptedHint && [401, 403, 404, 423].includes(api.status)) return "unknown";
  return "rejected";
}

/* ---------- /operation-result 原结果读取（GET＋idempotency-key 头） ---------- */

export type RecoveryRead =
  | { receipt: "UNRESOLVED" }
  | { receipt: "RECORDED"; responseStatus: number; result: Record<string, unknown>; echoOperation: string | null; echoResourceId: string | null }
  | { receipt: "UNSUPPORTED"; note: string };

export type RecoveryTarget = { operation: string; resourceId?: string; fingerprint: string; key: string };

/** 白名单现有：upload_intent.create / upload / review / visibility（平台与用户供给）/ game.cover。 */
export function recoveryQuery(record: SimpleWriteRecord): RecoveryTarget | null {
  if (!record.recoverable) return null;
  return record.operation === "supply.media.upload_intent.create"
    ? { operation: record.operation, fingerprint: record.fingerprint, key: record.key }
    : { operation: record.operation, resourceId: record.targetId, fingerprint: record.fingerprint, key: record.key };
}

export async function readOperationResult(query: RecoveryTarget): Promise<RecoveryRead> {
  const params = new URLSearchParams({ operation: query.operation, fingerprint: query.fingerprint });
  if (query.resourceId) params.set("resourceId", query.resourceId);
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/supply/operation-result?${params.toString()}`, {
      method: "GET",
      credentials: "include",
      headers: { "idempotency-key": query.key },
    });
  } catch {
    throw new WriteNetworkError();
  }
  const payload = (await response.json().catch(() => null)) as { receipt?: string; responseStatus?: number; result?: Record<string, unknown>; operation?: string; resourceId?: string | null; error?: { code?: string } } | null;
  if (!response.ok) {
    // 404：白名单不覆盖或目标归属不是 PLATFORM_CATALOG——不是"未执行"的证明。
    if (response.status === 404) return { receipt: "UNSUPPORTED", note: "恢复接口不覆盖该操作或对象归属；原结果仍待核，不能视为未执行。" };
    throw new WriteNetworkError();
  }
  if (payload?.receipt === "RECORDED" && typeof payload.responseStatus === "number") {
    return {
      receipt: "RECORDED",
      responseStatus: payload.responseStatus,
      result: payload.result ?? {},
      echoOperation: typeof payload.operation === "string" ? payload.operation : null,
      echoResourceId: typeof payload.resourceId === "string" ? payload.resourceId : null,
    };
  }
  return { receipt: "UNRESOLVED" };
}

export function isUploadRecord(record: WriteRecord): record is UploadWriteRecord {
  return record.kind === "upload";
}

export function recordPhaseText(record: WriteRecord): string {
  if (isUploadRecord(record)) {
    if (record.phase === "accepted_readback") return record.resultAssetId ? "上传已受理，队列回读未确认" : "写入已受理，最新状态未确认";
    if (record.bytes.status === "unknown") return record.bytes.fingerprint ? "字节上传结果未知" : "上传未完成（字节未发送）";
    if (record.intent.status === "unknown") return "上传意图结果未知";
    if (record.intent.status === "accepted" && record.bytes.status !== "accepted") return "上传未完成：意图已建立，字节尚未上传";
    return "上传进行中";
  }
  if (record.phase === "accepted_readback") return "写入已受理，最新状态未确认";
  if (record.phase === "unknown") return "写入结果未知";
  return "写入发送中";
}
