import type { INestApplication } from '@nestjs/common';
import { readAdminContext, type AuthSecurityOptions } from '../auth/auth-security';
import { withTransaction } from '../auth/security-core';
import { ensureApiV1RequestId } from '../contracts/api-v1';
import { invalid, notFound, sendJson, type SupplyNodeRequest } from '../supply/supply-util';
import { requestPath, requireOrigin, safely, type SupplyResponse } from '../supply/supply-routes';
import { readAdminDistributionOrder, readAdminDistributionRelations } from './admin-distribution-read';

/** New read leaves only. Shared API/BFF mounting is an explicit Master hunk. */
export async function handleAdminDistributionRead(request:SupplyNodeRequest,response:SupplyResponse,options:AuthSecurityOptions){
 const requestId=ensureApiV1RequestId(request);
 return safely(response,requestId,async()=>{
  const {path,query}=requestPath(request,'/api/v1/admin/distribution');
  if((request.method??'GET')!=='GET')throw notFound();
  if(query.size)throw invalid('Distribution detail does not accept query parameters');
  const order=/^\/orders\/(NATIVE|LEGACY)\/([A-Za-z0-9._:-]+)$/.exec(path),relation=/^\/relations\/([A-Za-z0-9._:-]+)$/.exec(path);
  if(!order&&!relation)throw notFound();
  if(!requireOrigin(request,response,options,requestId))return;
  const actor=await readAdminContext(request,options);
  const body=await withTransaction(options.pool,async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SELECT set_config('statement_timeout','3s',true),set_config('lock_timeout','500ms',true)");
   return order?readAdminDistributionOrder(c,actor,{orderId:order[2]!,origin:order[1] as 'NATIVE'|'LEGACY'}):readAdminDistributionRelations(c,actor,relation![1]!);
  });
  sendJson(response,200,body,requestId,'private, no-store');
 });
}
export function mountAdminDistributionReadRoutes(app:INestApplication,options:AuthSecurityOptions){
 app.getHttpAdapter().getInstance().use('/api/v1/admin/distribution',(request:SupplyNodeRequest,response:SupplyResponse,next:()=>void)=>{
  const {path}=requestPath(request,'/api/v1/admin/distribution');
  if(!path.startsWith('/orders/')&&!path.startsWith('/relations/'))return next();
  return handleAdminDistributionRead(request,response,options);
 });
}
