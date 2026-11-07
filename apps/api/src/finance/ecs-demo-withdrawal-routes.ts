import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { assertEcsTestDemoAssembly } from "./ecs-test-demo-resource";
import { confirmDemoWithdrawal, createDemoWithdrawalTarget, quoteDemoWithdrawal, readDemoWithdrawalAvailability,
  readDemoWithdrawalIntent, readDemoWithdrawalReceipt, readDemoWithdrawalTargetReceipt, type EcsDemoWithdrawalOptions } from "./ecs-demo-withdrawal-service";

/** Only the bound demo runtime exposes these user-owned operations. */
export function mountEcsDemoWithdrawalRoutes(app:INestApplication,security:AuthSecurityOptions & {secureCookies:boolean},options:EcsDemoWithdrawalOptions) {
  assertEcsTestDemoAssembly(options.demo,security);
  for(const prefix of ["/api/v1/users/me/demo-withdrawal","/api/bff/user/me/demo-withdrawal"]) {
    app.getHttpAdapter().getInstance().use(prefix,(request:SupplyNodeRequest,response:SupplyResponse,next:()=>void)=>{
      const {path,query}=requestPath(request,prefix), match=/^\/intents\/(wd_[a-f0-9]{40})$/.exec(path);
      if(!["/","/target","/target/receipt","/quote","/confirm","/receipt"].includes(path)&&!match){next();return;}
      const requestId=ensureApiV1RequestId(request);response.setHeader("X-Request-Id",requestId);
      return safely(response,requestId,async()=>{
        if(request.headers.authorization||request.headers.origin!==security.userOrigin)throw forbidden();
        const method=(request.method??"GET").toUpperCase(), post=path==="/target"||path==="/quote"||path==="/confirm";
        if(method!==(post?"POST":"GET"))throw notFound();
        const actor={...await readUserContext(request,security),requestId};
        if(path==="/target/receipt"||path==="/receipt"){
          if(query.size!==1||query.getAll("key").length!==1)throw invalid("One original key required");
          const key=validateIdempotencyKey(query.get("key"));
          sendJson(response,200,path==="/receipt"?await readDemoWithdrawalReceipt(security.pool,actor,key,options)
            :await readDemoWithdrawalTargetReceipt(security.pool,actor,key,options),requestId);return;
        }
        if(query.size)throw invalid();
        if(path==="/"){sendJson(response,200,await readDemoWithdrawalAvailability(security.pool,actor,options),requestId);return;}
        if(match){sendJson(response,200,await readDemoWithdrawalIntent(security.pool,actor,match[1]!,options),requestId);return;}
        const body=bodyOf(request);
        if(path==="/quote"){sendJson(response,200,await quoteDemoWithdrawal(security.pool,actor,body,options),requestId);return;}
        const key=validateIdempotencyKey(request.headers["idempotency-key"]);
        sendJson(response,200,path==="/target"?await createDemoWithdrawalTarget(security.pool,actor,body,key,options)
          :await confirmDemoWithdrawal(security.pool,actor,body,key,options),requestId);
      });
    });
  }
}
