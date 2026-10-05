import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { assertReplayAuthorization } from "../order/order";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { sendJson, notFound, forbidden, type SupplyNodeRequest } from "../supply/supply-util";
import { safely, decodeId, type SupplyResponse } from "../supply/supply-routes";
import type { ListingCursorKey } from "../supply/listing-cursor";
import { readPersonalWallet, readPersonalFinanceEntries, readPersonalFinanceEntry, parseFinanceQuery } from "./personal-finance-read";
import { mountControlledWithdrawalRoutes } from "./controlled-withdrawal-routes";
export function mountPersonalFinanceRead(app:INestApplication,options:AuthSecurityOptions & {listingCursorKey?:ListingCursorKey}){
  mountControlledWithdrawalRoutes(app,options);
  app.getHttpAdapter().getInstance().use('/api/v1/users/me/wallet',(request:SupplyNodeRequest,response:SupplyResponse)=>{
    const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{
      const url=new URL(request.originalUrl??request.url??"",options.apiOrigin),path=url.pathname;
      if(request.method!=="GET"||!/^\/api\/v1\/users\/me\/wallet(?:\/entries(?:\/[^/]+)?)?$/.test(path))throw notFound();
      const origin=request.headers.origin;if(origin!==undefined&&origin!==options.userOrigin&&origin!==options.apiOrigin)throw forbidden();
      const context=await readUserContext(request,options);
      const body=await withTransaction(options.pool,async client=>{await assertReplayAuthorization(client,context);if(path.endsWith('/wallet')){if(url.search)throw notFound();return {wallet:await readPersonalWallet(client,context.userId)};}if(path.endsWith('/entries'))return await readPersonalFinanceEntries(client,context,parseFinanceQuery(url.searchParams),options.listingCursorKey);if(url.search)throw notFound();return await readPersonalFinanceEntry(client,context.userId,decodeId(path.split('/').at(-1)!));});
      sendJson(response,200,body,requestId);
    });
  });
}
