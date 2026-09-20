import { readAdminContext,assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess,requirePermission,ADMIN_PERMISSION } from "../auth/admin-authorization";
import { withTransaction,recordAudit,setAuditContext } from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf,assertGameScope,conflict,invalid,notFound,sendJson,withIdempotency,fingerprintRequest,headerValue,sha256Hex,type SupplyNodeRequest,type SupplyNodeResponse } from "./supply-util";
import type { SupplyRuntimeOptions } from "./supply-routes";
import { checkedId,checkedObject,checkedText,parseFilterConfig,parseListingQueryV2 } from "./listing-filter-contract";
import { listingCatalogContext,readListingState,validateConfigCatalog,validateListingQuery,publicFilterMetadata } from "./listing-filter-config";
import { canonicalize } from "./content-hash";
import { buildListingCandidates,type ListingPosition } from "./listing-candidates";
import { requireListingCursorKey,decodeListingCursor,encodeListingCursor,type ListingCursorBinding } from "./listing-cursor";
import { withPublicListingSnapshot,listingDetail,readPublishingAccount,unknownSupplyGate } from "./publishing";

function revision(v:unknown,path:string):string{if(typeof v!=="string"||!/^(0|[1-9]\d{0,18})$/.test(v)||BigInt(v)>9223372036854775807n)throw invalid("Invalid revision",path);return v;}
export async function handleListingFilters(request:SupplyNodeRequest,response:SupplyNodeResponse,options:SupplyRuntimeOptions,requestId:string,path:string,query:URLSearchParams,admin:boolean):Promise<boolean> {
  const match=/^\/games\/([^/]+)\/listing-filters(?:\/(restore))?$/.exec(path);
  if(!match)return false;
  const gameId=checkedId(match[1],"gameId"),method=request.method??"GET";
  if(!admin){if(method!=="GET"||match[2])throw notFound();const result=await withPublicListingSnapshot(options.pool,async client=>publicFilterMetadata(await readListingState(client,gameId),Boolean(options.listingCursorKey)));sendJson(response,200,result,requestId);return true;}
  const context=await readAdminContext(request,options);
  const authorize=async(client:Parameters<typeof readListingState>[0])=>{await assertAdminContextInTransaction(client,context);const access=await loadEffectiveAdminAccess(client,context.userId);if(!access)throw notFound();requirePermission(access,ADMIN_PERMISSION.supplyListingFiltersManage);await assertGameScope(client,context.userId,access.isBoss,gameId);};
  if(method==="GET"&&!match[2]) {
    const result=await withTransaction(options.pool,async client=>{await authorize(client);const history=(await client.query(`SELECT revision::text,config,restore_from_revision::text AS "restoreFromRevision",created_at AS "createdAt",created_by_admin_id AS "createdBy" FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision DESC LIMIT 20`,[gameId])).rows;return {gameId,revision:history[0]?.revision??"0",config:history[0]?.config??null,history};});sendJson(response,200,result,requestId);return true;
  }
  if((method!=="PUT"||match[2]) && (method!=="POST"||!match[2]))throw notFound();
  const body=checkedObject(bodyOf(request),"",match[2]?["expectedRevision","restoreFromRevision","reason"]:["expectedRevision","config","reason"]);
  const expected=revision(body.expectedRevision,"expectedRevision"),reason=checkedText(body.reason,"reason",500),restore=match[2]?revision(body.restoreFromRevision,"restoreFromRevision"):null;
  const parsed=restore===null?parseFilterConfig(body.config):null;
  const operation=restore===null?"supply.listing_filters.save":"supply.listing_filters.restore";
  const result=await withTransaction(options.pool,async client=>{
    await setAuditContext(client,"admin",context.userId,context.sessionId,requestId);
    return withIdempotency(client,{realm:"admin",principalId:context.userId,operation,resourceId:gameId},validateIdempotencyKey(headerValue(request.headers["idempotency-key"])),fingerprintRequest(operation,gameId,body),()=>authorize(client),async()=>{
      await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[gameId]);
      const previous=(await client.query(`SELECT revision::text,config FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision DESC LIMIT 1`,[gameId])).rows[0];
      if((previous?.revision??"0")!==expected)throw conflict("Filter configuration changed");
      const historical=restore===null?null:(await client.query(`SELECT config FROM zzsh_supply.listing_filter_config WHERE game_id=$1 AND revision=$2`,[gameId,restore])).rows[0];
      if(restore!==null&&!historical)throw invalid("Unknown historical revision","restoreFromRevision");
      const config=parsed??parseFilterConfig(historical.config);validateConfigCatalog(config,await listingCatalogContext(client,gameId));
      const next=(BigInt(expected)+1n).toString();
      await client.query(`INSERT INTO zzsh_supply.listing_filter_config(game_id,revision,config,restore_from_revision,created_by_admin_id) VALUES($1,$2,$3,$4,$5)`,[gameId,next,config,restore,context.userId]);
      await recordAudit(client,{actorType:"admin",actorId:context.userId,sessionId:context.sessionId,requestId,action:operation,objectType:"listing_filter_config",objectId:gameId,outcome:"SUCCESS",reason,details:{before:previous??null,after:{revision:next,config,restoreFromRevision:restore}}});
      return {status:200,body:{gameId,revision:next,config,restoreFromRevision:restore}};
    });
  });sendJson(response,result.status,result.body,requestId);return true;
}

export async function listV2(request:SupplyNodeRequest,options:SupplyRuntimeOptions,query:URLSearchParams) {
  const q=parseListingQueryV2(query,request.originalUrl??request.url??"");requireListingCursorKey(options.listingCursorKey);
  return withPublicListingSnapshot(options.pool,async client=>{
    const state=await readListingState(client,q.gameId);
    for(const k of ["filterRevision","catalogRevision","ruleReleaseId"] as const)if(q[k]!==null&&q[k]!==state[k])throw conflict("Listing metadata revision changed");
    const binding:ListingCursorBinding={queryVersion:2,gameId:q.gameId,queryHash:sha256Hex(canonicalize({gameId:q.gameId,q:q.q,filters:q.filters,sort:q.sort,direction:q.direction,coreItemId:q.coreItemId})),sort:q.sort,direction:q.direction,coreItemId:q.coreItemId,filterRevision:state.filterRevision??"0",catalogRevision:state.catalogRevision,ruleReleaseId:state.ruleReleaseId??""};
    const after=q.cursor===null?null:decodeListingCursor(q.cursor,binding,options.listingCursorKey);
    await validateListingQuery(client,q,state);
    const sql=buildListingCandidates(q,after),rows=(await client.query<{id:string;version_id:string;key:string|null}>(sql.text,sql.values)).rows;
    const items:unknown[]=[];let last:ListingPosition|null=null,scanned=0;
    for(const row of rows){if(items.length===q.limit)break;last={id:row.id,key:row.key,isNull:row.key===null};scanned++;try{items.push(await listingDetail(client,await readPublishingAccount(client,row.id),"public",options.supplyGateReader??unknownSupplyGate));}catch(e){if((e as {status?:number}).status!==404)throw e;}}
    const more=scanned<rows.length||rows.length===200;
    return {queryVersion:2,items,nextCursor:more&&last?encodeListingCursor(last,binding,options.listingCursorKey):null,sort:q.sort,direction:q.direction,sortLabel:state.config!.sorts.find(s=>s.key===q.sort)!.label,filterRevision:state.filterRevision,catalogRevision:state.catalogRevision,ruleReleaseId:state.ruleReleaseId,scannedCount:scanned,scanBudget:200,scanBudgetReached:scanned===200,limit:q.limit};
  });
}
