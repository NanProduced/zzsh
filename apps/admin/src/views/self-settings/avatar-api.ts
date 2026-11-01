export type AdminAvatarPreset = { presetId: string; version: number; url: string; width: number; height: number };
export type AdminAvatarState = {
  revision: string;
  updatedAt: string | null;
  current: { kind: "DEFAULT" | "CUSTOM"; assetId: string | null; presetId: string | null; url: string; currentVersion: string };
  defaultPresetId: string;
  presets: AdminAvatarPreset[];
  pending: { assetId: string; submittedAt: string | null; reviewState: string; width: number; height: number; byteSize: string } | null;
  lastReview: { assetId: string; state: "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN"; reason: string | null; reviewedAt: string; applied: boolean } | null;
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
};

export class AdminAvatarError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code?: string, requestId?: string) { super(message); this.status = status; this.code = code; this.requestId = requestId; }
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
function preset(value: unknown): AdminAvatarPreset {
  const row = obj(value);
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 1 || typeof row.width !== "number" || typeof row.height !== "number") throw new AdminAvatarError("默认头像清单不正确", 0, "CONTRACT");
  return { presetId: str(row.presetId, "presetId"), version: row.version, url: str(row.url, "url"), width: row.width, height: row.height };
}
export function parseAdminAvatarState(value: unknown): AdminAvatarState {
  const body = obj(value), current = obj(body.current);
  if (current.kind !== "DEFAULT" && current.kind !== "CUSTOM") throw new AdminAvatarError("当前头像类型不正确", 0, "CONTRACT");
  const presets = Array.isArray(body.presets) ? body.presets.map(preset) : [];
  if (presets.length !== 4) throw new AdminAvatarError("默认头像清单不完整", 0, "CONTRACT");
  const pending = body.pending == null ? null : (() => {
    const row = obj(body.pending);
    return { assetId: str(row.assetId, "pending.assetId"), submittedAt: typeof row.submittedAt === "string" ? row.submittedAt : null, reviewState: str(row.reviewState, "pending.reviewState"), width: typeof row.width === "number" ? row.width : 0, height: typeof row.height === "number" ? row.height : 0, byteSize: typeof row.byteSize === "string" ? row.byteSize : "0" };
  })();
  const lastReview = body.lastReview == null ? null : (() => {
    const row = obj(body.lastReview), state = String(row.state);
    if (!["APPROVED", "REJECTED", "QUARANTINED", "WITHDRAWN"].includes(state)) throw new AdminAvatarError("审核结果状态不正确", 0, "CONTRACT");
    return { assetId: str(row.assetId, "lastReview.assetId"), state: state as AdminAvatarState["lastReview"] extends null ? never : "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN", reason: typeof row.reason === "string" ? row.reason : null, reviewedAt: str(row.reviewedAt, "lastReview.reviewedAt"), applied: row.applied === true };
  })();
  return { revision: rev(body.revision), updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null, current: { kind: current.kind, assetId: typeof current.assetId === "string" ? current.assetId : null, presetId: typeof current.presetId === "string" ? current.presetId : null, url: str(current.url, "current.url"), currentVersion: rev(current.currentVersion) }, defaultPresetId: str(body.defaultPresetId, "defaultPresetId"), presets, pending, lastReview, ...(typeof body.changed === "boolean" ? { changed: body.changed } : {}) };
}

async function errorOf(response: Response): Promise<AdminAvatarError> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown; requestId?: unknown } }, error = body.error ?? {};
    return new AdminAvatarError(typeof error.message === "string" ? error.message : "头像操作未完成", response.status, typeof error.code === "string" ? error.code : undefined, typeof error.requestId === "string" ? error.requestId : undefined);
  } catch { return new AdminAvatarError("头像操作未完成", response.status); }
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init }); }
  catch { throw new AdminAvatarError("网络中断，结果未确认", 0, "NETWORK"); }
  if (!response.ok) throw await errorOf(response);
  try { return await response.json(); } catch { throw new AdminAvatarError("头像响应无法解析", 0, "CONTRACT"); }
}

export async function readAdminAvatarState(): Promise<AdminAvatarState> {
  return parseAdminAvatarState(await request("/api/bff/admin/profile/avatar", { method: "GET" }));
}
export async function selectAdminDefaultAvatar(presetId: string, expectedRevision: string, key: string): Promise<AdminAvatarState> {
  return parseAdminAvatarState(await request("/api/bff/admin/profile/avatar/default", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ presetId, expectedRevision }) }));
}
export async function createAdminAvatarUploadIntent(file: File, key: string): Promise<{ intentId: string; uploadToken: string }> {
  const row = obj(await request("/api/bff/admin/profile/avatar/upload-intents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ mime: file.type, size: file.size }) }));
  return { intentId: str(row.intentId, "intentId"), uploadToken: str(row.uploadToken, "uploadToken") };
}
export async function uploadAdminAvatar(intentId: string, token: string, file: File, key: string): Promise<void> {
  await request(`/api/bff/admin/profile/avatar/uploads/${encodeURIComponent(intentId)}`, { method: "PUT", headers: { "content-type": file.type, "x-upload-token": token, "idempotency-key": key }, body: file });
}
export function adminAvatarPreviewUrl(assetId: string): string {
  return `/api/bff/admin/profile/avatar/preview?v=${encodeURIComponent(assetId)}`;
}
export function adminAvatarReviewContentUrl(assetId: string): string {
  return `/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/content`;
}
export async function readAdminAvatarReviews(state: string, cursor: string | null, limit = 20): Promise<{ items: AdminAvatarReviewItem[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ state, limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  const body = obj(await request(`/api/bff/admin/profile-avatars?${query}`, { method: "GET" }));
  const items = Array.isArray(body.items) ? body.items.map((value) => {
    const row = obj(value);
    return {
      assetId: str(row.assetId, "assetId"), realm: row.realm === "admin" ? "admin" as const : "user" as const,
      subjectId: str(row.subjectId, "subjectId"), subjectName: typeof row.subjectName === "string" ? row.subjectName : null,
      submittedAt: str(row.submittedAt, "submittedAt"), width: typeof row.width === "number" ? row.width : 0, height: typeof row.height === "number" ? row.height : 0,
      byteSize: typeof row.byteSize === "string" ? row.byteSize : "0", mime: str(row.mime, "mime"), reviewState: str(row.reviewState, "reviewState"),
      accessClass: typeof row.accessClass === "string" ? row.accessClass : "PRIVATE_REVIEW",
      reviewReason: typeof row.reviewReason === "string" ? row.reviewReason : null, revision: str(row.revision, "revision"),
    };
  }) : [];
  return { items, nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null };
}
export async function reviewAdminAvatar(assetId: string, decision: "APPROVE" | "REJECT" | "QUARANTINE", reason: string | null, expectedRevision: string | null, key: string): Promise<unknown> {
  return request(`/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/review`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ decision, ...(reason ? { reason } : {}), ...(expectedRevision ? { expectedRevision } : {}) }) });
}
export async function withdrawAdminAvatar(assetId: string, reason: string, expectedRevision: string | null, key: string): Promise<unknown> {
  return request(`/api/bff/admin/profile-avatars/${encodeURIComponent(assetId)}/withdraw`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ reason, ...(expectedRevision ? { expectedRevision } : {}) }) });
}
