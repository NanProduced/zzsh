export const API_ROOT = "/api/bff/admin";
export const CHANNEL_NAME = "zzsh-admin-security";
export const EVENT_KEY = `${CHANNEL_NAME}:event`;
export const IDLE_KEY = "zzsh-admin-idle-minutes";
export const ADMIN_AUTH_FAILURE_EVENT = "zzsh-admin-auth-failure";

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

export type UserDirectorySourceKind = "LOCAL" | "MIGRATED" | "UNKNOWN";
export type UserDirectoryItem = {
  userId: string;
  name: string;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  maskedPhone: string | null;
  accountStatus: "ACTIVE" | "RESTRICTED" | "DEACTIVATED" | "CANCELLED" | "UNKNOWN";
  suspended: boolean;
  identityStatus: "UNVERIFIED" | "VERIFIED" | "REJECTED" | "UNKNOWN";
  ageStatus: string;
  source: { kind: UserDirectorySourceKind; legacyId?: string };
  registeredAt: string | null;
  registeredAtSource: "LEGACY" | "LOCAL";
  localCreatedAt: string;
  createdAt: string;
  updatedAt: string;
  resourceSummary: { state: "ready"; count: number } | { state: "denied"; permission: string };
  orderSummary: { state: "ready"; currentCount: number } | { state: "denied"; permission: string };
  lastBusinessActivity: { state: "not_connected"; domains: string[] };
};
export type UserDirectoryPage = { items?: UserDirectoryItem[]; nextCursor?: string | null; limit?: number };

export type UserDirectoryDetail = Omit<UserDirectoryItem, "source"> & {
  phoneNumberVerified: boolean | null;
  maskedEmail: string | null;
  identity: { status: string; ageStatus: string; provider: string | null; verifiedAt: string | null };
  source: {
    kind: UserDirectorySourceKind;
    legacyId?: string;
    sourceSystem?: string | null;
    sourceEntity?: string | null;
    sourceCreatedAt?: string | null;
    sourceUpdatedAt?: string | null;
    sourceDigest?: string | null;
    evidenceRef?: string | null;
    migratedAt?: string | null;
  };
  localUpdatedAt: string;
};

export type UserRentalAccountItem = {
  accountId: string;
  displayNo: string | null;
  game: { id: string; code: string; name: string };
  lifecycle: "ACTIVE" | "ARCHIVED";
  ownerPaused: boolean;
  staffRestricted: boolean;
  restrictionReason: string | null;
  legacyHold: "NONE" | "UNRESOLVED" | "ACTIVE_LEGACY";
  currentVersionId: string | null;
  publication: { versionState: string | null; source: string | null; versionPublished: boolean };
  createdAt: string;
};
export type UserRentalAccountPage = { items?: UserRentalAccountItem[]; nextCursor?: string | null };

export type UserOrderAmount = { currency: string; unit: string; amount: string; scale: number };
export type UserOrderItem = {
  orderId: string;
  displayNo: string;
  status: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED";
  role: "renter" | "owner";
  accountId?: string;
  accountDisplayNo?: string | null;
  title: string;
  gameId: string;
  counterpartyName: string;
  amounts: { rental: UserOrderAmount | null; deposit: UserOrderAmount | null; totalDue: UserOrderAmount | null };
  createdAt: string | null;
  holdUntil: string | null;
  payment?: { state: string; recordedAt: string | null; recordedAmount: UserOrderAmount | null };
  source?: { origin: string; statusLabel?: string };
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  expiredAwaitingCancel: boolean;
};
export type UserOrderPage = { items?: UserOrderItem[]; nextCursor?: string | null };

export type UserAuditEventItem = {
  eventId: string;
  actorType: string;
  actor: { username: string | null; displayUsername: string | null; name: string };
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
  requestId: string | null;
  occurredAt: string | null;
  details: Record<string, unknown>;
};
export type UserAuditEventPage = { items?: UserAuditEventItem[]; nextCursor?: string | null; scope?: string };
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
  services?: Array<{
    id: string;
    serviceCode: "ACCOUNT_RENTAL" | "GUNSMITH";
    enabled: boolean;
    revision: string;
    supported: boolean;
  }>;
};

export type CatalogItem = {
  id: string;
  code: string;
  name: string;
  unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
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
  sourceNamespace: string | null;
  baseName: string | null;
  aliases: string[];
  namingState: "LEGACY" | "PENDING" | "VERIFIED";
  ownerRef: { kind: "AGENT" | "MELEE_TYPE" | "FIREARM"; id: string } | null;
};

export type CatalogSkinOwner = { id: string; kind: "AGENT" | "MELEE_TYPE"; code: string; name: string; enabled: boolean };

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
  owners: CatalogSkinOwner[];
  entitlements: CatalogEntitlement[];
};

export type AdminGunsmithClassification = {
  id: string;
  gameId: string;
  code: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  revision: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};
export type AdminGunsmithFirearm = {
  id: string;
  gameId: string;
  code: string;
  name: string;
  classificationId: string | null;
  classificationCode?: string | null;
  classificationName?: string | null;
  enabled: boolean;
  sortOrder: number;
  mediaId: string | null;
  codeCount?: number;
  revision: string;
  updatedAt: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};
export type AdminGunsmithAlias = {
  id: string;
  gameId: string;
  firearmId: string;
  locale: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  revision: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};
export type AdminGunsmithCode = {
  id: string;
  gameId: string;
  firearmId: string;
  code: string;
  note: string;
  modeCode: "HAZARD" | "BATTLEFIELD" | "GENERAL" | null;
  status: "ACTIVE" | "WITHDRAWN";
  lastReviewedAt: string | null;
  revision: string;
  updatedAt: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};
export type AdminGunsmithResponse = {
  classifications: AdminGunsmithClassification[];
  firearms: AdminGunsmithFirearm[];
  aliases: AdminGunsmithAlias[];
  codes: AdminGunsmithCode[];
};

export type PriceLineRecord = {
  priceVersionId: string;
  customerTier?: "STANDARD" | "VIP" | "SVIP" | "DISCOUNT_USER";
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
  accountId?: string | null;
  gameId: string;
  purpose: "GAME_COVER" | "SKIN_MEDIA" | "ITEM_MEDIA" | "FIREARM_MEDIA" | "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
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
export type UploadedAssetResponse = { assetId: string; gameId: string | null; purpose: string; ownershipKind: string; reviewState: string; accessClass: string; mime: string; byteSize: number; width: number; height: number; contentHash: string };

export type ContentType = "ANNOUNCEMENT" | "NEWS";
export type ContentDraftSummary = {
  id: string;
  sequence: number;
  state: "DRAFT" | "PUBLISHED" | "SUPERSEDED" | "WITHDRAWN";
  revision: string;
  title: string;
  summary: string;
  body: string;
  coverMediaId: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type ContentItemRow = {
  id: string;
  type: ContentType;
  gameId: string | null;
  gameName: string | null;
  sortOrder: number;
  revision: string;
  createdAt: string;
  updatedAt: string;
  draft: ContentDraftSummary | null;
  published: ContentDraftSummary | null;
  latest: ContentDraftSummary | null;
};

export type ContentVersionRow = ContentDraftSummary & { itemId: string; createdAt: string };
export type ContentItemDetail = { item: ContentItemRow; versions: ContentVersionRow[] };
export type ContentItemsPage = { items: ContentItemRow[]; nextCursor: string | null; limit: number };
export type ContentGame = { id: string; code: string; name: string };

export type ContentMediaOption = { id: string; mime: string; width: number; height: number; byteSize: string };
export type ContentMediaOptionsPage = { items: ContentMediaOption[]; nextCursor: string | null; limit: number };
export type ContentMediaRow = {
  id: string;
  mime: string;
  byteSize: string;
  width: number;
  height: number;
  reviewState: "PENDING" | "APPROVED" | "REJECTED" | "QUARANTINED";
  accessClass: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW";
  reviewReason: string | null;
  updatedAt: string;
};
export type ContentMediaPage = { items: ContentMediaRow[]; nextCursor: string | null; limit: number };

export type CarouselRow = {
  id: string;
  slotCode: "HOME_HERO";
  mediaId: string;
  imageAlt: string;
  title: string;
  description: string;
  linkUrl: string | null;
  enabled: boolean;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
  mediaReviewState?: string | null;
  mediaAccessClass?: string | null;
};
export type CarouselPage = { items: CarouselRow[]; nextCursor: string | null; limit: number };

export type AdminOrderMoney = { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 };
export type AdminOrder = {
  id: string;
  displayNo: string;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "COMPLETED";
  accountId: string;
  versionId: string;
  title: string;
  termOptionCode: string;
  termSeconds: string;
  amounts: { rental: AdminOrderMoney; deposit: AdminOrderMoney; totalDue: AdminOrderMoney; currency: "CNY" };
  createdAt: string;
  holdUntil: string;
  expiredAwaitingCancel: boolean;
  paymentOpen: boolean;
  cancelOpen: boolean;
  paidAt?: string | null;
  cancelReason?: "USER" | "TIMEOUT" | null;
  cancelledAt?: string | null;
  ownerUserId: string;
  renterUserId: string;
  ownerName: string;
  renterName: string;
  gameId: string;
  releaseId: string;
  contentHash: string;
  revision: string;
  fulfillmentAssignment?: {
    state: "WAITING" | "ASSIGNED";
    waitingReason: string | null;
    assignedAt: string | null;
    teamReady: boolean;
    teamState: string | null;
  };
  supportEscalation?: {
    firstResponseAt: string | null;
    remindDueAt: string | null;
    addRound: number;
    state: string;
    needsManualReview: boolean;
    noEligibleStaff: boolean;
  };
  quote: Record<string, unknown> | null;
};
export type AdminOrdersPage = { items: AdminOrder[]; nextCursor: string | null; limit: number };
export type AdminSettlementResponse = Record<string, unknown>;

export type AuthResponse = { twoFactorRedirect?: boolean };
export type EnrollmentResponse = { totpURI?: string; backupCodes?: string[] };
export type RecoveryResponse = { recoveryRequestId?: string; status?: string; target?: { username?: string; name?: string } };
export type PendingRecovery = { id: string; username: string; name: string; status: string; createdAt: string; expiresAt: string };

export function hasPermission(snapshot: Extract<SessionSnapshot, { authenticated: true }>, code: string): boolean {
  return snapshot.permissions.includes(code);
}

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId?: string, readonly path?: string, readonly details: readonly {path:string;code:string}[] = []) {
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

export async function adminRequest<T>(path: string, body?: Record<string, unknown>, method?: "GET" | "POST" | "PUT", extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
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
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AdminApiError(0, "NETWORK_ERROR", undefined, path);
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: string; requestId?: string } }).error
      : undefined;
    if ((response.status === 401 || response.status === 423) && path !== "/session" && !path.startsWith("/auth/")) {
      window.dispatchEvent(new CustomEvent(ADMIN_AUTH_FAILURE_EVENT, { detail: { status: response.status, path } }));
    }
    const rawDetails=(payload as {error?:{details?:unknown}}|null)?.error?.details;
    const details=Array.isArray(rawDetails)?rawDetails.slice(0,32).filter((value):value is {path:string;code:string}=>!!value&&typeof value.path==="string"&&value.path.length<=256&&typeof value.code==="string"&&value.code.length<=64):[];
    throw new AdminApiError(response.status, error?.code ?? "INTERNAL_ERROR", error?.requestId ?? response.headers.get("x-request-id") ?? undefined, path, details);
  }
  return payload as T;
}

export function friendlyError(error: unknown): string {
  if (!(error instanceof AdminApiError)) return "操作未完成，请重试；若仍失败，请联系维护人员。";
  if (error.status === 0 || error.code === "NETWORK_ERROR") return "网络连接失败，请检查连接后重试。";
  const auth = error.path === undefined || error.path.startsWith("/auth/");
  const reference = error.requestId ? ` 请求编号：${error.requestId}` : "";
  if (!auth) {
    if (error.status === 400) return "查询或输入有误，请检查条件后重试。" + reference;
    if (error.status === 401) return "会话已失效，请重新登录后继续。" + reference;
    if (error.status === 403) return "当前账号没有访问此内容或执行此操作的权限。" + reference;
    if (error.status === 404) return "未找到此内容，或当前账号无权访问；请核对引用与权限。" + reference;
    if (error.status >= 500) return "服务暂时无法完成请求，请稍后重试；若仍失败，请提供请求编号。" + reference;
    if (error.status === 409) return "数据或操作状态已变化，请刷新后重新核对。" + reference;
  }
  if (error.status === 423) return "本次会话已锁定，请使用 PIN 或完整重新认证继续。";
  if (error.code === "RATE_LIMITED") return "尝试次数过多，请稍后再试。";
  if (error.code === "CONFLICT") return "当前安全状态不允许此操作，请刷新状态后重试。";
  if (error.code === "FORBIDDEN") return "当前账号没有完成此操作的权限或安全条件。";
  if (error.code === "UNAUTHENTICATED") return "账号或密码错误，请检查凭据后重试。";
  if (error.code === "INVALID_CREDENTIALS") return "验证码或凭据无效，请重新输入。";
  if (error.code === "INVALID_PASSWORD") return "当前密码错误，请重新输入。";
  if (error.code === "PASSWORD_TOO_WEAK") return "新密码强度不足，请至少输入 12 位字符。";
  if (error.code === "TWO_FACTOR_REQUIRED") return "需要完成二次验证方可继续。";
  return "操作未完成，请检查输入或刷新页面后重试。" + reference;
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
