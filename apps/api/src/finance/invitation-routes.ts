import type {INestApplication} from '@nestjs/common';import type {AuthSecurityOptions} from '../auth/auth-security';import {readUserContext} from '../auth/user-identity';import {ensureApiV1RequestId} from '../contracts/api-v1';
import {bodyOf,invalid,notFound,sendJson,type SupplyNodeRequest} from '../supply/supply-util';import {requestPath,safely,requireOrigin,type SupplyResponse} from '../supply/supply-routes';import {readMyInvitations,readMyInvitees,parseInviteesQuery,readMyLeaderBindingReceipt,bindMyDistributionLeader} from './invitation-store';
import type {LocalDistributionScope} from './distribution-policy-store';
import type {ListingCursorKey} from '../supply/listing-cursor';
import {parseEarningsQuery,readMyDistributionEarnings} from './distribution-earning-read';
import {decodeId} from '../supply/supply-routes';
/** Candidate self BFF-independent API; no registration INVITER rewrite endpoint. */
export function mountInvitationRoutes(app:INestApplication,options:AuthSecurityOptions&{listingCursorKey?:ListingCursorKey;distributionScope?:LocalDistributionScope}){app.getHttpAdapter().getInstance().use('/api/v1/users/me/distribution',(request:SupplyNodeRequest,response:SupplyResponse)=>{
 const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{const {path,query}=requestPath(request,'/api/v1/users/me/distribution'),method=request.method??'GET',earningDetail=/^\/earnings\/([^/]+)$/.exec(path);if(!(method==='GET'&&(['/','/invitees','/bind/receipt','/earnings'].includes(path)||earningDetail)||method==='POST'&&path==='/bind')||query.size&&!['/invitees','/bind/receipt','/earnings'].includes(path))throw notFound();if(!requireOrigin(request,response,{...options,adminOrigin:options.userOrigin},requestId))return;const actor={...await readUserContext(request,options),requestId};
  if(method==='GET'&&(path==='/earnings'||earningDetail)){sendJson(response,200,await readMyDistributionEarnings(options.pool,actor,parseEarningsQuery(query),options.listingCursorKey,earningDetail?decodeId(earningDetail[1]!):undefined),requestId);return;}
  if(method==='GET'){if(path==='/invitees'){sendJson(response,200,await readMyInvitees(options.pool,actor,parseInviteesQuery(query),options.listingCursorKey),requestId);return;}if(path==='/bind/receipt'){if(query.size!==1||query.getAll('key').length!==1)throw notFound();sendJson(response,200,await readMyLeaderBindingReceipt(options.pool,actor,query.get('key')!),requestId);return;}sendJson(response,200,await readMyInvitations(options.pool,actor,options.distributionScope),requestId);return;}
  const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw invalid('Original binding idempotency key required');const result=await bindMyDistributionLeader(options.pool,actor,bodyOf(request),key,options.distributionScope);sendJson(response,result.status,result.body,requestId);
 });
});}


