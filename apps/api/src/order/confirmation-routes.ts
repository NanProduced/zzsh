import { handleRentalPricePreview, RENTAL_PRICE_PREVIEW_PATHS } from "./rental-price-preview";
import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, forbidden, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { safely, type SupplyResponse } from "../supply/supply-routes";
import { confirmationInput, issuePersonalConfirmation, type PersonalConfirmationOptions } from "./personal-confirmation";

export function mountPersonalConfirmations(app:INestApplication,security:AuthSecurityOptions,options:PersonalConfirmationOptions) {
  for(const path of ["/api/v2/order-confirmations","/api/bff/user/order-confirmations"]) app.getHttpAdapter().getInstance().use(path,(request:SupplyNodeRequest,response:SupplyResponse)=>{
    const requestId=ensureApiV1RequestId(request);
    return safely(response,requestId,async()=>{
      if(request.method!=="POST" || (request.originalUrl??"").split("?")[0]!==path)throw notFound();
      if(request.headers.authorization || request.headers.origin!==security.userOrigin)throw forbidden();
      const context=await readUserContext(request,security);
      const input=confirmationInput(bodyOf(request));
      const result=await withTransaction(security.pool,client=>issuePersonalConfirmation(client,context,input,options));
      sendJson(response,200,result,requestId);
    });
  });
  for (const path of RENTAL_PRICE_PREVIEW_PATHS) app.getHttpAdapter().getInstance().use(path, (request: SupplyNodeRequest, response: SupplyResponse) => handleRentalPricePreview(request, response, security, options, path));
}
