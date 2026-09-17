import { createHash, randomBytes } from "node:crypto";

const DEFAULT_V1_ENDPOINT = "https://api.yunxinapi.com";
const DEFAULT_V2_ENDPOINT = "https://open.yunxinapi.com";
const ALLOWED_V1_ENDPOINTS = new Set([
  "api.yunxinapi.com",
  "api-cn-bak.yunxinapi.com",
  "api-sg.yunxinapi.com",
  "api-sg-bak.yunxinapi.com",
]);
const ALLOWED_V2_ENDPOINTS = new Set([
  "open.yunxinapi.com",
  "open-bak.yunxinapi.com",
  "open-sg.yunxinapi.com",
  "open-sg-bak.yunxinapi.com",
]);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/;
const TEAM_ID_PATTERN = /^[0-9]{1,19}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type YunxinProfile = {
  accountId: string;
  name?: string;
  avatar?: string;
  sign?: string;
  email?: string;
  birthday?: string;
  mobile?: string;
  gender?: number;
  extension?: string;
};

export type YunxinProfilePatch = Omit<YunxinProfile, "accountId">;

export type YunxinCreatedAccount = {
  accountId: string;
  token: string;
  profile: YunxinProfile;
};

export type YunxinAccountState = {
  accountId: string;
  enabled: boolean;
  p2pChatBanned: boolean | null;
  teamChatBanned: boolean | null;
  chatroomChatBanned: boolean | null;
  qchatChatBanned: boolean | null;
};

export type YunxinOnlineSession = {
  clientType: number;
  loginTime: number;
};

export type YunxinOnlineStatus = {
  accountId: string;
  online: boolean;
  sessions: YunxinOnlineSession[];
};

export type YunxinAccountLookupFailure = {
  accountId: string;
  providerCode: number | null;
};

export type YunxinServerApi = {
  createAccount(input: YunxinCreateAccountInput): Promise<YunxinCreatedAccount>;
  getProfile(accountId: string): Promise<YunxinProfile>;
  getProfiles(accountIds: string[]): Promise<{
    profiles: YunxinProfile[];
    failed: YunxinAccountLookupFailure[];
  }>;
  updateProfile(accountId: string, patch: YunxinProfilePatch): Promise<void>;
  getAccount(accountId: string): Promise<YunxinAccountState>;
  setAccountEnabled(accountId: string, enabled: boolean, needKick?: boolean): Promise<YunxinAccountState>;
  /** Account-level maintenance only; Web sessions must use a dynamic token provider. */
  refreshAccountToken(accountId: string): Promise<{ accountId: string; token: string }>;
  getOnlineStatuses(accountIds: string[]): Promise<{
    statuses: YunxinOnlineStatus[];
    failed: YunxinAccountLookupFailure[];
  }>;
};

export type YunxinSupportTeamCreateInput = {
  appId: string;
  consultationId: string;
  ownerAccountId: string;
  memberAccountIds: string[];
};

export type YunxinSupportTeamState = {
  teamId: string;
  ownerAccountId: string;
  memberAccountIds: string[];
  serverExtension: string | null;
};

export type YunxinSupportTeamLookup =
  | { status: "FOUND"; team: YunxinSupportTeamState }
  | { status: "ABSENT" }
  | { status: "AMBIGUOUS" };

/** The small server-only surface used to isolate one consultation from another. */
export type YunxinSupportScopeApi = {
  createSupportTeam(input: YunxinSupportTeamCreateInput): Promise<{ teamId: string }>;
  addSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void>;
  removeSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void>;
  dismissSupportTeam(teamId: string, ownerAccountId: string): Promise<void>;
  getSupportTeam(teamId: string): Promise<YunxinSupportTeamState | null>;
  findSupportTeam(input: { appId: string; consultationId: string; ownerAccountId: string }): Promise<YunxinSupportTeamLookup>;
};

export type YunxinCreateAccountInput = {
  accountId: string;
  token?: string;
  name?: string;
  avatar?: string;
  sign?: string;
  email?: string;
  birthday?: string;
  mobile?: string;
  gender?: number;
  extension?: string;
};

export type YunxinServerApiOptions = {
  appKey: string;
  appSecret: string;
  /** Legacy alias for the V1 endpoint; V2 always uses its versioned endpoint. */
  endpoint?: string;
  v1Endpoint?: string;
  v2Endpoint?: string;
  fetch?: FetchLike;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
};

export type YunxinDynamicTokenInput = {
  appKey: string;
  appSecret: string;
  accountId: string;
  ttlSeconds?: number;
  now?: () => number;
};

export type YunxinDynamicToken = {
  token: string;
  issuedAt: number;
  expiresAt: number;
  ttlSeconds: number;
};

export class YunxinApiError extends Error {
  constructor(
    readonly operation: string,
    readonly providerCode: number | null,
    readonly retryable: boolean,
  ) {
    super(`Yunxin ${operation} failed`);
    this.name = "YunxinApiError";
  }
}

export class YunxinTransportError extends Error {
  constructor(readonly operation: string) {
    super(`Yunxin ${operation} could not be reached`);
    this.name = "YunxinTransportError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function field(record: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function normalizeEndpoint(value: string | undefined, fallback: string, allowed: Set<string>): string {
  const raw = (value ?? fallback).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Yunxin endpoint is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    !allowed.has(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Yunxin endpoint is not allowlisted");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeAccountId(value: string): string {
  const accountId = value.trim();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Yunxin account ID is invalid");
  return accountId;
}

function normalizeAccountIds(values: string[]): string[] {
  const accountIds = [...new Set(values.map(normalizeAccountId))];
  if (accountIds.length === 0 || accountIds.length > 100) {
    throw new Error("Yunxin account ID batch size is invalid");
  }
  return accountIds;
}

function normalizeTeamId(value: string): string {
  const teamId = String(value).trim();
  if (!TEAM_ID_PATTERN.test(teamId)) throw new Error("Yunxin team ID is invalid");
  return teamId;
}

function teamIdFromUnknown(value: unknown): string | undefined {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : asString(value);
  if (!candidate) return undefined;
  try { return normalizeTeamId(candidate); } catch { return undefined; }
}

function teamIdBodyValue(teamId: string): number | string {
  const numeric = Number(teamId);
  return Number.isSafeInteger(numeric) ? numeric : teamId;
}

function appendText(body: URLSearchParams, key: string, value: string | undefined, maxLength = 128): void {
  if (value === undefined) return;
  if (value.length > maxLength || CONTROL_PATTERN.test(value)) throw new Error("Yunxin profile field is invalid");
  body.set(key, value);
}

function appendProfile(body: URLSearchParams, input: YunxinCreateAccountInput | YunxinProfilePatch): void {
  appendText(body, "name", input.name, 128);
  appendText(body, "icon", input.avatar, 512);
  appendText(body, "sign", input.sign, 256);
  appendText(body, "email", input.email, 256);
  appendText(body, "birth", input.birthday, 32);
  appendText(body, "mobile", input.mobile, 32);
  appendText(body, "ex", input.extension, 4096);
  if (input.gender !== undefined) {
    if (!Number.isInteger(input.gender) || input.gender < 0 || input.gender > 2) {
      throw new Error("Yunxin gender is invalid");
    }
    body.set("gender", String(input.gender));
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function responseData(body: unknown): JsonRecord {
  if (!isRecord(body) || !isRecord(body.data)) throw new YunxinApiError("response", null, false);
  return body.data;
}

function responseBody(body: unknown): JsonRecord {
  if (!isRecord(body)) throw new YunxinApiError("response", null, false);
  return body;
}

function teamNotFound(providerCode: number | null): boolean {
  return providerCode === 108404 || providerCode === 109404;
}

function teamServerExtension(value: JsonRecord): string | null {
  // V1 exposes `custom` and `clientCustom` as distinct wire fields. The
  // confirmed App returned this support marker in `clientCustom`; keep the
  // field aliases for wire compatibility, but reject conflicting values
  // instead of treating clientCustom as a server-private field.
  const fields = ["custom", "clientCustom", "server_extension", "serverExtension"];
  const values: string[] = [];
  for (const name of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === null || value[name] === undefined) continue;
    if (typeof value[name] !== "string") throw new YunxinApiError("team-response", null, false);
    values.push(value[name]);
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) throw new YunxinApiError("team-response", null, false);
  return distinct[0] ?? null;
}

function teamSummary(value: unknown): { teamId: string; ownerAccountId: string; serverExtension: string | null } {
  if (!isRecord(value)) throw new YunxinApiError("team-response", null, false);
  const teamId = teamIdFromUnknown(field(value, "tid", "team_id", "teamId"));
  const owner = asString(field(value, "owner", "owner_account_id", "ownerAccountId"));
  if (!teamId || !owner) throw new YunxinApiError("team-response", null, false);
  return { teamId, ownerAccountId: normalizeAccountId(owner), serverExtension: teamServerExtension(value) };
}

function supportTeamState(value: unknown): YunxinSupportTeamState {
  if (!isRecord(value)) throw new YunxinApiError("team-response", null, false);
  const summary = teamSummary(value);
  const members = parseMaybeJson(field(value, "members", "member_list", "memberList"));
  if (!Array.isArray(members)) throw new YunxinApiError("team-response", null, false);
  const memberAccountIds = members.map((member) => {
    if (typeof member !== "string") throw new YunxinApiError("team-response", null, false);
    return normalizeAccountId(member);
  });
  if (new Set(memberAccountIds).size !== memberAccountIds.length) {
    throw new YunxinApiError("team-response", null, false);
  }
  // V1 query.action returns invited members while the owner is implicit.
  if (!memberAccountIds.includes(summary.ownerAccountId)) memberAccountIds.unshift(summary.ownerAccountId);
  return { ...summary, memberAccountIds };
}

function supportMarkerMatches(extension: string | null, appId: string, consultationId: string): boolean | null {
  if (extension === null) return null;
  const marker = parseMaybeJson(extension);
  if (!isRecord(marker)) return false;
  return marker.schema === "zzsh.im-consultation.v1" && marker.appId === appId && marker.consultationId === consultationId;
}

function responseInfo(body: unknown): JsonRecord {
  if (!isRecord(body)) throw new YunxinApiError("response", null, false);
  const info = parseMaybeJson(body.info);
  if (!isRecord(info)) throw new YunxinApiError("response", null, false);
  return info;
}

function assertReturnedAccount(expected: string, actual: string, operation: string): void {
  if (expected !== actual) throw new YunxinApiError(operation, null, false);
}

function assertBatchCoverage(expected: string[], actual: string[], operation: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    actual.length !== expected.length ||
    actualSet.size !== actual.length ||
    actual.some((accountId) => !expectedSet.has(accountId)) ||
    expected.some((accountId) => !actualSet.has(accountId))
  ) {
    throw new YunxinApiError(operation, null, false);
  }
}

function profileFrom(source: unknown, fallbackAccountId?: string): YunxinProfile {
  if (!isRecord(source)) throw new YunxinApiError("response", null, false);
  const accountId = asString(field(source, "account_id", "accid")) ?? fallbackAccountId;
  if (!accountId) throw new YunxinApiError("response", null, false);
  const profile: YunxinProfile = { accountId: normalizeAccountId(accountId) };
  const textFields: Array<[Exclude<keyof YunxinProfile, "accountId" | "gender">, string[]]> = [
    ["name", ["name"]],
    ["avatar", ["avatar", "icon"]],
    ["sign", ["sign"]],
    ["email", ["email"]],
    ["birthday", ["birthday", "birth"]],
    ["mobile", ["mobile"]],
    ["extension", ["extension", "ex"]],
  ];
  for (const [key, names] of textFields) {
    const text = asString(field(source, ...names));
    if (text !== undefined) profile[key] = text;
  }
  const gender = asNumber(field(source, "gender"));
  if (gender !== undefined) profile.gender = gender;
  return profile;
}

function accountStateFrom(value: unknown, fallbackAccountId?: string): YunxinAccountState {
  if (!isRecord(value)) throw new YunxinApiError("response", null, false);
  const configuration = isRecord(field(value, "configuration")) ? field(value, "configuration") as JsonRecord : value;
  const accountId = asString(field(value, "account_id", "accid")) ?? fallbackAccountId;
  const enabled = asBoolean(field(configuration, "enabled"));
  if (!accountId || enabled === undefined) throw new YunxinApiError("response", null, false);
  return {
    accountId: normalizeAccountId(accountId),
    enabled,
    p2pChatBanned: asBoolean(field(configuration, "p2p_chat_banned", "p2pChatBanned")) ?? null,
    teamChatBanned: asBoolean(field(configuration, "team_chat_banned", "teamChatBanned")) ?? null,
    chatroomChatBanned: asBoolean(field(configuration, "chatroom_chat_banned", "chatroomChatBanned")) ?? null,
    qchatChatBanned: asBoolean(field(configuration, "qchat_chat_banned", "qchatChatBanned")) ?? null,
  };
}

function onlineStatusFrom(value: unknown, fallbackAccountId?: string): YunxinOnlineStatus {
  if (!isRecord(value)) throw new YunxinApiError("response", null, false);
  const accountId = asString(field(value, "account_id", "accid")) ?? fallbackAccountId;
  if (!accountId) throw new YunxinApiError("response", null, false);
  const rawSessions = field(value, "online_status", "onlineStatus");
  if (!Array.isArray(rawSessions)) throw new YunxinApiError("response", null, false);
  const sessions = rawSessions.map((session): YunxinOnlineSession => {
    if (!isRecord(session)) throw new YunxinApiError("response", null, false);
    const clientType = asNumber(field(session, "client_type", "clientType"));
    const loginTime = asNumber(field(session, "login_time", "loginTime"));
    if (clientType === undefined || loginTime === undefined) throw new YunxinApiError("response", null, false);
    return { clientType, loginTime };
  });
  return { accountId: normalizeAccountId(accountId), online: sessions.length > 0, sessions };
}

function failureFrom(value: unknown): YunxinAccountLookupFailure {
  if (!isRecord(value)) throw new YunxinApiError("response", null, false);
  const accountId = asString(field(value, "account_id", "accid"));
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) throw new YunxinApiError("response", null, false);
  return { accountId, providerCode: asNumber(field(value, "code", "error_code")) ?? null };
}

function assertCredential(value: string, label: string): void {
  if (!value.trim() || CONTROL_PATTERN.test(value)) throw new Error(`Yunxin ${label} is invalid`);
}

/** Generate the short-lived IM dynamic token on the server; never expose AppSecret. */
export function createYunxinDynamicToken(input: YunxinDynamicTokenInput): YunxinDynamicToken {
  assertCredential(input.appKey, "app key");
  assertCredential(input.appSecret, "app secret");
  const accountId = normalizeAccountId(input.accountId);
  const ttlSeconds = input.ttlSeconds ?? 600;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
    throw new Error("Yunxin dynamic token TTL is invalid");
  }
  const issuedAt = input.now ? input.now() : Date.now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("Yunxin dynamic token clock is invalid");
  const ttlMs = ttlSeconds * 1_000;
  if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error("Yunxin dynamic token clock is invalid");
  const signature = createHash("sha1")
    .update(`${input.appKey}${accountId}${issuedAt}${ttlSeconds}${input.appSecret}`)
    .digest("hex");
  const payload = JSON.stringify({ signature, curTime: issuedAt, ttl: ttlSeconds });
  return {
    token: Buffer.from(payload, "utf8").toString("base64"),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1000,
    ttlSeconds,
  };
}

export class YunxinServerApiClient implements YunxinServerApi, YunxinSupportScopeApi {
  private readonly v1Endpoint: string;
  private readonly v2Endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly options: YunxinServerApiOptions) {
    assertCredential(options.appKey, "app key");
    assertCredential(options.appSecret, "app secret");
    this.v1Endpoint = normalizeEndpoint(options.v1Endpoint ?? options.endpoint, DEFAULT_V1_ENDPOINT, ALLOWED_V1_ENDPOINTS);
    this.v2Endpoint = normalizeEndpoint(options.v2Endpoint, DEFAULT_V2_ENDPOINT, ALLOWED_V2_ENDPOINTS);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.nonce = options.nonce ?? (() => randomBytes(18).toString("base64url"));
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("Yunxin timeout is invalid");
    }
  }

  async createAccount(input: YunxinCreateAccountInput): Promise<YunxinCreatedAccount> {
    const accountId = normalizeAccountId(input.accountId);
    const body = new URLSearchParams({ accid: accountId });
    appendText(body, "token", input.token, 128);
    appendProfile(body, input);
    const response = await this.request("create-account", "POST", "/nimserver/user/create.action", body);
    const info = responseInfo(response);
    const token = asString(field(info, "token"));
    if (!token) throw new YunxinApiError("create-account", null, false);
    const profile = profileFrom(info, accountId);
    assertReturnedAccount(accountId, profile.accountId, "create-account");
    return { accountId, token, profile };
  }

  async getProfile(accountId: string): Promise<YunxinProfile> {
    const normalized = normalizeAccountId(accountId);
    const response = await this.request("get-profile", "GET", `/im/v2/users/${encodeURIComponent(normalized)}`, undefined, "", "v2");
    const profile = profileFrom(responseData(response), normalized);
    assertReturnedAccount(normalized, profile.accountId, "get-profile");
    return profile;
  }

  async getProfiles(accountIds: string[]): Promise<{ profiles: YunxinProfile[]; failed: YunxinAccountLookupFailure[] }> {
    const normalized = normalizeAccountIds(accountIds);
    const query = new URLSearchParams({ account_ids: normalized.join(",") });
    const response = await this.request("get-profiles", "GET", `/im/v2/users?${query.toString()}`, undefined, "", "v2");
    const data = responseData(response);
    if (!Array.isArray(data.success_list) || !Array.isArray(data.failed_list)) {
      throw new YunxinApiError("get-profiles", null, false);
    }
    const profiles = data.success_list.map((value) => profileFrom(value));
    const failed = data.failed_list.map((value) => failureFrom(value));
    assertBatchCoverage(normalized, [...profiles.map((profile) => profile.accountId), ...failed.map((item) => item.accountId)], "get-profiles");
    return { profiles, failed };
  }

  async updateProfile(accountId: string, patch: YunxinProfilePatch): Promise<void> {
    const normalized = normalizeAccountId(accountId);
    const body = new URLSearchParams({ accid: normalized });
    appendProfile(body, patch);
    await this.request("update-profile", "POST", "/nimserver/user/updateUinfo.action", body);
  }

  async getAccount(accountId: string): Promise<YunxinAccountState> {
    const normalized = normalizeAccountId(accountId);
    const response = await this.request("get-account", "GET", `/im/v2/accounts/${encodeURIComponent(normalized)}`, undefined, "", "v2");
    const state = accountStateFrom(responseData(response), normalized);
    assertReturnedAccount(normalized, state.accountId, "get-account");
    return state;
  }

  async setAccountEnabled(accountId: string, enabled: boolean, needKick = false): Promise<YunxinAccountState> {
    const normalized = normalizeAccountId(accountId);
    const response = await this.request("set-account-enabled", "PATCH", `/im/v2/accounts/${encodeURIComponent(normalized)}`, {
      configuration: { enabled },
      ...(needKick ? { need_kick: true } : {}),
    }, "", "v2");
    const state = accountStateFrom(responseData(response), normalized);
    assertReturnedAccount(normalized, state.accountId, "set-account-enabled");
    return state;
  }

  async refreshAccountToken(accountId: string): Promise<{ accountId: string; token: string }> {
    const normalized = normalizeAccountId(accountId);
    const response = await this.request("refresh-token", "PATCH", `/im/v2/accounts/${encodeURIComponent(normalized)}`, undefined, "/actions/refresh_token", "v2");
    const data = responseData(response);
    const returnedAccountId = asString(field(data, "account_id", "accid"));
    if (returnedAccountId !== undefined) assertReturnedAccount(normalized, normalizeAccountId(returnedAccountId), "refresh-token");
    const token = asString(field(data, "token"));
    if (!token) throw new YunxinApiError("refresh-token", null, false);
    return { accountId: normalized, token };
  }

  async getOnlineStatuses(accountIds: string[]): Promise<{ statuses: YunxinOnlineStatus[]; failed: YunxinAccountLookupFailure[] }> {
    const normalized = normalizeAccountIds(accountIds);
    const response = await this.request("get-online-status", "POST", "/im/v2/users/actions/online_status", {
      account_ids: normalized,
    }, "", "v2");
    const data = responseData(response);
    if (!Array.isArray(data.success_list) || !Array.isArray(data.failed_list)) {
      throw new YunxinApiError("get-online-status", null, false);
    }
    const statuses = data.success_list.map((value) => onlineStatusFrom(value));
    const failed = data.failed_list.map((value) => failureFrom(value));
    assertBatchCoverage(normalized, [...statuses.map((status) => status.accountId), ...failed.map((item) => item.accountId)], "get-online-status");
    return { statuses, failed };
  }

  async createSupportTeam(input: YunxinSupportTeamCreateInput): Promise<{ teamId: string }> {
    const ownerAccountId = normalizeAccountId(input.ownerAccountId);
    const memberAccountIds = input.memberAccountIds.map(normalizeAccountId);
    if (memberAccountIds.length === 0 || memberAccountIds.length > 10 || new Set(memberAccountIds).size !== memberAccountIds.length || memberAccountIds.includes(ownerAccountId)) {
      throw new Error("Yunxin support team members are invalid");
    }
    const appId = input.appId.trim();
    const consultationId = input.consultationId.trim();
    if (!appId || appId.length > 128 || CONTROL_PATTERN.test(appId) || !consultationId || consultationId.length > 128 || CONTROL_PATTERN.test(consultationId)) {
      throw new Error("Yunxin support scope metadata is invalid");
    }
    const serverExtension = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId, consultationId });
    if (serverExtension.length > 1024) throw new Error("Yunxin support scope metadata is too large");
    const response = await this.request("create-support-team", "POST", "/im/v2.1/teams", {
      owner_account_id: ownerAccountId,
      team_type: 1,
      name: `洲洲商行客服咨询-${consultationId.slice(-24)}`.slice(0, 64),
      // The owner is server-only; retain one spare slot so a transfer can add
      // the new operator before removing the old one.
      members_limit: memberAccountIds.length + 2,
      server_extension: serverExtension,
      invite_account_ids: memberAccountIds,
      invite_msg: "洲洲商行客服咨询邀请",
      extension: JSON.stringify({ consultationId }),
      configuration: {
        join_mode: 2,
        agree_mode: 1,
        invite_mode: 0,
        update_team_info_mode: 0,
        update_extension_mode: 0,
      },
    }, "", "v2");
    const data = responseData(response);
    const failed = field(data, "failed_list");
    if (Array.isArray(failed) && failed.length > 0) throw new YunxinApiError("create-support-team", null, false);
    if (!isRecord(data.team_info)) throw new YunxinApiError("create-support-team", null, false);
    const teamId = teamIdFromUnknown(field(data.team_info, "team_id", "teamId"));
    const returnedOwner = asString(field(data.team_info, "owner_account_id", "ownerAccountId"));
    if (!teamId || !returnedOwner || normalizeAccountId(returnedOwner) !== ownerAccountId) {
      throw new YunxinApiError("create-support-team", null, false);
    }
    return { teamId };
  }

  async addSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const normalizedTeamId = normalizeTeamId(teamId);
    const operator = normalizeAccountId(operatorAccountId);
    const member = normalizeAccountId(memberAccountId);
    const response = await this.request("add-support-team-member", "POST", "/im/v2/team_members", {
      operator_id: operator,
      team_id: teamIdBodyValue(normalizedTeamId),
      team_type: 1,
      invite_account_ids: [member],
      msg: "洲洲商行客服咨询转交",
    }, "", "v2");
    const data = responseData(response);
    const failed = field(data, "failed_list");
    if (Array.isArray(failed) && failed.length > 0) throw new YunxinApiError("add-support-team-member", null, false);
  }

  async removeSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const normalizedTeamId = normalizeTeamId(teamId);
    const query = new URLSearchParams({
      operator_id: normalizeAccountId(operatorAccountId),
      team_id: String(teamIdBodyValue(normalizedTeamId)),
      team_type: "1",
      kick_account_ids: normalizeAccountId(memberAccountId),
    });
    const response = await this.request("remove-support-team-member", "DELETE", `/im/v2/team_members/actions/kick_member?${query.toString()}`, undefined, "", "v2");
    responseData(response);
  }

  async dismissSupportTeam(teamId: string, ownerAccountId: string): Promise<void> {
    const normalizedTeamId = normalizeTeamId(teamId);
    const owner = normalizeAccountId(ownerAccountId);
    const query = new URLSearchParams({ team_type: "1", operator_id: owner });
    const response = await this.request("dismiss-support-team", "DELETE", `/im/v2.1/teams/${encodeURIComponent(normalizedTeamId)}?${query.toString()}`, undefined, "", "v2");
    responseData(response);
  }

  async getSupportTeam(teamId: string): Promise<YunxinSupportTeamState | null> {
    const normalizedTeamId = normalizeTeamId(teamId);
    const body = new URLSearchParams({ tids: JSON.stringify([normalizedTeamId]), ope: "1" });
    try {
      const response = await this.request("get-support-team", "POST", "/nimserver/team/query.action", body);
      const payload = responseBody(response);
      const teams = field(payload, "tinfos", "team_infos", "teamInfos");
      if (!Array.isArray(teams)) throw new YunxinApiError("get-support-team", null, false);
      if (teams.length === 0) return null;
      const summaries = teams.map((value) => teamSummary(value));
      if (summaries.length !== 1 || summaries[0]!.teamId !== normalizedTeamId) {
        throw new YunxinApiError("get-support-team", null, false);
      }
      return supportTeamState(teams[0]!);
    } catch (error) {
      if (error instanceof YunxinApiError && teamNotFound(error.providerCode)) return null;
      throw error;
    }
  }

  async findSupportTeam(input: { appId: string; consultationId: string; ownerAccountId: string }): Promise<YunxinSupportTeamLookup> {
    const ownerAccountId = normalizeAccountId(input.ownerAccountId);
    const appId = input.appId.trim();
    const consultationId = input.consultationId.trim();
    if (!appId || appId.length > 128 || CONTROL_PATTERN.test(appId) || !consultationId || consultationId.length > 128 || CONTROL_PATTERN.test(consultationId)) {
      throw new Error("Yunxin support scope metadata is invalid");
    }
    const body = new URLSearchParams({ accid: ownerAccountId });
    const response = await this.request("find-support-team", "POST", "/nimserver/team/joinTeams.action", body);
    const payload = responseBody(response);
    const teamsValue = payload.infos;
    const count = asNumber(payload.count);
    if (count === undefined || !Number.isInteger(count) || count < 0) {
      throw new YunxinApiError("find-support-team", null, false);
    }
    if (count === 0 && teamsValue === undefined) return { status: "ABSENT" };
    if (!Array.isArray(teamsValue) || count !== teamsValue.length) {
      throw new YunxinApiError("find-support-team", null, false);
    }
    const teams = teamsValue;
    if (teams.length === 0) return { status: "ABSENT" };
    const matches: string[] = [];
    let unidentifiable = false;
    for (const value of teams) {
      const summary = teamSummary(value);
      if (summary.ownerAccountId !== ownerAccountId) continue;
      const matchesMarker = supportMarkerMatches(summary.serverExtension, appId, consultationId);
      if (matchesMarker === null) unidentifiable = true;
      else if (matchesMarker) matches.push(summary.teamId);
    }
    if (matches.length > 1 || unidentifiable) return { status: "AMBIGUOUS" };
    if (matches.length === 0) return { status: "ABSENT" };
    const team = await this.getSupportTeam(matches[0]!);
    if (!team) return { status: "ABSENT" };
    if (team.ownerAccountId !== ownerAccountId || supportMarkerMatches(team.serverExtension, appId, consultationId) !== true) {
      return { status: "AMBIGUOUS" };
    }
    return { status: "FOUND", team };
  }

  private async request(
    operation: string,
    method: string,
    path: string,
    body?: URLSearchParams | JsonRecord,
    suffix = "",
    version: "v1" | "v2" = "v1",
  ): Promise<unknown> {
    const nonce = this.nonce();
    const curTime = String(Math.floor(this.now() / 1000));
    const checkSum = createHash("sha1").update(`${this.options.appSecret}${nonce}${curTime}`).digest("hex");
    const headers: Record<string, string> = {
      Accept: "application/json",
      AppKey: this.options.appKey,
      Nonce: nonce,
      CurTime: curTime,
      CheckSum: checkSum,
    };
    let requestBody: string | undefined;
    if (body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      requestBody = body.toString();
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    let response: Response;
    try {
      const endpoint = version === "v2" ? this.v2Endpoint : this.v1Endpoint;
      response = await this.fetchImpl(`${endpoint}${path}${suffix}`, {
        method,
        headers,
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new YunxinTransportError(operation);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new YunxinApiError(operation, null, response.status >= 500 || response.status === 429);
    }
    if (!isRecord(payload)) throw new YunxinApiError(operation, null, response.status >= 500 || response.status === 429);
    const providerCode = asNumber(payload.code);
    if (providerCode === undefined) throw new YunxinApiError(operation, null, response.status >= 500 || response.status === 429);
    if (!response.ok || providerCode !== 200) {
      throw new YunxinApiError(
        operation,
        providerCode,
        response.status >= 500 || response.status === 429 || providerCode === 102449,
      );
    }
    return payload;
  }
}
