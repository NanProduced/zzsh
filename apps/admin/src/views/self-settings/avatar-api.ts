export type AdminAvatarPreset = { presetId: string; version: number; url: string; width: number; height: number };
export type AdminAvatarUploadPolicy = { requiresReview: boolean; revision: string; available: boolean };
export type AdminAvatarUploadResult = { assetId: string | null; avatarSubmission: { disposition: 'PENDING_REVIEW' | 'APPLIED_BY_POLICY'; requiresReview: boolean; policyRevision: string; approvalSource: 'MANUAL_REVIEW_REQUIRED' | 'SYSTEM_POLICY' } | null };
export type AdminAvatarState = {
  revision: string;
  updatedAt: string | null;
  current: { kind: "DEFAULT" | "CUSTOM"; assetId: string | null; presetId: string | null; url: string; currentVersion: string };
  defaultPresetId: string;
  presets: AdminAvatarPreset[];
  pending: { assetId: string; submittedAt: string | null; reviewState: string; width: number; height: number; byteSize: string } | null;
  lastReview: { assetId: string; state: "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN"; reason: string | null; reviewedAt: string; applied: boolean; source?: 'HUMAN_REVIEW' | 'SYSTEM_POLICY'; policyRevision?: string | null } | null;
  policy?: AdminAvatarUploadPolicy;
  changed?: boolean;
};
export type AdminAvatarReviewItem = {
  assetId: string;
  realm: "user" | "admin";
  subjectId: string;
  subjectName: string | null;
  submittedAt: string;
  width: number;
  height: number;
  byteSize: string;
  mime: string;
  reviewState: string;
  accessClass: string;
  reviewReason: string | null;
  revision: string;
  approvalSource?: 'SYSTEM_POLICY' | 'HUMAN_REVIEW' | 'MANUAL_REVIEW_REQUIRED';
  policyRevision?: string | null;
};

export class AdminAvatarError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code?: string, requestId?: string) { super(message); this.status = status; this.code = code; this.requestId = requestId; }
}

const MANAGED_AVATAR_PATH = /^\/api\/v1\/profile\/avatars\/(?:(?:user|admin)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(?:0|[1-9]\d{0,18})|presets\/[a-z0-9][a-z0-9-]{1,31}\/[1-9]\d{0,8}\/content)$/;
function avatarUrl(value: unknown): string {
  try {
    if (typeof value === "string" && value.length <= 512 && value.startsWith("/api/v1/profile/avatars/") && MANAGED_AVATAR_PATH.test(decodeURIComponent(value))) return value;
  } catch { /* malformed encoded path */ }
  throw new AdminAvatarError("头像地址不是受管路径", 0, "CONTRACT");
}

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminAvatarError("头像状态返回格式不正确", 0, "CONTRACT");
  return value as Record<string, unknown>;
}
function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new AdminAvatarError(`头像状态缺少 ${label}`, 0, "CONTRACT");
  return value;
}
function rev(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(value)) throw new AdminAvatarError("头像版本不正确", 0, "CONTRACT");
  return value;
}
function uploadPolicy(value: unknown): AdminAvatarUploadPolicy {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (row.available !== true || typeof row.requiresReview !== 'boolean' || typeof row.revision !== 'string' || !/^[1-9]\d{0,18}$/.test(row.revision)) return { requiresReview: true, revision: '0', available: false };
  return { requiresReview: row.requiresReview, revision: row.revision, available: true };
}
export function parseAdminAvatarUploadResult(value: unknown): AdminAvatarUploadResult {
  const body = obj(value), assetId = typeof body.assetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.assetId) ? body.assetId : null;
  if (body.avatarSubmission === undefined) return { assetId, avatarSubmission: null };
  const row = obj(body.avatarSubmission), pending = row.disposition === 'PENDING_REVIEW' && row.requiresReview === true && row.approvalSource === 'MANUAL_REVIEW_REQUIRED';
  const applied = row.disposition === 'APPLIED_BY_POLICY' && row.requiresReview === false && row.approvalSource === 'SYSTEM_POLICY';
  if (!assetId || !pending && !applied || typeof row.policyRevision !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(row.policyRevision) || applied && row.policyRevision === '0') throw new AdminAvatarError('头像上传回执无法确认', 0, 'CONTRACT');
  return { assetId, avatarSubmission: { disposition: row.disposition as 'PENDING_REVIEW' | 'APPLIED_BY_POLICY', requiresReview: row.requiresReview as boolean, policyRevision: row.policyRevision, approvalSource: row.approvalSource as 'MANUAL_REVIEW_REQUIRED' | 'SYSTEM_POLICY' } };
}
function preset(value: unknown): AdminAvatarPreset {
  const row = obj(value);
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 1 || typeof row.width !== "number" || typeof row.height !== "number") throw new AdminAvatarError("默认头像清单不正确", 0, "CONTRACT");
  return { presetId: str(row.presetId, "presetId"), version: row.version, url: avatarUrl(row.url), width: row.width, height: row.height };
}
export function parseAdminAvatarState(value: unknown): AdminAvatarState {
  const body = obj(value), current = obj(body.current);
  if (current.kind !== "DEFAULT" && current.kind !== "CUSTOM") throw new AdminAvatarError("当前头像类型不正确", 0, "CONTRACT");
  const presets = Array.isArray(body.presets) ? body.presets.map(preset) : [];
  if (presets.length !== 4 || new Set(presets.map(item => item.presetId)).size !== 4) throw new AdminAvatarError("默认头像清单不完整", 0, "CONTRACT");
  const pending = body.pending == null ? null : (() => {
    const row = obj(body.pending);
    return { assetId: str(row.assetId, "pending.assetId"), submittedAt: typeof row.submittedAt === "string" ? row.submittedAt : null, reviewState: str(row.reviewState, "pending.reviewState"), width: typeof row.width === "number" ? row.width : 0, height: typeof row.height === "number" ? row.height : 0, byteSize: typeof row.byteSize === "string" ? row.byteSize : "0" };
  })();
  const lastReview = body.lastReview == null ? null : (() => {
    const row = obj(body.lastReview), state = String(row.state);
    if (!["APPROVED", "REJECTED", "QUARANTINED", "WITHDRAWN"].includes(state)) throw new AdminAvatarError("审核结果状态不正确", 0, "CONTRACT");
    return { assetId: str(row.assetId, "lastReview.assetId"), state: state as AdminAvatarState["lastReview"] extends null ? never : "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN", reason: typeof row.reason === "string" ? row.reason : null, reviewedAt: str(row.reviewedAt, "lastReview.reviewedAt"), applied: row.applied === true, ...(row.source === 'SYSTEM_POLICY' || row.source === 'HUMAN_REVIEW' ? { source: row.source as 'SYSTEM_POLICY' | 'HUMAN_REVIEW' } : {}), policyRevision: typeof row.policyRevision === 'string' && /^[1-9]\d{0,18}$/.test(row.policyRevision) ? row.policyRevision : null };
  })();
  return { revision: rev(body.revision), updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null, current: { kind: current.kind, assetId: typeof current.assetId === "string" ? current.assetId : null, presetId: typeof current.presetId === "string" ? current.presetId : null, url: avatarUrl(current.url), currentVersion: rev(current.currentVersion) }, defaultPresetId: str(body.defaultPresetId, "defaultPresetId"), presets, pending, lastReview, policy: uploadPolicy(body.policy), ...(typeof body.changed === "boolean" ? { changed: body.changed } : {}) };
}

async function errorOf(response: Response): Promise<AdminAvatarError> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown; requestId?: unknown } }, error = body.error ?? {};
    return new AdminAvatarError(typeof error.message === "string" ? error.message : "头像操作未完成", response.status, typeof error.code === "string" ? error.code : undefined, typeof error.requestId === "string" ? error.requestId : undefined);
  } catch { return new AdminAvatarError("头像操作未完成", response.status); }
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, signal }); }
  catch { throw new AdminAvatarError("网络中断，结果未确认", 0, "NETWORK"); }
  if (!response.ok) throw await errorOf(response);
  try { return await response.json(); } catch { throw new AdminAvatarError("头像响应无法解析", 0, "CONTRACT"); }
}

export async function readAdminAvatarState(signal?: AbortSignal): Promise<AdminAvatarState> {
  return parseAdminAvatarState(await request("/api/bff/admin/profile/avatar", { method: "GET" }, signal));
}
export async function selectAdminDefaultAvatar(presetId: string, expectedRevision: string, key: string, signal?: AbortSignal): Promise<AdminAvatarState> {
  return parseAdminAvatarState(await request("/api/bff/admin/profile/avatar/default", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ presetId, expectedRevision }) }, signal));
}
export async function createAdminAvatarUploadIntent(file: File, key: string, expectedRevision: string, signal?: AbortSignal): Promise<{ intentId: string; uploadToken: string }> {
  const row = obj(await request("/api/bff/admin/profile/avatar/upload-intents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ mime: file.type, size: file.size, expectedRevision }) }, signal));
  return { intentId: str(row.intentId, "intentId"), uploadToken: str(row.uploadToken, "uploadToken") };
}
export async function uploadAdminAvatar(intentId: string, token: string, file: File, key: string, signal?: AbortSignal): Promise<AdminAvatarUploadResult> {
  return parseAdminAvatarUploadResult(await request(`/api/bff/admin/profile/avatar/uploads/${encodeURIComponent(intentId)}`, { method: "PUT", headers: { "content-type": file.type, "x-upload-token": token, "idempotency-key": key }, body: file }, signal));
}
export function adminAvatarPreviewUrl(assetId: string): string {
  return `/api/bff/admin/profile/avatar/preview?v=${encodeURIComponent(assetId)}`;
}
export function adminAvatarReviewContentUrl(assetId: string): string {
  return `/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/content`;
}
export async function readAdminAvatarReviews(state: string, cursor: string | null, limit = 20, signal?: AbortSignal): Promise<{ items: AdminAvatarReviewItem[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ state, limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  const body = obj(await request(`/api/bff/admin/profile-avatars?${query}`, { method: "GET" }, signal));
  const items = Array.isArray(body.items) ? body.items.map((value) => {
    const row = obj(value);
    return {
      assetId: str(row.assetId, "assetId"), realm: avatarRealm(row.realm),
      subjectId: str(row.subjectId, "subjectId"), subjectName: typeof row.subjectName === "string" ? row.subjectName : null,
      submittedAt: str(row.submittedAt, "submittedAt"), width: typeof row.width === "number" ? row.width : 0, height: typeof row.height === "number" ? row.height : 0,
      byteSize: typeof row.byteSize === "string" ? row.byteSize : "0", mime: str(row.mime, "mime"), reviewState: str(row.reviewState, "reviewState"),
      accessClass: typeof row.accessClass === "string" ? row.accessClass : "PRIVATE_REVIEW",
      reviewReason: typeof row.reviewReason === "string" ? row.reviewReason : null, revision: str(row.revision, "revision"),
      ...(['SYSTEM_POLICY','HUMAN_REVIEW','MANUAL_REVIEW_REQUIRED'].includes(String(row.approvalSource)) ? { approvalSource: row.approvalSource as AdminAvatarReviewItem['approvalSource'] } : {}),
      policyRevision: typeof row.policyRevision === 'string' && /^[1-9]\d{0,18}$/.test(row.policyRevision) ? row.policyRevision : null,
    };
  }) : [];
  return { items, nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null };
}
export async function reviewAdminAvatar(assetId: string, decision: "APPROVE" | "REJECT" | "QUARANTINE", reason: string | null, expectedRevision: string | null, key: string, signal?: AbortSignal): Promise<unknown> {
  return request(`/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/review`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ decision, ...(reason ? { reason } : {}), ...(expectedRevision ? { expectedRevision } : {}) }) }, signal);
}
export async function withdrawAdminAvatar(assetId: string, reason: string, expectedRevision: string | null, key: string, signal?: AbortSignal): Promise<unknown> {
  return request(`/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/withdraw`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ reason, ...(expectedRevision ? { expectedRevision } : {}) }) }, signal);
}

function avatarRealm(value: unknown): "user" | "admin" {
  if (value !== "user" && value !== "admin") throw new AdminAvatarError("头像主体类型不正确", 0, "CONTRACT");
  return value;
}
export type PendingAdminAvatar = { actorId: string; slot: "default" | "review"; key: string; assetId?: string; action?: "APPROVE" | "REJECT" | "QUARANTINE" | "WITHDRAW"; presetId?: string; reason?: string | null; expectedRevision: string };
const PENDING_PREFIX = "zzsh.admin.profile-avatar:";
export function readPendingAdminAvatar(actorId: string, slot: PendingAdminAvatar["slot"]): PendingAdminAvatar | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_PREFIX + actorId + ":" + slot);
    if (raw === null) return null;
    const value = JSON.parse(raw) as PendingAdminAvatar;
    if (value.actorId !== actorId || value.slot !== slot || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.key) || !/^(0|[1-9]\d{0,18})$/.test(value.expectedRevision)) throw new Error();
    if (slot === "default" ? typeof value.presetId !== "string" || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(value.presetId) : typeof value.assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.assetId) || !["APPROVE", "REJECT", "QUARANTINE", "WITHDRAW"].includes(String(value.action)) || !(value.reason === null || typeof value.reason === "string" && value.reason.length <= 500)) throw new Error();
    return value;
  } catch { throw new AdminAvatarError("原头像操作记录不可读，暂不能再次提交", 0, "PENDING_STORAGE"); }
}
export function savePendingAdminAvatar(value: PendingAdminAvatar): void {
  const prior = readPendingAdminAvatar(value.actorId, value.slot);
  if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new AdminAvatarError("请先确认原头像操作结果", 0, "PENDING");
  try {
    const raw = JSON.stringify(value);
    window.sessionStorage.setItem(PENDING_PREFIX + value.actorId + ":" + value.slot, raw);
    if (window.sessionStorage.getItem(PENDING_PREFIX + value.actorId + ":" + value.slot) !== raw) throw new Error();
  } catch { throw new AdminAvatarError("无法保留原头像操作，未发送请求", 0, "PENDING_STORAGE"); }
}
export function clearPendingAdminAvatar(value: PendingAdminAvatar): void {
  const current = readPendingAdminAvatar(value.actorId, value.slot);
  if (current?.key !== value.key) return;
  window.sessionStorage.removeItem(PENDING_PREFIX + value.actorId + ":" + value.slot);
  if (window.sessionStorage.getItem(PENDING_PREFIX + value.actorId + ":" + value.slot) !== null) throw new AdminAvatarError("已确认头像操作，本地记录尚未清除", 0, "PENDING_STORAGE");
}
export async function readAdminAvatarOperationResult(command: PendingAdminAvatar, signal?: AbortSignal): Promise<{ receipt: "UNRESOLVED" } | { receipt: "RECORDED"; responseStatus: number }> {
  const row = command.slot === "default"
    ? obj(await request("/api/bff/admin/profile/avatar/operation-result?" + new URLSearchParams({operation:"profile.avatar.default.select",presetId:command.presetId!,expectedRevision:command.expectedRevision}), {method:"GET",headers:{"idempotency-key":command.key}}, signal))
    : obj(await request("/api/bff/admin/profile-avatars/operation-result", {method:"POST",headers:{"content-type":"application/json","idempotency-key":command.key},body:JSON.stringify({operation:command.action === "WITHDRAW" ? "profile.avatar.withdraw" : "profile.avatar.review",assetId:command.assetId,...(command.action !== "WITHDRAW" ? {decision:command.action} : {}),reason:command.reason ?? null,expectedRevision:command.expectedRevision})}, signal));
  if (row.receipt === "UNRESOLVED") return {receipt:"UNRESOLVED"};
  if (row.receipt !== "RECORDED" || typeof row.responseStatus !== "number" || !Number.isInteger(row.responseStatus) || row.responseStatus < 200 || row.responseStatus >= 500 || row.responseStatus >= 300 && row.responseStatus < 400) throw new AdminAvatarError("原头像结果无法确认",0,"CONTRACT");
  if (row.responseStatus < 300) {
    if (command.slot === "default") parseAdminAvatarState(row.result);
    else assertAvatarReviewReceipt(row.result,command.assetId!);
  }
  return {receipt:"RECORDED",responseStatus:row.responseStatus};
}
export function assertAvatarReviewReceipt(value: unknown, assetId: string): void {
  const row = obj(value), asset = obj(row.asset), review = obj(row.review);
  if (asset.id !== assetId || typeof review.applied !== "boolean") throw new AdminAvatarError("审核回执与原头像不一致，结果未确认",0,"CONTRACT");
}
export function assertAdminAvatarSubject(state: AdminAvatarState, actorId: string): void {
  if (state.current.url !== `/api/v1/profile/avatars/admin/${encodeURIComponent(actorId)}/${state.current.currentVersion}`) throw new AdminAvatarError("头像响应主体不一致",0,"CONTRACT");
}
