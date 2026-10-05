import type {INestApplication} from '@nestjs/common';import type {AuthSecurityOptions} from '../auth/auth-security';import {readUserContext} from '../auth/user-identity';import {ensureApiV1RequestId} from '../contracts/api-v1';
import {bodyOf,ensureOnlyFields,invalid,notFound,sendJson,type SupplyNodeRequest} from '../supply/supply-util';import {decodeId,requireOrigin,requestPath,safely,type SupplyResponse} from '../supply/supply-routes';
import {createControlledWithdrawal,readControlledWithdrawals,readControlledWithdrawalQuote,recoverControlledWithdrawal} from './controlled-withdrawal-store';
export function mountControlledWithdrawalRoutes(app:INestApplication,options:AuthSecurityOptions){app.getHttpAdapter().getInstance().use('/api/v1/users/me/withdrawals',(request:SupplyNodeRequest,response:SupplyResponse)=>{
 const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{const {path,query}=requestPath(request,'/api/v1/users/me/withdrawals'),method=(request.method??'GET').toUpperCase();
  if(!['GET','POST'].includes(method))throw notFound();if(!requireOrigin(request,response,{...options,adminOrigin:options.userOrigin},requestId))return;const context={...await readUserContext(request,options),requestId};
  if(method==='GET'&&path==='/receipt'){for(const key of query.keys())if(key!=='key')throw invalid();const key=query.get('key');if(!key||key.length>128)throw invalid();sendJson(response,200,await recoverControlledWithdrawal(options.pool,context,key),requestId);return;}
  if(query.size)throw invalid('Unexpected controlled withdrawal query');
  if(method==='GET'){const match=/^\/([A-Za-z0-9_-]{1,128})$/.exec(path);if(path!=='/'&&!match)throw notFound();sendJson(response,200,await readControlledWithdrawals(options.pool,context,match?decodeId(match[1]!):undefined),requestId);return;}
  const body=bodyOf(request);ensureOnlyFields(body,['amountCents','destinationId','policyVersion','expectedWalletVersion']);
  if(path==='/quote'){sendJson(response,200,await readControlledWithdrawalQuote(options.pool,context,body),requestId);return;}
  if(path!=='/')throw notFound();const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw invalid('Idempotency key required');const result=await createControlledWithdrawal(options.pool,context,body,key);sendJson(response,result.status,result.body,requestId);
 });});}
