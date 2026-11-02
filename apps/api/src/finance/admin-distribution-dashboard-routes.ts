import { Logger, type INestApplication } from "@nestjs/common";
import { readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import type { ListingCursorKey } from "../supply/listing-cursor";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requestPath, requireOrigin, safely, type SupplyResponse } from "../supply/supply-routes";
import {
  authorizeDistributionDashboard,
  parseDashboardFilters,
  readAdminDistributionEarnings,
  readAdminDistributionOverview,
  readAdminDistributionParticipant,
  readAdminDistributionParticipants,
} from "./admin-distribution-dashboard";

function dashboardPath(path: string) {
  return /^\/(overview|earnings|participants(?:\/[A-Za-z0-9._:-]+)?)$/.exec(path);
}

export async function handleAdminDistributionDashboard(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions & { listingCursorKey?: ListingCursorKey }): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    const { path, query } = requestPath(request, "/api/v1/admin/distribution");
    if ((request.method ?? "GET") !== "GET") throw notFound();
    const match = dashboardPath(path);
    if (!match) throw notFound();
    if (!requireOrigin(request, response, options, requestId)) return;
    const filters = parseDashboardFilters(query, new Date());
    const token = query.get("snapshot");
    if (filters.page > 1 && !token) throw invalid("Distribution snapshot is required");
    const actor = await readAdminContext(request, options);
    const result = await withTransaction(options.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Bounded page reads share the API pool; parallel hashes multiply each request's shared-memory peak.
      await client.query("SELECT set_config('statement_timeout','3s',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
      const context = await authorizeDistributionDashboard(client, actor);
      const body = await (match[1] === "overview" ? readAdminDistributionOverview(client, context, filters)
        : match[1] === "participants" ? readAdminDistributionParticipants(client, context, filters, options.listingCursorKey, token)
        : match[1]!.startsWith("participants/") ? readAdminDistributionParticipant(client, context, decodeURIComponent(match[1]!.slice("participants/".length)))
        : readAdminDistributionEarnings(client, context, filters, options.listingCursorKey, undefined, token));
      return { body, authorizationKey: context.authorizationKey };
    }).catch(error => {
      if (!(error instanceof SecurityApiError)) {
        const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "UNKNOWN";
        try { Logger.warn({ event: "distribution.dashboard.read_failed", requestId, code }, "Distribution"); } catch {}
        if (["53100", "53200", "53300"].includes(code)) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Distribution read capacity unavailable; retry later");
        if (code === "57014") throw new SecurityApiError(504, "EVIDENCE_UNAVAILABLE", "Distribution read budget exceeded");
      }
      throw error;
    });
    const current = await withTransaction(options.pool, async client => {
      await client.query("SET TRANSACTION READ ONLY");
      return authorizeDistributionDashboard(client, actor);
    });
    if (current.authorizationKey !== result.authorizationKey) throw forbidden("Distribution access changed; reload");
    sendJson(response, 200, result.body, requestId, "private, no-store");
  });
}

export function mountAdminDistributionDashboardRoutes(app: INestApplication, options: AuthSecurityOptions & { listingCursorKey?: ListingCursorKey }) {
  app.getHttpAdapter().getInstance().use("/api/v1/admin/distribution", (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => {
    const { path } = requestPath(request, "/api/v1/admin/distribution");
    if (!dashboardPath(path)) return next();
    return handleAdminDistributionDashboard(request, response, options);
  });
}
