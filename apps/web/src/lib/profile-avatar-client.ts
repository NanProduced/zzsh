export type AvatarPreset = { presetId: string; version: number; url: string; width: number; height: number };

export type AvatarState = {
  revision: string;
  updatedAt: string | null;
  current: { kind: "DEFAULT" | "CUSTOM"; assetId: string | null; presetId: string | null; url: string; currentVersion: string };
  defaultPresetId: string;
  presets: AvatarPreset[];
  pending: { assetId: string; submittedAt: string | null; reviewState: string; width: number; height: number; byteSize: string } | null;
  lastReview: { assetId: string; state: "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN"; reason: string | null; reviewedAt: string; applied: boolean } | null;
  changed?: boolean;
};

export class ProfileAvatarError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProfileAvatarError("头像状态返回格式不正确", 0, "CONTRACT");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProfileAvatarError(`头像状态缺少 ${label}`, 0, "CONTRACT");
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(value)) throw new ProfileAvatarError("头像版本不正确", 0, "CONTRACT");
  return value;
}

function preset(value: unknown): AvatarPreset {
  const row = record(value);
  const version = row.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new ProfileAvatarError("默认头像版本不正确", 0, "CONTRACT");
  if (typeof row.width !== "number" || typeof row.height !== "number") throw new ProfileAvatarError("默认头像尺寸不正确", 0, "CONTRACT");
  return {
    presetId: text(row.presetId, "presetId"),
    version,
    url: text(row.url, "url"),
    width: row.width,
    height: row.height,
  };
}

export function parseAvatarState(value: unknown): AvatarState {
  const body = record(value);
  const current = record(body.current);
  const kind = current.kind;
  if (kind !== "DEFAULT" && kind !== "CUSTOM") throw new ProfileAvatarError("当前头像类型不正确", 0, "CONTRACT");
  const presets = Array.isArray(body.presets) ? body.presets.map(preset) : [];
  if (presets.length !== 4) throw new ProfileAvatarError("默认头像清单不完整", 0, "CONTRACT");
  const pending = body.pending === null || body.pending === undefined ? null : (() => {
    const row = record(body.pending);
    return {
      assetId: text(row.assetId, "pending.assetId"),
      submittedAt: typeof row.submittedAt === "string" ? row.submittedAt : null,
      reviewState: text(row.reviewState, "pending.reviewState"),
      width: typeof row.width === "number" ? row.width : 0,
      height: typeof row.height === "number" ? row.height : 0,
      byteSize: typeof row.byteSize === "string" ? row.byteSize : "0",
    };
  })();
  const lastReview = body.lastReview === null || body.lastReview === undefined ? null : (() => {
    const row = record(body.lastReview);
    const state = row.state;
    if (!["APPROVED", "REJECTED", "QUARANTINED", "WITHDRAWN"].includes(String(state))) throw new ProfileAvatarError("审核结果状态不正确", 0, "CONTRACT");
    return {
      assetId: text(row.assetId, "lastReview.assetId"),
      state: state as "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN",
      reason: typeof row.reason === "string" ? row.reason : null,
      reviewedAt: text(row.reviewedAt, "lastReview.reviewedAt"),
      applied: row.applied === true,
    };
  })();
  return {
    revision: revision(body.revision),
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null,
    current: {
      kind,
      assetId: typeof current.assetId === "string" ? current.assetId : null,
      presetId: typeof current.presetId === "string" ? current.presetId : null,
      url: text(current.url, "current.url"),
      currentVersion: revision(current.currentVersion),
    },
    defaultPresetId: text(body.defaultPresetId, "defaultPresetId"),
    presets,
    pending,
    lastReview,
    ...(typeof body.changed === "boolean" ? { changed: body.changed } : {}),
  };
}

async function errorOf(response: Response): Promise<ProfileAvatarError> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown; requestId?: unknown } };
    const error = body.error ?? {};
    return new ProfileAvatarError(typeof error.message === "string" ? error.message : "头像操作未完成", response.status, typeof error.code === "string" ? error.code : undefined, typeof error.requestId === "string" ? error.requestId : undefined);
  } catch {
    return new ProfileAvatarError("头像操作未完成", response.status);
  }
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ProfileAvatarError("网络中断，结果未确认；请刷新状态后再决定是否重试", 0, "NETWORK");
  }
  if (!response.ok) throw await errorOf(response);
  try {
    return await response.json();
  } catch {
    throw new ProfileAvatarError("头像响应无法解析，结果未确认", 0, "CONTRACT");
  }
}

export async function readAvatarState(signal?: AbortSignal): Promise<AvatarState> {
  return parseAvatarState(await request("/api/v1/profile/avatar", { method: "GET" }, signal));
}

export async function selectDefaultAvatar(presetId: string, expectedRevision: string, key: string, signal?: AbortSignal): Promise<AvatarState> {
  return parseAvatarState(await request("/api/v1/profile/avatar/default", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ presetId, expectedRevision }),
  }, signal));
}

export async function createAvatarUploadIntent(file: File, key: string, signal?: AbortSignal): Promise<{ intentId: string; uploadToken: string }> {
  const response = record(await request("/api/v1/profile/avatar/upload-intents", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ mime: file.type, size: file.size }),
  }, signal));
  return { intentId: text(response.intentId, "intentId"), uploadToken: text(response.uploadToken, "uploadToken") };
}

export async function uploadAvatar(intentId: string, uploadToken: string, file: File, key: string, signal?: AbortSignal): Promise<void> {
  await request(`/api/v1/profile/avatar/uploads/${encodeURIComponent(intentId)}`, {
    method: "PUT",
    headers: { "content-type": file.type, "x-upload-token": uploadToken, "idempotency-key": key },
    body: file,
  }, signal);
}

export async function readAvatarOperationResult(key: string, presetId: string, expectedRevision: string, signal?: AbortSignal): Promise<unknown> {
  const query = new URLSearchParams({ operation: "profile.avatar.default.select", presetId, expectedRevision });
  return request(`/api/v1/profile/avatar/operation-result?${query}`, {
    method: "GET",
    headers: { "idempotency-key": key },
  }, signal);
}
