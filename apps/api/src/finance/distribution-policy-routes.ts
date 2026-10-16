import type {INestApplication} from '@nestjs/common';import {readAdminContext,type AuthSecurityOptions} from '../auth/auth-security';import {ensureApiV1RequestId} from '../contracts/api-v1';
import {bodyOf,invalid,notFound,sendJson,type SupplyNodeRequest} from '../supply/supply-util';import {requestPath,safely,requireOrigin,type SupplyResponse} from '../supply/supply-routes';
import {readDistributionPolicy,configureDistributionPolicy,type LocalDistributionScope} from './distribution-policy-store';
export type DistributionPolicyRouteOptions=AuthSecurityOptions&{distributionScope?:LocalDistributionScope};
/**
 * Exportable handler for GET/PUT /api/v1/admin/distribution/policy so the Admin BFF can delegate exactly like the
 * membership-growth policy branch. Read and write stay separate: GET needs read or manage; PUT needs manage plus the
 * original revision, reason and idempotency key (store guards unchanged).
 */
export async function handleDistributionPolicyAdmin(request:SupplyNodeRequest,response:SupplyResponse,options:DistributionPolicyRouteOptions):Promise<void>{
 const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{const {path,query}=requestPath(request,'/api/v1/admin/distribution/policy');if(path!=='/'||query.size||!['GET','PUT'].includes(request.method??'GET'))throw notFound();if(!requireOrigin(request,response,options,requestId))return;const context={...await readAdminContext(request,options),requestId};
  if((request.method??'GET')==='GET'){sendJson(response,200,await readDistributionPolicy(options.pool,context,options.distributionScope),requestId);return;}
  const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw invalid('Original policy idempotency key required');const result=await configureDistributionPolicy(options.pool,context,bodyOf(request),key,options.distributionScope);sendJson(response,result.status,result.body,requestId);
 });
}
/** Candidate mount; activated only with the separately reviewed shared hunk. */
export function mountDistributionPolicyRoutes(app:INestApplication,options:DistributionPolicyRouteOptions){app.getHttpAdapter().getInstance().use('/api/v1/admin/distribution/policy',(request:SupplyNodeRequest,response:SupplyResponse)=>handleDistributionPolicyAdmin(request,response,options));}
