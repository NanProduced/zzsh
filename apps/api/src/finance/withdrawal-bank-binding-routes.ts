import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { readWithdrawalBankBinding, recoverWithdrawalBankBinding, saveWithdrawalBankBinding, type WithdrawalBankBindingOptions } from "./withdrawal-bank-binding";

export function mountWithdrawalBankBinding(app: INestApplication, options: AuthSecurityOptions & { withdrawalBankBinding?: WithdrawalBankBindingOptions }) {
  for (const prefix of ["/api/v1/users/me/withdrawal-bank-binding", "/api/bff/user/withdrawal-bank-binding"]) {
    app.getHttpAdapter().getInstance().use(prefix, (request: SupplyNodeRequest, response: SupplyResponse) => {
      const requestId = ensureApiV1RequestId(request);
      return safely(response, requestId, async () => {
        const { path, query } = requestPath(request, prefix), method = (request.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "POST" || !["/", "/receipt"].includes(path) || method === "POST" && path !== "/") throw notFound();
        if (!requireOrigin(request, response, { ...options, adminOrigin: options.userOrigin }, requestId)) return;
        const actor = { ...await readUserContext(request, options), requestId }, binding = options.withdrawalBankBinding;
        const key = method === "POST" ? validateIdempotencyKey(request.headers["idempotency-key"]) : undefined;
        if (!binding) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Bank binding is not integrated");
        if (path === "/receipt") {
          if (query.size !== 1 || query.getAll("key").length !== 1) throw invalid("One original request key required");
          sendJson(response, 200, await withTransaction(options.pool, c => recoverWithdrawalBankBinding(c, actor, query.get("key"), binding)), requestId); return;
        }
        if (query.size) throw invalid("Unexpected bank binding query");
        if (method === "GET") sendJson(response, 200, await withTransaction(options.pool, c => readWithdrawalBankBinding(c, actor, binding)), requestId);
        else { const result = await saveWithdrawalBankBinding(options.pool, actor, bodyOf(request), key, binding); sendJson(response, result.status, result.body, requestId); }
      });
    });
  }
}
