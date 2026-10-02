import type { INestApplication } from "@nestjs/common";

import { ADMIN_PERMISSION, hasPermission, requirePermission } from "./admin-authorization";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { normalizeMainlandPhone } from "./phone-number";
import { sanitizeDetail } from "./admin-audit";
import { withTransaction } from "./security-core";
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
  type UserDirectoryStatusFilter,
  type UserDirectorySource,
} from "./user-directory";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const USERNAME_SEARCH_MAX = 200;
const LEGACY_ID_MAX = 128;

function parseLimit(raw: string | null): number {
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
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
      const allowed = new Set(["phone", "userId", "legacyId", "identifier", "q", "accountStatus", "source", "identityStatus", "ageStatus", "registeredFrom", "registeredTo", "limit", "cursor"]);
      for (const [key, value] of Object.entries(request.body)) {
        if (!allowed.has(key) || typeof value !== "string" || value.length > 2000) throw invalid("Lookup field is invalid");
        query.set(key, value);
      }
      if (!query.get("phone")) throw invalid("Phone is required");
    }
    const context = await readAdminContext(request, options);
    await withTransaction(options.pool, async (client) => {
      await assertAdminContextInTransaction(client, context);
      const access = await requireAdminAccess(client, context.userId);
      requirePermission(access, ADMIN_PERMISSION.userDirectoryRead);
      const gameScope = (await client.query<{ gameId: string }>(`SELECT game_id AS "gameId" FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 ORDER BY game_id`, [context.userId])).rows.map(row => row.gameId);
      const viewer = {
        adminId: context.userId,
        isBoss: access.isBoss,
        phoneLookup: hasPermission(access, ADMIN_PERMISSION.userPhoneLookup),
        resourceRead: hasPermission(access, ADMIN_PERMISSION.supplyRentalAccountRead),
        orderRead: hasPermission(access, ADMIN_PERMISSION.orderRead),
        auditRead: hasPermission(access, ADMIN_PERMISSION.auditRead),
        authorizationKey: sha256Hex(JSON.stringify([context.userId, context.sessionId, access.isBoss, [...access.permissions].sort(), gameScope])),
        legacyRead: false,
      };
      const enableLegacyRead=async()=>{viewer.legacyRead=(await client.query("SELECT to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS present")).rows[0]?.present===true;};
      const cursor = query.get("cursor") ?? undefined;
      if(resourceMatch){requirePermission(access,ADMIN_PERMISSION.userDirectoryRead);requirePermission(access,ADMIN_PERMISSION.supplyRentalAccountRead);sendJson(response,200,await readDirectoryRentalAccount(client,viewer,decodeId(resourceMatch[1]!)),requestId);return;}
      const limit = parseLimit(query.get("limit"));

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
        if (query.has("sort") && query.get("sort") !== "created") throw invalid("Activity sorting is not connected");
        const accountStatusFilter = parseAccountStatus(query.get("accountStatus"));
        const sourceFilter = parseSource(query.get("source"));
        const registeredFrom = parseTimestamp(query.get("registeredFrom"), "Registered from");
        const registeredTo = parseTimestamp(query.get("registeredTo"), "Registered to");
        if (registeredFrom && registeredTo && Date.parse(registeredFrom) > Date.parse(registeredTo)) throw invalid("Registered range is reversed");
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
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        sendJson(response, 200, data, requestId);
        return;
      }

      const userId = decodeId(detailMatch![1]!);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) throw invalid("User id is invalid");
      const section = detailMatch![3];
      if (section === undefined) {
        requirePermission(access, ADMIN_PERMISSION.userDirectoryRead);
        await enableLegacyRead();
        const detail = await readUserDirectoryDetail(client, viewer, userId);
        if (!detail) throw notFound();
        sendJson(response, 200, { user: detail }, requestId);
        return;
      }
      if (section === "rental-accounts") requirePermission(access, ADMIN_PERMISSION.supplyRentalAccountRead);
      else if (section === "orders") requirePermission(access, ADMIN_PERMISSION.orderRead);
      else requirePermission(access, ADMIN_PERMISSION.auditRead);
      if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id = $1`, [userId])).rowCount) throw notFound();
      if (section === "rental-accounts") {
        requirePermission(access, ADMIN_PERMISSION.supplyRentalAccountRead);
        await enableLegacyRead();
        sendJson(response, 200, await listUserRentalAccounts(client, viewer, userId, { limit, ...(cursor !== undefined ? { cursor } : {}) }), requestId);
        return;
      }
      if (section === "orders") {
        requirePermission(access, ADMIN_PERMISSION.orderRead);
        const roleRaw = query.get("role");
        if (roleRaw !== null && roleRaw !== "renter" && roleRaw !== "owner" && roleRaw !== "any") throw invalid("Role is invalid");
        const statusRaw = query.get("status");
        if (statusRaw !== null && !["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"].includes(statusRaw)) throw invalid("Status is invalid");
        await enableLegacyRead();
        sendJson(response, 200, await listUserOrders(client, viewer, userId, {
          ...(roleRaw !== null ? { role: roleRaw as "renter" | "owner" | "any" } : {}),
          ...(statusRaw !== null ? { status: statusRaw as "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        }), requestId);
        return;
      }
      requirePermission(access, ADMIN_PERMISSION.auditRead);
      sendJson(response, 200, await listUserAuditEvents(client, viewer, userId, { limit, ...(cursor !== undefined ? { cursor } : {}) }, sanitizeDetail), requestId);
    });
  });
}

export function mountUserDirectory(app: INestApplication, options: AuthSecurityOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/admin/users", (request, response, next) => handleUserDirectoryAdmin(request, response, options, next));
}
