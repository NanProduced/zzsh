import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, forbidden, headerValue, notFound, type SupplyNodeRequest } from "../supply/supply-util";
import { runIdempotentWrite, safely, type SupplyResponse } from "../supply/supply-routes";
import { assertReplayAuthorization } from "./order";
import { createPersonalReservation, personalOrderInput, PERSONAL_ORDER_OPERATION } from "./personal-order";
import type { PersonalConfirmationOptions } from "./personal-confirmation";

export function mountPersonalOrders(app:INestApplication,security:AuthSecurityOptions,options:PersonalConfirmationOptions & {holdSeconds?:number}) {
  for(const path of ["/api/v2/orders","/api/bff/user/orders-v2"])app.getHttpAdapter().getInstance().use(path,(request:SupplyNodeRequest,response:SupplyResponse)=>{
    const requestId=ensureApiV1RequestId(request);
    return safely(response,requestId,async()=>{
      if(request.method!=="POST" || (request.originalUrl??"").split("?")[0]!==path)throw notFound();
      if(request.headers.authorization || request.headers.origin!==security.userOrigin)throw forbidden();
      const context=await readUserContext(request,security);
      const input=personalOrderInput(bodyOf(request));
      const key=validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
      const scope={principalId:context.userId,operation:PERSONAL_ORDER_OPERATION};
      await runIdempotentWrite(security,request,response,requestId,scope,{realm:"user",id:context.userId,sessionId:context.sessionId},input,
        async(client,replay)=>{
          if(!replay)return; // Fresh execution locks both parties in ID order, never renter first.
          await assertReplayAuthorization(client,context);
          const owned=await client.query(`SELECT 1 FROM zzsh_supply.idempotency_record i JOIN zzsh_order.rental_order o ON o.id=i.response_body#>>'{order,id}' WHERE i.scope_key=$1 AND i.key=$2 AND o.renter_user_id=$3`,[JSON.stringify(["user",context.userId,PERSONAL_ORDER_OPERATION,null]),key,context.userId]);
          if(!owned.rowCount)throw notFound();
        },client=>createPersonalReservation(client,context,input.confirmationToken,options,requestId));
    });
  });
}
