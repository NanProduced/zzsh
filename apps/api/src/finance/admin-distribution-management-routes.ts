import type {INestApplication} from '@nestjs/common';
import {readAdminContext,type AuthSecurityOptions} from '../auth/auth-security';
import {ensureApiV1RequestId,validateIdempotencyKey} from '../contracts/api-v1';
import {bodyOf,invalid,notFound,sendJson,type SupplyNodeRequest} from '../supply/supply-util';
import {requestPath,requireOrigin,safely,type SupplyResponse} from '../supply/supply-routes';
import type {LocalDistributionScope} from './distribution-policy-store';
import type {DistributionManagementResource} from './distribution-management-resource';
import {changeDistributionLevelPolicy,changeParticipantLevel,readManagementParticipants,readManagementPolicy,rotateParticipantInviteCode} from './admin-distribution-management';

type Options=AuthSecurityOptions&{distributionReadScope?:LocalDistributionScope;distributionScope?:LocalDistributionScope;distributionManagement?:DistributionManagementResource};
export async function handleAdminDistributionManagement(request:SupplyNodeRequest,response:SupplyResponse,options:Options){
 const requestId=ensureApiV1RequestId(request);
 return safely(response,requestId,async()=>{
  const {path,query}=requestPath(request,'/api/v1/admin/distribution/manage'),method=request.method??'GET';
  if(!requireOrigin(request,response,options,requestId))return;
  const actor={...await readAdminContext(request,options),requestId},readScope=options.distributionReadScope??options.distributionScope;
  if(method==='GET'&&path==='/levels'){
   if(query.size)throw invalid('Policy read has no query');
   sendJson(response,200,await readManagementPolicy(options.pool,actor,readScope,options.distributionManagement),requestId);return;
  }
  if(method==='GET'&&path==='/participants'){
   if([...query.keys()].some(k=>!['q','page'].includes(k))||query.getAll('q').length>1||query.getAll('page').length>1)throw invalid('Invalid participant query');
   const page=query.get('page')??'1';if(!/^[1-9]\d{0,3}$|^10000$/.test(page))throw invalid('Invalid participant page');
   sendJson(response,200,await readManagementParticipants(options.pool,actor,{q:query.get('q')??'',page:Number(page)},readScope,options.distributionManagement),requestId);return;
  }
  if(method!=='POST'||query.size)throw notFound();
  const key=validateIdempotencyKey(request.headers['idempotency-key']),body=bodyOf(request),match=/^\/participants\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(level|code)$/.exec(path);
  const result=path==='/levels'?await changeDistributionLevelPolicy(options.pool,actor,body,key,options.distributionManagement):
   match&&match[2]==='level'?await changeParticipantLevel(options.pool,actor,match[1]!,body,key,options.distributionManagement):
   match?await rotateParticipantInviteCode(options.pool,actor,match[1]!,body,key,options.distributionManagement):null;
  if(!result)throw notFound();sendJson(response,result.status,{...(result.body as Record<string,unknown>),replayed:result.replayed},requestId);
 });
}
export function mountAdminDistributionManagementRoutes(app:INestApplication,options:Options){
 app.getHttpAdapter().getInstance().use('/api/v1/admin/distribution/manage',(request:SupplyNodeRequest,response:SupplyResponse)=>handleAdminDistributionManagement(request,response,options));
}
