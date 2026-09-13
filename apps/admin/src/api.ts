export const API_ROOT = "/api/bff/admin";
export const CHANNEL_NAME = "zzsh-admin-security";
export const EVENT_KEY = `${CHANNEL_NAME}:event`;
export const IDLE_KEY = "zzsh-admin-idle-minutes";

export type Theme = "dark" | "light";
export type View = "login" | "challenge" | "onboarding" | "recovery" | "app";
export type Signal = "locked" | "unlocked" | "logout" | "activity";
export type SignalEvent = { type: Signal; sessionId?: string; at: number };

export type SessionSnapshot =
  | { authenticated: false }
  | {
      authenticated: true;
      adminUserId: string;
      user: { name?: string; email?: string; username?: string; displayUsername?: string; twoFactorEnabled: boolean };
      security: { status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN"; isBoss: boolean; passwordChangeRequired: boolean };
      session: { id: string; locked: boolean; pinConfigured: boolean; createdAt: string | null; expiresAt: string | null };
      permissions: string[];
    };

export type AdminStatus = "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
export type AdminRoleSummary = { id?: string; code: string; name: string; status?: string };
export type AdminDirectoryEntry = {
  id: string;
  username: string;
  name: string;
  status: AdminStatus;
  isBoss?: boolean;
  createdAt?: string;
  lastFullAuthenticatedAt?: string | null;
  roles?: AdminRoleSummary[];
};
export type AdminDirectoryDetail = AdminDirectoryEntry & {
  allowPermissions?: string[];
  denyPermissions?: string[];
  effectivePermissions?: string[];
};
export type RestorableUserCandidate = {
  id: string;
  username: string;
  name: string;
  accountStatus: "DEACTIVATED";
};
export type AdminPermissionCatalogEntry = { code: string; name: string; description?: string | null };
export type AdminRoleRecord = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  status: "ACTIVE" | "DISABLED";
  permissionCodes: string[];
};
export type CreatedAdministrator = {
  id: string;
  username: string;
  name: string;
  status: AdminStatus;
  temporaryPassword: string;
};

export type SupplyGame = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  catalogRevision: string;
  currentReleaseId: string | null;
  coverMediaId: string | null;
};

export type CatalogItem = {
  id: string;
  code: string;
  name: string;
  unit: "HAFF_BASE" | "ROUND" | "PIECE";
  quantityScale: number;
  required: boolean;
  enabled: boolean;
  sortOrder: number;
  mediaId: string | null;
  sourceField?: string | null;
  sourceToken?: string | null;
  sourceNote?: string | null;
};

export type CatalogSkinCategory = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  enabled: boolean;
  formVisible: boolean;
};

export type CatalogSkin = {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  rarityCode: string | null;
  enabled: boolean;
  formVisible: boolean;
  mediaId: string | null;
  sortOrder: number;
  sourceField?: string | null;
  sourceToken?: string | null;
};

export type CatalogRarity = { id: string; code: string; name: string; sortOrder: number; enabled: boolean };
export type CatalogEntitlement = {
  id: string;
  code: string;
  name: string;
  valueKind: "FLAG" | "LEVEL" | "CAPACITY";
  expiryKind: "PERMANENT" | "TIMED";
  enabled: boolean;
  sortOrder: number;
  sourceField?: string | null;
  sourceToken?: string | null;
};

export type AdminCatalogResponse = {
  game: SupplyGame;
  items: CatalogItem[];
  rarities: CatalogRarity[];
  categories: CatalogSkinCategory[];
  skins: CatalogSkin[];
  entitlements: CatalogEntitlement[];
};

export type PriceLineRecord = {
  priceVersionId: string;
  itemId: string;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
  unitQuantity: string | null;
  buyerUnitAmount: string | null;
  ownerUnitAmount: string | null;
};

export type PriceVersionRecord = {
  id: string;
  gameId: string;
  mode: "SPREAD" | "PERCENT";
  status: "DRAFT" | "SEALED";
  commissionRate: string | null;
  haffRule: Record<string, unknown> | null;
  roundingPolicy: string;
  compensationPolicyRef: string | null;
  revision: string;
  createdAt: string;
  sealedAt: string | null;
};

export type TermVersionRecord = { id: string; gameId: string; status: "DRAFT" | "SEALED"; revision: string; createdAt: string; sealedAt: string | null };
export type TermOptionRecord = { versionId: string; code: string; name: string; dailyConsumption: string; durationRounding: "CEIL_DAY" };
export type AgreementVersionRecord = {
  id: string;
  gameId: string;
  title: string;
  body: string;
  digest: string;
  status: "DRAFT" | "SEALED";
  revision: string;
  createdAt: string;
  sealedAt: string | null;
};

export type RuleReleaseRecord = {
  id: string;
  gameId: string;
  priceVersionId: string;
  termVersionId: string;
  agreementVersionId: string;
  generation: string;
  activatedAt: string;
};

export type RulesResponse = {
  game: SupplyGame;
  release: RuleReleaseRecord | null;
  priceVersions: PriceVersionRecord[];
  priceLines: PriceLineRecord[];
  termVersions: TermVersionRecord[];
  termOptions: TermOptionRecord[];
  agreementVersions: AgreementVersionRecord[];
  items: CatalogItem[];
};

export type MediaAssetReview = {
  id: string;
  gameId: string;
  purpose: "GAME_COVER" | "SKIN_MEDIA" | "ITEM_MEDIA" | "ACCOUNT_EVIDENCE";
  ownershipKind: "PLATFORM_CATALOG" | "USER_SUPPLY";
  ownerUserId: string | null;
  uploadedByRealm: "admin" | "user";
  uploadedByUserId: string | null;
  uploadedByAdminId: string | null;
  contentHash: string;
  mime: string;
  byteSize: string;
  width: number;
  height: number;
  accessClass: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW";
  reviewState: "PENDING" | "APPROVED" | "REJECTED" | "QUARANTINED";
  reviewReason: string | null;
  createdAt: string;
};

export type MediaReviewPage = { items: MediaAssetReview[]; nextCursor: string | null; limit: number };

export type CatalogMediaOption = {
  id: string;
  gameId: string;
  mime: string;
  width: number;
  height: number;
  byteSize: string;
};
export type MediaOptionsResponse = { items: CatalogMediaOption[]; nextCursor: string | null; limit: number };

export type UploadIntentResponse = { intentId: string; uploadToken: string; expiresAt: string };
export type UploadedAssetResponse = { assetId: string; gameId: string; purpose: string; ownershipKind: string; reviewState: string; accessClass: string; mime: string; byteSize: number; width: number; height: number; contentHash: string };

export type AuthResponse = { twoFactorRedirect?: boolean };
export type EnrollmentResponse = { totpURI?: string; backupCodes?: string[] };
export type RecoveryResponse = { recoveryRequestId?: string; status?: string; target?: { username?: string; name?: string } };
export type PendingRecovery = { id: string; username: string; name: string; status: string; createdAt: string; expiresAt: string };

export function hasPermission(snapshot: Extract<SessionSnapshot, { authenticated: true }>, code: string): boolean {
  return snapshot.permissions.includes(code);
}

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId?: string) {
    super(code);
    this.name = "AdminApiError";
  }
}

export type WorkspaceTimeRange = "today" | "7d" | "30d";
/** v2 布局契约：稳定组件 ID + 网格坐标 x/y（12 列）与宽高 w/h。历史 order+size 配置由服务端确定性转换。 */
export type WorkspaceWidgetPlacement = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  timeRange?: WorkspaceTimeRange;
};
export type WorkspaceLayoutPayload = {
  layoutKind: "admin.workspace.layout";
  /** 配置格式版本（当前为 2）；version 是并发更新版本，二者独立。 */
  layoutVersion: number;
  version: number;
  widgets: WorkspaceWidgetPlacement[];
  filteredWidgetIds: string[];
  defaults: WorkspaceWidgetPlacement[];
};

export async function adminRequest<T>(path: string, body?: Record<string, unknown>, method?: "GET" | "POST" | "PUT", extraHeaders: Record<string, string> = {}): Promise<T> {
  let response: Response;
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const idempotencyKey = verb === "GET" ? undefined : `idem_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll("-", "")}`;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method: verb,
      credentials: "include",
      headers: verb === "GET"
        ? undefined
        : { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}), ...extraHeaders },
      body: verb === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new AdminApiError(0, "NETWORK_ERROR");
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: string; requestId?: string } }).error
      : undefined;
    throw new AdminApiError(response.status, error?.code ?? "INTERNAL_ERROR", error?.requestId);
  }
  return payload as T;
}

export function friendlyError(error: unknown): string {
  if (!(error instanceof AdminApiError) || error.code === "NETWORK_ERROR") return "网络暂时不可用，请检查 API 是否已启动后重试。";
  if (error.status === 423) return "本次会话已锁定，请使用 PIN 或完整重新认证继续。";
  if (error.code === "RATE_LIMITED") return "尝试次数过多，请稍后再试。";
  if (error.code === "CONFLICT") return "当前安全状态不允许此操作，请刷新状态后重试。";
  if (error.code === "FORBIDDEN") return "当前账号没有完成此操作的权限或安全条件。";
  if (error.code === "UNAUTHENTICATED") return "账号或密码错误，请检查凭据后重试。";
  if (error.code === "INVALID_CREDENTIALS") return "验证码或凭据无效，请重新输入。";
  if (error.code === "INVALID_PASSWORD") return "当前密码错误，请重新输入。";
  if (error.code === "PASSWORD_TOO_WEAK") return "新密码强度不足，请至少输入 12 位字符。";
  if (error.code === "TWO_FACTOR_REQUIRED") return "需要完成二次验证方可继续。";
  return "操作未完成，请检查输入或刷新页面后重试。";
}

export function formatDate(value: string | null): string {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function readTotpSecret(uri: string): string {
  try { return new URL(uri).searchParams.get("secret") ?? ""; } catch { return ""; }
}

export function readIdleMinutes(): number {
  if (typeof window === "undefined") return 15;
  const value = Number(window.localStorage.getItem(IDLE_KEY));
  return [5, 15, 30, 60].includes(value) ? value : 15;
}

export function signal(type: Signal, sessionId?: string, at = Date.now()): void {
  const event = { type, sessionId, at } satisfies SignalEvent;
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(event);
    channel.close();
  } catch {
    // BroadcastChannel is an enhancement; the storage event below is fallback.
  }
  try { window.localStorage.setItem(EVENT_KEY, JSON.stringify(event)); } catch {
    // Storage fallback.
  }
}

export function makeRecoveryCredential(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
