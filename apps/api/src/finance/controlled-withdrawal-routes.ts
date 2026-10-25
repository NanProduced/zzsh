import type {NativeWithdrawalScope} from './native-withdrawal-resource';
import { SecurityApiError, withTransaction } from '../auth/security-core';
import { validateIdempotencyKey } from '../contracts/api-v1';
import { createNativeWithdrawal, quoteNativeWithdrawalInTransaction, readNativeWithdrawalRecovery, type NativeWithdrawalOptions } from './native-withdrawal-store';
import type {ListingCursorKey} from '../supply/listing-cursor';
import type {INestApplication} from '@nestjs/common';import type {AuthSecurityOptions} from '../auth/auth-security';import {readUserContext} from '../auth/user-identity';import {ensureApiV1RequestId} from '../contracts/api-v1';
import {bodyOf,ensureOnlyFields,invalid,notFound,sendJson,type SupplyNodeRequest} from '../supply/supply-util';import {decodeId,requireOrigin,requestPath,safely,type SupplyResponse} from '../supply/supply-routes';
import {createControlledWithdrawal,readControlledWithdrawals,readControlledWithdrawalQuote,recoverControlledWithdrawal} from './controlled-withdrawal-store';
import {readPersonalWithdrawals,parsePersonalWithdrawalQuery,parsePersonalWithdrawalDetailPath} from './personal-withdrawal-read';
export function mountControlledWithdrawalRoutes(app:INestApplication,options:AuthSecurityOptions & {nativeWithdrawalScope?:NativeWithdrawalScope;listingCursorKey?:ListingCursorKey}){app.getHttpAdapter().getInstance().use('/api/v1/users/me/withdrawals',(request:SupplyNodeRequest,response:SupplyResponse)=>{
 const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{const {path,query}=requestPath(request,'/api/v1/users/me/withdrawals'),method=(request.method??'GET').toUpperCase();
  if(!['GET','POST'].includes(method))throw notFound();if(!requireOrigin(request,response,{...options,adminOrigin:options.userOrigin},requestId))return;const context={...await readUserContext(request,options),requestId};
  if(method==='GET'&&path==='/receipt'){for(const key of query.keys())if(key!=='key')throw invalid();const key=query.get('key');if(!key||key.length>128)throw invalid();sendJson(response,200,await recoverControlledWithdrawal(options.pool,context,key,options.nativeWithdrawalScope),requestId);return;}
  if(method==='GET'&&path==='/'){sendJson(response,200,await readPersonalWithdrawals(options.pool,context,parsePersonalWithdrawalQuery(query),options.listingCursorKey,options.nativeWithdrawalScope),requestId);return;}
  if(query.size)throw invalid('Unexpected controlled withdrawal query');
  if(method==='GET'){const sourceId=parsePersonalWithdrawalDetailPath(path);if(sourceId){sendJson(response,200,await readPersonalWithdrawals(options.pool,context,parsePersonalWithdrawalQuery(new URLSearchParams()),options.listingCursorKey,options.nativeWithdrawalScope,sourceId),requestId);return;}const match=/^\/([A-Za-z0-9_-]{1,128})$/.exec(path);if(!match)throw notFound();sendJson(response,200,await readControlledWithdrawals(options.pool,context,decodeId(match[1]!),options.nativeWithdrawalScope),requestId);return;}
  const body=bodyOf(request);ensureOnlyFields(body,['amountCents','destinationId','policyVersion','expectedWalletVersion']);
  if(path==='/quote'){sendJson(response,200,await readControlledWithdrawalQuote(options.pool,context,body,options.nativeWithdrawalScope),requestId);return;}
  if(path!=='/')throw notFound();const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw invalid('Idempotency key required');const result=await createControlledWithdrawal(options.pool,context,body,key,options.nativeWithdrawalScope);sendJson(response,result.status,result.body,requestId);
 });});}

/** New channel namespace; the existing LOCAL routes and receipts stay independent. */
export function mountChannelWithdrawalRoutes(app:INestApplication,options:AuthSecurityOptions & {joinpayWithdrawal?:NativeWithdrawalOptions}){
 for(const prefix of ['/api/v1/users/me/channel-withdrawals','/api/bff/user/channel-withdrawals']) app.getHttpAdapter().getInstance().use(prefix,(request:SupplyNodeRequest,response:SupplyResponse)=>{
  const requestId=ensureApiV1RequestId(request);return safely(response,requestId,async()=>{
   const {path,query}=requestPath(request,prefix),method=(request.method??'GET').toUpperCase();
   if(!['GET','POST'].includes(method))throw notFound();
   if(!requireOrigin(request,response,{...options,adminOrigin:options.userOrigin},requestId))return;
   const actor={...await readUserContext(request,options),requestId};
   if(method==='GET'&&path==='/options'){
    if(query.size)throw invalid('Unexpected withdrawal context query');const channel=options.joinpayWithdrawal;
    if(!channel?.readContext)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Withdrawal context is not integrated');
    sendJson(response,200,await withTransaction(options.pool,c=>channel.readContext!(c,actor)),requestId);return;
   }
   let selector:{key:string}|{intentId:string}|undefined;
   if(method==='GET'){
    if(path==='/receipt'){
     if(query.size!==1||query.getAll('key').length!==1)throw invalid('One recovery key required');
     selector={key:validateIdempotencyKey(query.get('key'))};
    }else{
     const match=/^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
     if(!match||query.size)throw notFound();selector={intentId:match[1]!};
    }
   }else if(query.size||!['/','/quote'].includes(path))throw notFound();
   const body=method==='POST'?bodyOf(request):undefined;
   if(body)ensureOnlyFields(body,path==='/quote'?['amountCents','destinationId','policyVersion']:['amountCents','destinationId','policyVersion','expectedWalletVersion']);
   const key=method==='POST'&&path==='/'?validateIdempotencyKey(request.headers['idempotency-key']):undefined;
   const channel=options.joinpayWithdrawal;
   if(!channel)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Channel withdrawal is not integrated');
   if(selector){sendJson(response,200,await withTransaction(options.pool,c=>readNativeWithdrawalRecovery(c,actor,channel.scope,selector)),requestId);return;}
   if(path==='/quote'){sendJson(response,200,await withTransaction(options.pool,c=>quoteNativeWithdrawalInTransaction(c,actor,body!,channel)),requestId);return;}
   const result=await createNativeWithdrawal(options.pool,actor,body!,key,channel);sendJson(response,result.status,result.body,requestId);
  });
 });
}
