import type {
  DraftInput,
  Favorite,
  MySupply,
  Page,
  PublicCatalog,
  PublicListing,
  PublishingCatalog,
  PublishingOptions,
  SupplyErrorBody,
  SupplyFieldError,
  SupplyGame,
  VersionToken,
  SavedDeclaration,
} from "./supply-types.ts";

export function editableDeclaration(saved: SavedDeclaration): DraftInput {
  return {
    title: saved.title,
    description: saved.description,
    attributes: saved.attributes,
    termOptionCode: saved.termOptionCode,
    pricingOptionCode: saved.pricingOptionCode,
    inventory: saved.inventory,
    skins: saved.skins,
    entitlements: saved.entitlements,
    mediaBindings: saved.mediaBindings.map(({ assetId, position }) => ({
      assetId,
      position,
    })),
  };
}

export const supplyGroups = [
  "basics",
  "inventory",
  "skins",
  "entitlements",
  "media",
  "rules",
] as const;
export type SupplyGroup = (typeof supplyGroups)[number] | "form";
export function groupForField(path: string): SupplyGroup {
  const field = path.split(/[.\[]/, 1)[0];
  if (["title", "description", "attributes"].includes(field ?? ""))
    return "basics";
  if (field === "inventory" || field === "skins" || field === "entitlements")
    return field;
  if (field === "mediaBindings" || field === "mime" || field === "size")
    return "media";
  if (
    [
      "rules",
      "termOptionCode",
      "pricingOptionCode",
      "releaseId",
      "contentHash",
    ].includes(field ?? "")
  )
    return "rules";
  return "form";
}
export const supplyBlockerMessages: Record<string, string> = {
  OWNER_UNAVAILABLE: "号主账号暂不可用",
  IDENTITY_REQUIRED: "请先完成实名验证",
  ADULT_REQUIRED: "需确认成年资格",
  GAME_UNAVAILABLE: "游戏暂不可发布",
  RULE_CHANGED: "规则已更新，请重新预览并确认",
  ACCOUNT_NOT_PUBLISHABLE: "历史异常或归档资料需先处理",
  PUBLISHER_BAIL_UNCONFIRMED: "发布保证金资格尚未确认",
  OCCUPIED: "账号当前被占用",
  OCCUPANCY_UNKNOWN: "暂不能确认账号是否空闲",
  REVIEW_REQUIRED: "等待资料审核",
  OWNER_PAUSED: "号主已暂停接单",
  STAFF_RESTRICTED: "客服限制尚未解除",
  CONFIRMATION_OR_MEDIA_REQUIRED: "需完成规则确认或图片审核",
  HISTORICAL_VERSION: "这是历史版本",
};
export class SupplyRequestError extends Error {
  status: number;
  code: string;
  requestId?: string;
  details: SupplyFieldError[];
  idempotencyKey?: string;
  constructor(status: number, body: SupplyErrorBody | null, key?: string) {
    const payload =
      body?.error && typeof body.error === "object" ? body.error : undefined;
    super(
      typeof payload?.message === "string"
        ? payload.message
        : "请求未完成，请检查输入或稍后重试",
    );
    this.name = "SupplyRequestError";
    this.status = status;
    this.code =
      typeof payload?.code === "string"
        ? payload.code
        : status === 0
          ? "NETWORK_ERROR"
          : "INTERNAL_ERROR";
    this.requestId =
      typeof payload?.requestId === "string" ? payload.requestId : undefined;
    this.details = Array.isArray(payload?.details)
      ? payload.details.filter(
          (d) => typeof d?.path === "string" && typeof d?.code === "string",
        )
      : [];
    this.idempotencyKey = key;
  }
}
export function supplyRecovery(error: SupplyRequestError): {
  action:
    | "LOGIN"
    | "RELOAD_AND_CONFIRM"
    | "CORRECT_FIELDS"
    | "UNAVAILABLE"
    | "FORBIDDEN"
    | "RETRY_SAME_REQUEST";
  groups: SupplyGroup[];
  preserveDraft: true;
} {
  const action =
    error.status === 401
      ? "LOGIN"
      : error.status === 409
        ? "RELOAD_AND_CONFIRM"
        : error.status === 400 || error.status === 413
          ? "CORRECT_FIELDS"
          : error.status === 404
            ? "UNAVAILABLE"
            : error.status === 403
              ? "FORBIDDEN"
              : "RETRY_SAME_REQUEST";
  return {
    action,
    groups: [...new Set(error.details.map((d) => groupForField(d.path)))],
    preserveDraft: true,
  };
}
type ReadOptions = { method?: "GET"; signal?: AbortSignal };
type WriteOptions = {
  method: "POST" | "PUT";
  body: unknown;
  idempotencyKey: string;
  signal?: AbortSignal;
};
export async function supplyRequest<T>(
  path: string,
  options: ReadOptions | WriteOptions = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://"))
    throw new Error("Supply path must be relative");
  const write = options.method === "POST" || options.method === "PUT",
    key = write ? options.idempotencyKey : undefined;
  let response: Response;
  try {
    response = await fetch("/api/supply" + path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      ...(write
        ? {
            headers: {
              "content-type": "application/json",
              "idempotency-key": key!,
            },
            body: JSON.stringify(options.body),
          }
        : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new SupplyRequestError(0, null, key);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null)
    throw new SupplyRequestError(
      body === null ? 502 : response.status,
      body as SupplyErrorBody | null,
      key,
    );
  return body as T;
}
const id = (value: string) => encodeURIComponent(value);
export const supplyApi = {
  games: (signal?: AbortSignal) =>
    supplyRequest<{ games: SupplyGame[] }>("/games", { signal }),
  market: (query: URLSearchParams = new URLSearchParams(), signal?: AbortSignal) =>
    supplyRequest<Page<PublicListing>>("/listings?" + query, { signal }),
  listing: (accountId: string, signal?: AbortSignal) =>
    supplyRequest<PublicListing>("/listings/" + id(accountId), { signal }),
  catalog: (
    gameId: string,
    query: URLSearchParams = new URLSearchParams(),
    signal?: AbortSignal,
  ) =>
    supplyRequest<PublishingCatalog>(
      "/games/" + id(gameId) + "/publishing-catalog?" + query,
      { signal },
    ),
  publishingOptions: (gameId: string, signal?: AbortSignal) =>
    supplyRequest<PublishingOptions>(
      "/games/" + id(gameId) + "/publishing-options",
      { signal },
    ),
  browseCatalog: (
    gameId: string,
    query: URLSearchParams = new URLSearchParams(),
    signal?: AbortSignal,
  ) =>
    supplyRequest<PublicCatalog>(
      "/games/" + id(gameId) + "/catalog?" + query,
      { signal },
    ),
  favorites: (
    query: URLSearchParams = new URLSearchParams(),
    signal?: AbortSignal,
  ) => supplyRequest<Page<Favorite>>("/me/favorites?" + query, { signal }),
  setFavorite: (accountId: string, saved: boolean, key: string) =>
    supplyRequest<{ accountId: string; saved: boolean }>(
      "/favorites/" + id(accountId),
      { method: "PUT", body: { saved }, idempotencyKey: key },
    ),
  mine: (accountId: string, signal?: AbortSignal) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId), { signal }),
  myAccounts: (
    query: URLSearchParams = new URLSearchParams(),
    signal?: AbortSignal,
  ) =>
    supplyRequest<
      Page<{
        id: string;
        title: string | null;
        game_name: string;
        review_state: string | null;
        sequence: string | null;
        owner_paused: boolean;
        staff_restricted: boolean;
      }>
    >("/me/accounts?" + query, { signal }),
  createAccount: (gameId: string, key: string, signal?: AbortSignal) =>
    supplyRequest<{ accountId: string; gameId: string }>("/accounts", {
      method: "POST",
      body: { gameId },
      idempotencyKey: key,
      signal,
    }),
  createDraft: (accountId: string, expectedRevision: string, key: string, signal?: AbortSignal) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId) + "/drafts", {
      method: "POST",
      body: { expectedRevision },
      idempotencyKey: key,
      signal,
    }),
  quote: (accountId: string, expectedRevision: string, key: string, signal?: AbortSignal) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId) + "/quote", {
      method: "POST",
      body: { expectedRevision },
      idempotencyKey: key,
      signal,
    }),
  withdraw: (
    accountId: string,
    expectedRevision: string,
    versionId: string,
    key: string,
    reason?: string,
    signal?: AbortSignal,
  ) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId) + "/withdraw", {
      method: "POST",
      body: { expectedRevision, versionId, ...(reason ? { reason } : {}) },
      idempotencyKey: key,
      signal,
    }),
  setPaused: (
    accountId: string,
    paused: boolean,
    expectedRevision: string,
    key: string,
    reason?: string,
    signal?: AbortSignal,
  ) =>
    supplyRequest<MySupply>(
      "/accounts/" + id(accountId) + (paused ? "/pause" : "/resume"),
      {
        method: "POST",
        body: { expectedRevision, ...(reason ? { reason } : {}) },
        idempotencyKey: key,
        signal,
      },
    ),
  saveDraft: (
    accountId: string,
    body: DraftInput & { expectedRevision: string },
    key: string,
    signal?: AbortSignal,
  ) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId) + "/draft", {
      method: "PUT",
      body,
      idempotencyKey: key,
      signal,
    }),
  confirm: (
    accountId: string,
    action: "accept-rules" | "submit",
    body: VersionToken,
    key: string,
    signal?: AbortSignal,
  ) =>
    supplyRequest<MySupply>("/accounts/" + id(accountId) + "/" + action, {
      method: "POST",
      body,
      idempotencyKey: key,
      signal,
    }),
};

export async function uploadSupplyMedia(input: {
  gameId: string;
  accountId: string;
  purpose: "ACCOUNT_EVIDENCE" | "ACCOUNT_DISPLAY";
  file: Blob;
  intentKey: string;
  uploadKey: string;
  signal?: AbortSignal;
  beforeBytesUpload?: () => Promise<boolean>;
}): Promise<{ assetId: string; purpose: string; reviewState: string } | null> {
  const intent = await supplyRequest<{ intentId: string; uploadToken: string }>(
    "/media/upload-intents",
    {
      method: "POST",
      body: {
        gameId: input.gameId,
        accountId: input.accountId,
        purpose: input.purpose,
        mime: input.file.type,
        size: input.file.size,
      },
      idempotencyKey: input.intentKey,
      signal: input.signal,
    },
  );
  if (input.beforeBytesUpload && !(await input.beforeBytesUpload())) return null;
  let response: Response;
  try {
    response = await fetch("/api/supply/media/uploads/" + id(intent.intentId), {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": input.file.type,
        "x-upload-token": intent.uploadToken,
        "idempotency-key": input.uploadKey,
      },
      body: input.file,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new SupplyRequestError(0, null, input.uploadKey);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null)
    throw new SupplyRequestError(
      body === null ? 502 : response.status,
      body,
      input.uploadKey,
    );
  return body;
}
