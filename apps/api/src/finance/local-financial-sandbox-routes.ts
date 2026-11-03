import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { SecurityApiError } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { issueLocalSandboxCheckout, completeLocalSandboxCheckout, readLocalSandboxCheckoutReceipt, readLocalSandboxCheckoutAvailability, type LocalSandboxCheckoutOptions } from "../order/local-sandbox-checkout-service";
import { assertLocalSandboxCheckoutSigner, verifyLocalSandboxCheckout } from "../order/local-sandbox-checkout-crypto";
import { renderLocalSandboxCheckoutPage } from "../order/local-sandbox-checkout-page";
import { assertLocalFinancialSandboxAssembly } from "./local-financial-sandbox-resource";
import { declareLocalSandboxWithdrawalTarget, readLocalSandboxWithdrawalTargetReceipt } from "./local-sandbox-withdrawal-target";
import { readAdoptedLocalPayment, readAdoptedLocalWithdrawalReceipt } from "./local-sandbox-adoption-read";

const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Original local checkout unavailable');
const exactKey=(query:URLSearchParams)=>{if(query.size!==1||query.getAll('key').length!==1)throw invalid('One original key required');return validateIdempotencyKey(query.get('key'));};
const idKey=(request:SupplyNodeRequest)=>validateIdempotencyKey(request.headers['idempotency-key']);
const singleOrigin=(request:SupplyNodeRequest)=>{const value=request.headers.origin;if(value!==undefined&&typeof value!=='string')throw forbidden();return value;};

/** Explicit trusted composition only. No environment switch or HTTP object can install the sandbox. */
export function mountLocalFinancialSandboxRoutes(app:INestApplication,security:AuthSecurityOptions&{secureCookies:boolean},checkout:LocalSandboxCheckoutOptions):void{
  assertLocalFinancialSandboxAssembly(checkout.sandbox,security);assertLocalSandboxCheckoutSigner(checkout.signer,checkout.sandbox);
  for(const prefix of ['/api/v1/orders','/api/bff/user/orders'])app.getHttpAdapter().getInstance().use(prefix,(request:SupplyNodeRequest,response:SupplyResponse,next:()=>void)=>{
    const {path,query}=requestPath(request,prefix),match=/^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(local-checkouts(?:\/(?:complete(?:\/receipt)?|receipt|page))?|local-sandbox-original-payment)$/.exec(path);
    if(!match){next();return;}
    const requestId=ensureApiV1RequestId(request);response.setHeader('X-Request-Id',requestId);
    return safely(response,requestId,async()=>{
      const method=(request.method??'GET').toUpperCase(),leaf=match[2]!,page=leaf==='local-checkouts/page',complete=leaf==='local-checkouts/complete';
      if(!['GET','POST'].includes(method)||page&&method!=='GET'||complete&&method!=='POST')throw notFound();
      const origin=singleOrigin(request);
      if(request.headers.authorization||(!page&&origin!==security.userOrigin&&!(complete&&origin===security.apiOrigin))
        ||page&&origin!==undefined&&![security.userOrigin,security.apiOrigin].includes(origin))throw forbidden();
      const actor={...await readUserContext(request,security),requestId},orderId=match[1]!;
      if(leaf==='local-sandbox-original-payment'){
        if(method!=='GET'||query.size)throw notFound();sendJson(response,200,await readAdoptedLocalPayment(security.pool,actor,orderId,checkout.sandbox),requestId);return;
      }
      if(page){
        const key=exactKey(query),issued=await readLocalSandboxCheckoutReceipt(security.pool,actor,orderId,'ISSUE',key,checkout);
        const body=issued.receipt as Record<string,any>|null,c=body?.checkout;
        if(issued.knowledge!=='KNOWN'||body?.contractVersion!=='local-sandbox-checkout.v1'||body.scope!=='LOCAL_CONTROLLED'||body.productionPaymentCapability!==false
          ||!c||typeof c.displayNo!=='string'||typeof c.ticket!=='string'||typeof c.completeKey!=='string'||c.amount?.currency!=='CNY'
          ||typeof c.amount.cents!=='string'||!Number.isFinite(Date.parse(c.expiresAt)))throw unavailable();
        validateIdempotencyKey(c.completeKey);
        const completed=await readLocalSandboxCheckoutReceipt(security.pool,actor,orderId,'COMPLETE',c.completeKey,checkout);
        const result=completed.receipt as Record<string,any>|null;
        const accepted=completed.knowledge==='KNOWN'&&result?.scope==='LOCAL_CONTROLLED'&&result.orderId===orderId
          &&result.contractVersion==='local-sandbox-checkout-result.v1'&&result.payment?.disposition==='APPLIED';
        let canComplete=false;
        try{const claims=verifyLocalSandboxCheckout(checkout.signer,c.ticket,actor,orderId,issued.observedAt);canComplete=issued.writeAssemblyReady===true
          &&claims.amountCents===c.amount.cents&&claims.displayNo===c.displayNo&&claims.expiresAt===c.expiresAt;}catch{/* Read-only expired/cross-session receipt; it grants no completion. */}
        const nonce=randomBytes(16).toString('base64url'),back=new URL('/account',security.userOrigin);back.searchParams.set('view','rentals');back.searchParams.set('orderId',orderId);
        const html=renderLocalSandboxCheckoutPage({nonce,displayNo:c.displayNo,amountCents:c.amount.cents,expiresAt:c.expiresAt,ticket:c.ticket,
          completeKey:c.completeKey,completePath:`/api/v1/orders/${orderId}/local-checkouts/complete`,returnUrl:back.href,accepted,canComplete});
        if(typeof response.send!=='function')throw unavailable();
        response.status(200).setHeader('Content-Type','text/html; charset=utf-8').setHeader('Cache-Control','no-store').setHeader('Referrer-Policy','no-referrer')
          .setHeader('X-Content-Type-Options','nosniff').setHeader('Content-Security-Policy',`default-src 'none';script-src 'nonce-${nonce}';style-src 'nonce-${nonce}';connect-src 'self';base-uri 'none';form-action 'none';frame-ancestors 'none'`);
        response.send(html);return;
      }
      if(leaf==='local-checkouts/receipt'||leaf==='local-checkouts/complete/receipt'){
        if(method!=='GET')throw notFound();const key=exactKey(query);
        sendJson(response,200,await readLocalSandboxCheckoutReceipt(security.pool,actor,orderId,leaf==='local-checkouts/receipt'?'ISSUE':'COMPLETE',key,checkout),requestId);return;
      }
      if(leaf==='local-checkouts'&&method==='GET'){
        if(query.size)throw invalid();
        sendJson(response,200,await readLocalSandboxCheckoutAvailability(security.pool,actor,orderId,checkout),requestId);return;
      }
      if(method!=='POST'||query.size)throw notFound();
      const body=bodyOf(request);ensureOnlyFields(body,complete?['ticket']:[]);
      if(complete&&typeof body.ticket!=='string')throw invalid();
      const result=complete?await completeLocalSandboxCheckout(security.pool,actor,orderId,body.ticket as string,idKey(request),checkout)
        :await issueLocalSandboxCheckout(security.pool,actor,orderId,idKey(request),checkout);
      sendJson(response,result.status,result.body,requestId);
    });
  });
  for(const prefix of ['/api/v1/users/me/local-sandbox','/api/bff/user/local-sandbox'])app.getHttpAdapter().getInstance().use(prefix,(request:SupplyNodeRequest,response:SupplyResponse,next:()=>void)=>{
    const {path,query}=requestPath(request,prefix);
    if(!['/withdrawal-targets','/withdrawal-targets/receipt','/adopted-withdrawal-receipt'].includes(path)){next();return;}
    const requestId=ensureApiV1RequestId(request);response.setHeader('X-Request-Id',requestId);
    return safely(response,requestId,async()=>{
      if(request.headers.authorization||singleOrigin(request)!==security.userOrigin)throw forbidden();
      const actor={...await readUserContext(request,security),requestId},method=(request.method??'GET').toUpperCase();
      if(path==='/withdrawal-targets'){
        if(method!=='POST'||query.size)throw notFound();const result=await declareLocalSandboxWithdrawalTarget(security.pool,actor,bodyOf(request),idKey(request),checkout.sandbox);
        sendJson(response,result.status,result.body,requestId);return;
      }
      if(method!=='GET')throw notFound();const key=exactKey(query),body=path==='/withdrawal-targets/receipt'
        ?await readLocalSandboxWithdrawalTargetReceipt(security.pool,actor,key,checkout.sandbox)
        :await readAdoptedLocalWithdrawalReceipt(security.pool,actor,key,checkout.sandbox);
      sendJson(response,200,body,requestId);
    });
  });
}
