import type { INestApplication } from "@nestjs/common";
import {
  handleSupplyUserRoute,
  type SupplyRuntimeOptions,
} from "../supply/supply-routes";
import {
  forbidden,
  headerValue,
  sendError,
  type SupplyNodeRequest,
  type SupplyNodeResponse,
} from "../supply/supply-util";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { assertListingUrlBudget } from "../supply/listing-filter-contract";
import { SecurityApiError } from "../auth/security-core";
export function mountUserSupplyBff(
  app: INestApplication,
  options: SupplyRuntimeOptions,
): void {
  app
    .getHttpAdapter()
    .getInstance()
    .use(
      "/api/bff/user/supply",
      async (request: SupplyNodeRequest, response: SupplyNodeResponse) => {
        const requestId = ensureApiV1RequestId(request),
          origin = headerValue(request.headers.origin);
        if (
          headerValue(request.headers.authorization) ||
          (origin && ![options.userOrigin, options.apiOrigin].includes(origin))
        ) {
          sendError(response, forbidden(), requestId);
          return;
        }
        const raw = request.originalUrl ?? request.url ?? "/";
        if(new URLSearchParams(raw.split("?")[1]??"").get("queryVersion")==="2") {
          try {assertListingUrlBudget(raw);}catch(e){if(e instanceof SecurityApiError){sendError(response,e,requestId);return;}throw e;}
        }
        const suffix = raw.startsWith("/api/bff/user/supply")
          ? raw.slice("/api/bff/user/supply".length)
          : raw;
        request.url = "/api/v1/supply" + suffix;
        request.originalUrl = request.url;
        await handleSupplyUserRoute(request, response, options);
      },
    );
}
