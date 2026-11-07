import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { assertEcsTestDemoAssembly } from "../finance/ecs-test-demo-resource";
import { bodyOf, ensureOnlyFields, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { confirmEcsDemoCheckout, readEcsDemoCheckoutAvailability, readEcsDemoCheckoutReceipt, type EcsDemoCheckoutOptions } from "./ecs-demo-checkout-service";

/** Only a process with the explicit ECS test capability mounts these user routes. */
export function mountEcsDemoCheckoutRoutes(app: INestApplication, security: AuthSecurityOptions & { secureCookies: boolean }, options: EcsDemoCheckoutOptions) {
  assertEcsTestDemoAssembly(options.demo, security);
  for (const prefix of ["/api/v1/orders", "/api/bff/user/orders"]) app.getHttpAdapter().getInstance().use(prefix,
    (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => {
      const { path, query } = requestPath(request, prefix), match = /^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/demo-checkout(?:\/(confirm|receipt))?$/.exec(path);
      if (!match) { next(); return; }
      const requestId = ensureApiV1RequestId(request); response.setHeader("X-Request-Id", requestId);
      return safely(response, requestId, async () => {
        const method = (request.method ?? "GET").toUpperCase(), leaf = match[2];
        if (request.headers.authorization || request.headers.origin !== security.userOrigin) throw forbidden();
        if ((leaf === "confirm" ? method !== "POST" : method !== "GET")) throw notFound();
        const actor = { ...await readUserContext(request, security), requestId }, orderId = match[1]!;
        if (leaf === "receipt") {
          if (query.size !== 1 || query.getAll("key").length !== 1) throw invalid("One original key required");
          sendJson(response, 200, await readEcsDemoCheckoutReceipt(security.pool, actor, orderId, validateIdempotencyKey(query.get("key")), options), requestId); return;
        }
        if (query.size) throw invalid();
        if (!leaf) { sendJson(response, 200, await readEcsDemoCheckoutAvailability(security.pool, actor, orderId, options), requestId); return; }
        ensureOnlyFields(bodyOf(request), []);
        const result = await confirmEcsDemoCheckout(security.pool, actor, orderId, validateIdempotencyKey(request.headers["idempotency-key"]), options);
        sendJson(response, result.status, result.body, requestId);
      });
    });
}
