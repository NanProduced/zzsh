import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { decodeId, requestPath, requireOrigin, safely, type SupplyResponse } from "../supply/supply-routes";
import type { ListingCursorKey } from "../supply/listing-cursor";
import type { NativeWithdrawalScope } from "./native-withdrawal-resource";
import { parseWithdrawalHistoryQuery, readPersonalWithdrawalHistory, recoverJoinpayWithdrawalFromHistory } from "./personal-withdrawal-history";

export function mountPersonalWithdrawalHistory(app: INestApplication, options: AuthSecurityOptions & { listingCursorKey?: ListingCursorKey; nativeWithdrawalScope?: NativeWithdrawalScope }) {
  for (const prefix of ["/api/v1/users/me/withdrawal-history", "/api/bff/user/withdrawal-history"]) app.getHttpAdapter().getInstance().use(prefix, (request: SupplyNodeRequest, response: SupplyResponse) => {
    const requestId = ensureApiV1RequestId(request);
    return safely(response, requestId, async () => {
      if ((request.method ?? "GET").toUpperCase() !== "GET") throw notFound();
      if (!requireOrigin(request, response, { ...options, adminOrigin: options.userOrigin }, requestId)) return;
      const actor = { ...await readUserContext(request, options), requestId }, { path, query } = requestPath(request, prefix);
      if (path === "/receipt") {
        if (query.size !== 1 || query.getAll("key").length !== 1) throw invalid("One original withdrawal key required");
        sendJson(response, 200, await recoverJoinpayWithdrawalFromHistory(options.pool, actor, query.get("key")), requestId); return;
      }
      const detail = path === "/" ? undefined : decodeId(path.slice(1));
      if (detail !== undefined && query.size) throw invalid("Unexpected withdrawal detail filter");
      const input = parseWithdrawalHistoryQuery(query);
      sendJson(response, 200, await readPersonalWithdrawalHistory(options.pool, actor, input, options.listingCursorKey, options.nativeWithdrawalScope, detail), requestId);
    });
  });
}
