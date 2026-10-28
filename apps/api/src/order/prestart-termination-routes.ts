import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction,SecurityApiError } from "../auth/security-core";
import type { PoolClient } from 'pg';
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, forbidden, invalid, notFound, sendJson } from "../supply/supply-util";
import { requireOrigin, requestPath, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { assertPrestartDecision } from "./prestart-termination-model";
import { authorizePrestartWrite, readPrestartTermination, requestPrestartTermination, reviewPrestartTermination } from "./prestart-termination";

type Request=Parameters<typeof requestPath>[0];
type Realm="user"|"admin";
const ID="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const READ=new RegExp(`^/(${ID})/prestart-termination$`);
const CREATE=new RegExp(`^/(${ID})/prestart-termination/requests$`);
const REVIEW=new RegExp(`^/(${ID})/prestart-termination/(${ID})/review$`);

/** 由已有订单router承接；GET不领取、不触发渠道或补建责任。 */
export async function handlePrestartTerminationRoute(request:Request,response:SupplyResponse,options:AuthSecurityOptions,realm:Realm):Promise<boolean>{
 const prefix=realm==='user'?'/api/v1/orders':'/api/v1/admin/orders';
 const {path,query}=requestPath(request,prefix),read=READ.exec(path),create=realm==='user'?CREATE.exec(path):null,review=realm==='admin'?REVIEW.exec(path):null;
 if(!read&&!create&&!review)return false;
 const method=(request.method??'GET').toUpperCase(),requestId=ensureApiV1RequestId(request);
 if(query.size)throw invalid('Prestart termination does not accept query fields');
 if(method==='GET'&&read){
  const expectedOrigin=realm==='user'?options.userOrigin:options.adminOrigin;
  if(request.headers.origin!==undefined&&request.headers.origin!==expectedOrigin&&request.headers.origin!==options.apiOrigin
    ||request.headers['sec-fetch-site']==='cross-site')throw forbidden();
  const context=realm==='user'?await readUserContext(request,options):await readAdminContext(request,options);
  const result=await withTransaction(options.pool,async client=>{
   await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   return readPrestartTermination(client,{...context,realm},read[1]!);
  });sendJson(response,200,result,requestId);return true;
 }
 if(method!=='POST'||!create&&!review)throw notFound();
 if(!requireOrigin(request,response,options,requestId))return true;
 const context=realm==='user'?await readUserContext(request,options):await readAdminContext(request,options),actor={...context,realm};
 const body=bodyOf(request),orderId=(create??review)![1]!;
 async function command(operation:string,resourceId:string,frozen:unknown,action:(c:PoolClient)=>Promise<{status:number;body:unknown}>){
  let actionCompleted=false;
  try{await runIdempotentWrite(options,request,response,requestId,{principalId:actor.userId,operation,resourceId},
   {realm,id:actor.userId,sessionId:actor.sessionId},frozen,async c=>{await authorizePrestartWrite(c,actor,orderId);},
   async c=>{const result=await action(c);actionCompleted=true;return result;});}
  catch(error){if(actionCompleted&&!(error instanceof SecurityApiError&&error.status<500)&&!response.headersSent){
   sendJson(response,202,{contractVersion:'order-prestart-termination.v1',orderId,outcome:'UNKNOWN',originalKeyRequired:true,
    channelResult:'NOT_SUBMITTED',bankArrival:'UNKNOWN'},requestId);return;}
   throw error;}
 }
 if(create){
  ensureOnlyFields(body,['expectedOrderRevision','reason']);
  if(typeof body.expectedOrderRevision!=='string'||!/^[1-9][0-9]{0,18}$/.test(body.expectedOrderRevision)
   ||typeof body.reason!=='string'||body.reason.trim().length<3||Buffer.byteLength(body.reason,'utf8')>600)throw invalid('Invalid termination request');
  const frozen={expectedOrderRevision:body.expectedOrderRevision,reason:body.reason.trim()};
  await command('order.prestart.request',orderId,frozen,client=>requestPrestartTermination(client,actor,{...frozen,orderId,requestId}));return true;
 }
 ensureOnlyFields(body,['expectedRevision','decision','assessment','reason']);
 const frozen=assertPrestartDecision({expectedRevision:body.expectedRevision,decision:body.decision,assessment:body.assessment,reason:body.reason});
 const terminationId=review![2]!;
 await command('order.prestart.review',terminationId,{orderId,...frozen},client=>reviewPrestartTermination(client,actor,{orderId,terminationId,...frozen,requestId}));return true;
}
