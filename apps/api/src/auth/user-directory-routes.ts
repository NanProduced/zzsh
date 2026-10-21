import type { INestApplication } from "@nestjs/common";

import { ADMIN_PERMISSION, hasPermission, requirePermission } from "./admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, readAdminGameScope, scopeIsEmpty } from "./admin-scope";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { normalizeMainlandPhone } from "./phone-number";
import { sanitizeDetail } from "./admin-audit";
import { withDirectoryRead, withDirectoryReadTransaction } from "./user-directory-read";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { decodeId, requireAdminAccess, safely, type SupplyResponse } from "../supply/supply-routes";
import { invalid, notFound, forbidden, sendJson, sha256Hex, type SupplyNodeRequest } from "../supply/supply-util";
import {
  listUserAuditEvents,
  listUserDirectory,
  listUserOrders,
  listUserRentalAccounts,
  readUserDirectoryDetail,
  readDirectoryRentalAccount,
  USER_DIRECTORY_SOURCE,
  USER_DIRECTORY_STATUS_FILTER,
  USER_DIRECTORY_MAX_PAGE,
  type UserDirectoryStatusFilter,
  type UserDirectorySource,
} from "./user-directory";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const USERNAME_SEARCH_MAX = 200;
const LEGACY_ID_MAX = 128;
const PAGINATION_KEYS = new Set(["page", "pageSize", "contextKey", "limit", "cursor"]);
const REGISTRATION_KEYS = new Set(["registrationTime", "registeredFrom", "registeredTo", "registeredBefore", "sort"]);
const DIRECTORY_QUERY_KEYS = new Set(["phone", "userId", "legacyId", "identifier", "q", "accountStatus", "source", "identityStatus", "ageStatus", "registrationTime", "registeredFrom", "registeredTo", "registeredBefore", "sort", "page", "pageSize", "contextKey"]);

function parseLimit(raw: string | null): number {
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

function parseDirectoryPage(query: URLSearchParams, collection: boolean) {
  for (const key of PAGINATION_KEYS) if (query.getAll(key).length > 1) throw invalid("Pagination argument is repeated", key);
  if (!["page", "pageSize", "contextKey"].some(key => query.has(key))) return undefined;
  if (!collection) throw invalid("Numbered pagination is only supported for the user list");
  if (query.has("limit") || query.has("cursor")) throw invalid("Page pagination cannot include limit or cursor");
  for (const key of query.keys()) if (!DIRECTORY_QUERY_KEYS.has(key)) throw invalid("Unsupported directory page argument", key);
  const positive = (key: string, fallback: number | undefined, max: number) => {
    const raw = query.get(key);
    if (raw === null && fallback !== undefined) return fallback;
    if (raw === null || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw invalid("Pagination argument is invalid", key);
    return Number(raw);
  };
  const contextKey = query.get("contextKey");
  if (contextKey !== null && !/^[0-9a-f]{64}$/.test(contextKey)) throw invalid("Page context is invalid", "contextKey");
  return { page: positive("page", undefined, USER_DIRECTORY_MAX_PAGE), pageSize: positive("pageSize", 20, 100), ...(contextKey !== null ? { contextKey } : {}) };
}

function parseTimestamp(raw: string | null, label: string): string | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`${label} is invalid`);
  const calendar = new Date(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0,10) !== value.slice(0,10)) throw invalid(`${label} is invalid`);
  return value;
}

function parseAccountStatus(raw: string | null): UserDirectoryStatusFilter | undefined {
  if (raw === null) return undefined;
  if ((USER_DIRECTORY_STATUS_FILTER as readonly string[]).includes(raw)) return raw as UserDirectoryStatusFilter;
  throw invalid("Account status is invalid");
}

function parseSource(raw: string | null): UserDirectorySource | undefined {
  if (raw === null) return undefined;
  if (raw === USER_DIRECTORY_SOURCE.LOCAL || raw === USER_DIRECTORY_SOURCE.MIGRATED || raw === USER_DIRECTORY_SOURCE.UNKNOWN) return raw;
  throw invalid("Source is invalid");
}

function parseTrimmed(raw: string | null, max: number, label: string): string | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > max) throw invalid(`${label} is invalid`);
  return value;
}

export async function handleUserDirectoryAdmin(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: AuthSecurityOptions,
  next?: () => void,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  const raw = request.originalUrl ?? request.url ?? "";
  const withoutQuery = raw.split("?", 1)[0] || "/";
  const prefix = "/api/v1/admin/users";
  const path = withoutQuery === prefix ? "/" : withoutQuery.startsWith(`${prefix}/`) ? withoutQuery.slice(prefix.length) : null;
  const method = (request.method ?? "GET").toUpperCase();
  const detailMatch = path === null ? null : /^\/([^/]+)(\/(rental-accounts|orders|audit-events))?$/.exec(path);
  const lookup = method === "POST" && path === "/lookup";
  const resourceMatch=path===null?null:/^\/resource-accounts\/([A-Za-z0-9._:-]+)$/.exec(path);
  const mine = lookup || method === "GET" && (resourceMatch!==null || path === "/" || path !== "/lookup" && detailMatch !== null);
  if (!mine) {
    if (next) {
      next();
      return;
    }
    await safely(response, requestId, async () => {
      throw notFound();
    });
    return;
  }
  await safely(response, requestId, async () => {
    const query = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "");
    if (query.has("phone")) throw invalid("Phone lookup must use a request body");
    if (lookup) {
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalid("Lookup body is invalid");
      const allowed = new Set([...DIRECTORY_QUERY_KEYS, "limit", "cursor"]);
      for (const [key, value] of Object.entries(request.body)) {
        if (!allowed.has(key) || typeof value !== "string" || value.length > 2000) throw invalid("Lookup field is invalid");
        if ((PAGINATION_KEYS.has(key) || REGISTRATION_KEYS.has(key)) && query.has(key)) throw invalid("Lookup argument is repeated", key);
        query.set(key, value);
      }
      if (!query.get("phone")) throw invalid("Phone is required");
    }
    for (const key of REGISTRATION_KEYS) if (query.getAll(key).length > 1) throw invalid("Registration argument is repeated", key);
    const registrationTime = query.get("registrationTime");
    if (registrationTime !== null && registrationTime !== "ORIGINAL") throw invalid("Registration time mode is invalid");
    await withDirectoryRead(options.pool, request, response, async (signal) => {
    const context = await readAdminContext(request, options);
    let dataToSend: unknown;
    // A preceding default directory read can make ORIGINAL exceed its SQL budget on the same backend.
    await withDirectoryReadTransaction(options.pool, signal, async (client) => {
      await assertAdminContextInTransaction(client, context);
      const access = await requireAdminAccess(client, context.userId);
      requirePermission(access, ADMIN_PERMISSION.userDirectoryRead);
      if (registrationTime === "ORIGINAL") await client.query("SELECT set_config('jit','off',true)");
      const gameScope = await readAdminGameScope(client, context.userId);
      const viewer = {
        adminId: context.userId,
        isBoss: access.isBoss,
        phoneLookup: hasPermission(access, ADMIN_PERMISSION.userPhoneLookup),
        resourceRead: hasPermission(access, ADMIN_PERMISSION.supplyRentalAccountRead),
        orderRead: hasPermission(access, ADMIN_PERMISSION.orderRead),
        auditRead: hasPermission(access, ADMIN_PERMISSION.auditRead),
        membershipSummaryRead: hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead),
        creditRead: hasPermission(access, ADMIN_PERMISSION.creditRead),
        businessScopeUsable: !scopeIsEmpty(gameScope, access.isBoss),
        authorizationKey: sha256Hex(JSON.stringify([context.userId, context.sessionId, access.isBoss, [...access.permissions].sort(), gameScopeSignature(gameScope)])),
        legacyRead: false,
      };
      const enableLegacyRead=async()=>{viewer.legacyRead=(await client.query("SELECT to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS present")).rows[0]?.present===true;};
      const cursor = query.get("cursor") ?? undefined;
      const pagination = parseDirectoryPage(query, path === "/" || lookup);
      if(resourceMatch){requirePermission(access,ADMIN_PERMISSION.userDirectoryRead);requirePermission(access,ADMIN_PERMISSION.supplyRentalAccountRead);assertGameScopeUsable(gameScope, access.isBoss);dataToSend = await readDirectoryRentalAccount(client,viewer,decodeId(resourceMatch[1]!));return;}
      const limit = pagination?.pageSize ?? parseLimit(query.get("limit"));

      if (path === "/" || lookup) {
        requirePermission(access, ADMIN_PERMISSION.userDirectoryRead);
        const userIdFilter = parseTrimmed(query.get("userId"), 128, "User id");
        const legacyIdFilter = parseTrimmed(query.get("legacyId"), LEGACY_ID_MAX, "Legacy id");
        const identifierFilter = parseTrimmed(query.get("identifier"), USERNAME_SEARCH_MAX, "Identifier");
        const search = parseTrimmed(query.get("q"), USERNAME_SEARCH_MAX, "Search");
        if ([identifierFilter, search].some(value => value && /(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/.test(value))) throw invalid("Phone lookup must use a request body");
        const identityStatus = parseTrimmed(query.get("identityStatus"), 16, "Identity status");
        if (identityStatus && !["UNKNOWN", "UNVERIFIED", "VERIFIED", "REJECTED"].includes(identityStatus)) throw invalid("Identity status is invalid");
        const ageStatus = parseTrimmed(query.get("ageStatus"), 16, "Age status");
        if (ageStatus && !["UNKNOWN", "ADULT", "MINOR"].includes(ageStatus)) throw invalid("Age status is invalid");
        const sort = query.get("sort");
        if (registrationTime === "ORIGINAL" ? sort !== null && sort !== "registered_desc" && sort !== "registered_asc" : sort !== null && sort !== "created") throw invalid("Registration sort is invalid");
        const accountStatusFilter = parseAccountStatus(query.get("accountStatus"));
        const sourceFilter = parseSource(query.get("source"));
        const registeredFrom = parseTimestamp(query.get("registeredFrom"), "Registered from");
        const registeredTo = parseTimestamp(query.get("registeredTo"), "Registered to");
        const registeredBefore = parseTimestamp(query.get("registeredBefore"), "Registered before");
        if (registeredFrom && registeredTo && Date.parse(registeredFrom) > Date.parse(registeredTo)) throw invalid("Registered range is reversed");
        if (registeredBefore && (registrationTime !== "ORIGINAL" || registeredTo || registeredFrom && Date.parse(registeredFrom) >= Date.parse(registeredBefore))) throw invalid("Registered before is incompatible or not after the lower bound");
        const phoneRaw = parseTrimmed(query.get("phone"), 32, "Phone");
        let phone: string | undefined;
        if (phoneRaw !== undefined) {
          if (!viewer.phoneLookup) throw forbidden("Phone search requires explicit permission");
          const normalized = normalizeMainlandPhone(phoneRaw);
          if (!normalized) throw invalid("Phone is invalid");
          phone = normalized;
        }
        await enableLegacyRead();
        const data = await listUserDirectory(client, viewer, {
          ...(userIdFilter !== undefined ? { userId: userIdFilter } : {}),
          ...(legacyIdFilter !== undefined ? { legacyId: legacyIdFilter } : {}),
          ...(identifierFilter !== undefined ? { identifier: identifierFilter } : {}),
          ...(search !== undefined ? { search } : {}),
          ...(identityStatus !== undefined ? { identityStatus } : {}),
          ...(ageStatus !== undefined ? { ageStatus } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(accountStatusFilter !== undefined ? { accountStatus: accountStatusFilter } : {}),
          ...(sourceFilter !== undefined ? { source: sourceFilter } : {}),
          ...(registeredFrom !== undefined ? { registeredFrom } : {}),
          ...(registeredTo !== undefined ? { registeredTo } : {}),
          ...(registrationTime !== null ? { registrationTime } : {}),
          ...(sort === "registered_desc" || sort === "registered_asc" ? { sort } : {}),
          ...(registeredBefore !== undefined ? { registeredBefore } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(pagination ? { page: pagination.page, ...(pagination.contextKey !== undefined ? { contextKey: pagination.contextKey } : {}) } : {}),
        });
        dataToSend = data;
        return;
      }

      const userId = decodeId(detailMatch![1]!);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) throw invalid("User id is invalid");
      const section = detailMatch![3];
      if (section === undefined) {
        requirePermission(access, ADMIN_PERMISSION.userDirectoryRead);
        await enableLegacyRead();
        const detail = await readUserDirectoryDetail(client, viewer, userId, registrationTime ?? undefined);
        if (!detail) throw notFound();
        dataToSend = { user: detail };
        return;
      }
      if (section === "rental-accounts") requirePermission(access, ADMIN_PERMISSION.supplyRentalAccountRead);
      else if (section === "orders") requirePermission(access, ADMIN_PERMISSION.orderRead);
      else requirePermission(access, ADMIN_PERMISSION.auditRead);
      if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id = $1`, [userId])).rowCount) throw notFound();
      if (section === "rental-accounts") {
        requirePermission(access, ADMIN_PERMISSION.supplyRentalAccountRead);
        assertGameScopeUsable(gameScope, access.isBoss);
        const publication = query.get("publication");
        if (publication !== null && publication !== "published") throw invalid("Publication filter is invalid");
        await enableLegacyRead();
        dataToSend = await listUserRentalAccounts(client, viewer, userId, { limit, ...(cursor !== undefined ? { cursor } : {}), ...(publication !== null ? { publication } : {}) });
        return;
      }
      if (section === "orders") {
        requirePermission(access, ADMIN_PERMISSION.orderRead);
        assertGameScopeUsable(gameScope, access.isBoss);
        const roleRaw = query.get("role");
        if (roleRaw !== null && roleRaw !== "renter" && roleRaw !== "owner" && roleRaw !== "any") throw invalid("Role is invalid");
        const statusRaw = query.get("status");
        if (statusRaw !== null && !["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED", "current"].includes(statusRaw)) throw invalid("Status is invalid");
        await enableLegacyRead();
        dataToSend = await listUserOrders(client, viewer, userId, {
          ...(roleRaw !== null ? { role: roleRaw as "renter" | "owner" | "any" } : {}),
          ...(statusRaw !== null ? { status: statusRaw as "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" | "current" } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return;
      }
      requirePermission(access, ADMIN_PERMISSION.auditRead);
      dataToSend = await listUserAuditEvents(client, viewer, userId, { limit, ...(cursor !== undefined ? { cursor } : {}) }, sanitizeDetail);
    }, true);
    signal.throwIfAborted();
    sendJson(response, 200, dataToSend, requestId);
    });
  });
}

export function mountUserDirectory(app: INestApplication, options: AuthSecurityOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/admin/users", (request, response, next) => handleUserDirectoryAdmin(request, response, options, next));
}
