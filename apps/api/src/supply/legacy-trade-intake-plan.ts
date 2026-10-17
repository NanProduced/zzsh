import {canonicalize} from "./content-hash";
import {sha256Hex} from "./supply-util";
import {CUSTOMER_TIERS} from "./delta-rental";
import {accountColumns} from "../legacy-load/user-order-offline-plan";
import {prepareLegacyTradeIntake,type LegacyTradeIntake,type TradeCatalogItem} from "./legacy-trade-takeover";

const DIGEST=/^[a-f0-9]{64}$/,UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3}|\.\d{6})Z$/,text=(value:unknown)=>typeof value==="string"&&value?value:null;
/** The reviewed extraction original: the same-batch 13-column la_rental_accounts row plus its batch/cutoff binding. Digests are recomputed from this body, never declared. */
export type LegacyTradeExtractionOriginal={sourceAsOf:string;extractSha256:string;row:Record<string,string|null>};
/** Computed by assembly: old12 is the frozen whitelist projection of the same row, new13 covers the payout flag. */
export type LegacyTradeExtractionProjection={sourceAsOf:string;extractSha256:string;old12Digest:string;new13Digest:string};
export type LegacyTradeExtractionRow={legacyId:string;accountId:string|null;intake:LegacyTradeIntake|null;isolationReasons:string[];original?:LegacyTradeExtractionOriginal|null};
export type LegacyTradeBatchRow={legacyId:string;accountId:string|null;intake:LegacyTradeIntake|null;isolationReasons:string[];projection?:LegacyTradeExtractionProjection|null};
/** Total stable serialization for batch identity: unlike canonicalize it never throws on legal JSON, so no row can collapse the batch fingerprint to a constant. */
export function stableFingerprint(value:unknown):string{
 const stable=(item:unknown):string=>{
  if(item===null)return "null";
  if(typeof item==="number")return Number.isFinite(item)?String(item):JSON.stringify(`number:${String(item)}`);
  if(typeof item==="string")return JSON.stringify(item);
  if(typeof item==="boolean")return item?"true":"false";
  if(Array.isArray(item))return `[${item.map(stable).join(",")}]`;
  if(typeof item==="object"){const record=item as Record<string,unknown>;return `{${Object.keys(record).sort().filter(key=>record[key]!==undefined).map(key=>`${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;}
  return JSON.stringify(`value:${typeof item}`);
 };
 return sha256Hex(stable(value));
}
/** Binds a new-13 payout flag to the same reviewed extraction original: recomputes old12/new13, compares the actual flag and keeps missing values missing. */
export function assembleLegacyTradeIntakeBatch(rows:readonly LegacyTradeExtractionRow[],packageSourceAsOf?:string):LegacyTradeBatchRow[]{
 return rows.map(row=>{
  const reasons=new Set(Array.isArray(row.isolationReasons)?row.isolationReasons:[]);
  let projection:LegacyTradeExtractionProjection|null=null;
  try{
   if(!text(row.accountId)||!row.intake||typeof row.intake!=="object")reasons.add("SOURCE_BINDING_MISSING");
   else{
    const flag=row.intake.isFullPayout,original=row.original??null;
    if(original===null){if(flag!==null&&flag!==undefined)reasons.add("FLAG_EXTRACTION_SOURCE_MISSING");}
    else if(!UTC.test(original.sourceAsOf)||!DIGEST.test(original.extractSha256)||!original.row||typeof original.row!=="object"||Array.isArray(original.row))reasons.add("FLAG_EXTRACTION_SOURCE_INVALID");
    else if(packageSourceAsOf!==undefined&&original.sourceAsOf!==packageSourceAsOf)reasons.add("FLAG_EXTRACTION_CUTOFF_MISMATCH");
    else if(accountColumns(original.row))reasons.add("FLAG_EXTRACTION_ROW_INVALID");
    else if(text(original.row.id)!==text(row.legacyId))reasons.add("FLAG_EXTRACTION_ROW_MISMATCH");
    else if(original.row.is_full_payout!==flag)reasons.add("FLAG_EXTRACTION_FLAG_MISMATCH");
    else{
     const{is_full_payout:_flag,...old12Row}=original.row,old12Digest=sha256Hex(canonicalize(old12Row));
     if(old12Digest!==row.intake.source.sourceDigest)reasons.add("FLAG_EXTRACTION_DIGEST_MISMATCH");
     else projection={sourceAsOf:original.sourceAsOf,extractSha256:original.extractSha256,old12Digest,new13Digest:sha256Hex(canonicalize(original.row))};
    }
   }
  }catch{reasons.add("SOURCE_SCHEMA_INVALID");}
  return {legacyId:text(row.legacyId)??"",accountId:text(row.accountId),intake:row.intake??null,isolationReasons:[...reasons],projection};
 });
}
/** Media association assembly: account → legacy original media reference → observed target media_asset → local byte evidence. */
export type LegacyTradeMediaAssetRef={assetId:string;accountId:string|null;ownerUserId:string|null;purpose:string|null;accessClass:string|null;technicalState:string|null;storageKey:string|null;contentHash:string|null};
export type LegacyTradeMediaAssemblyRow={legacyId:string;accountId:string|null;expectedOwnerUserId:string|null;
 /** Original media references in the reviewed legacy source row; null when the original row itself was not observed. */
 sourceImageRefs:readonly string[]|null;
 /** Observed target media_asset rows for the account; null when no database observation exists for the row. */
 targetAssets:readonly LegacyTradeMediaAssetRef[]|null;};
export type LegacyTradeMediaByteEvidence={storageKey:string;sha256:string|null;issues:readonly {kind:string}[]};
export type LegacyTradeMediaGateResult={legacyId:string;accountId:string|null;ready:boolean;reasons:string[];evidence:{sourceRefCount:number;observedAssetCount:number;byteBoundAssets:number}};
/** Every dimension blocks separately: missing original, missing reference, wrong subject, unusable bytes, purpose/visibility/state. */
export function assembleLegacyTradeMediaGate(rows:readonly LegacyTradeMediaAssemblyRow[],byteEvidence:readonly LegacyTradeMediaByteEvidence[]=[]):LegacyTradeMediaGateResult[]{
 const bytes=new Map(byteEvidence.map(e=>[e.storageKey,e]));
 return rows.map(row=>{
  const reasons=new Set<string>(),refs=row.sourceImageRefs,assets=row.targetAssets;
  if(!Array.isArray(refs)||refs.length===0)reasons.add("MEDIA_SOURCE_REFERENCE_MISSING");
  let byteBoundAssets=0;
  if(!Array.isArray(assets)||assets.length===0)reasons.add("MEDIA_ASSET_REFERENCE_MISSING");
  else for(const asset of assets){
   // Subject first: a byte-clean platform file is still not this account's asset, and no
   // brand/default image is ever substituted for a missing account original.
   if(asset.accountId!==row.accountId)reasons.add("MEDIA_SUBJECT_MISMATCH");
   if(asset.ownerUserId===null||row.expectedOwnerUserId===null)reasons.add("MEDIA_SUBJECT_UNPROVEN");
   else if(asset.ownerUserId!==row.expectedOwnerUserId)reasons.add("MEDIA_SUBJECT_MISMATCH");
   if(asset.purpose!=="ACCOUNT_DISPLAY")reasons.add("MEDIA_PURPOSE_INVALID");
   if(asset.accessClass!=="PUBLIC_DISPLAY")reasons.add("MEDIA_VISIBILITY_NOT_PUBLIC");
   if(asset.technicalState!=="READY")reasons.add("MEDIA_NOT_READY");
   const evidence=asset.storageKey?bytes.get(asset.storageKey):undefined;
   if(!evidence||evidence.issues.length>0||!evidence.sha256||!asset.contentHash||evidence.sha256!==asset.contentHash)reasons.add("MEDIA_BYTES_UNAVAILABLE");
   else byteBoundAssets++;
  }
  return {legacyId:text(row.legacyId)??"",accountId:text(row.accountId),ready:reasons.size===0,reasons:[...reasons],
    evidence:{sourceRefCount:Array.isArray(refs)?refs.length:0,observedAssetCount:Array.isArray(assets)?assets.length:0,byteBoundAssets}};
 });
}
/** Reviewed same-batch facts for the formal gates. An absent family stays visibly unobserved; it never defaults to pass. */
export type LegacyTradeBatchFacts={
 mediaGate?:readonly LegacyTradeMediaGateResult[];
 releaseByGame?:Readonly<Record<string,{releaseId:string;priceVersionId:string}|null>>;
 termOptionCodesByGame?:Readonly<Record<string,readonly string[]|null>>;
 priceLinesByGame?:Readonly<Record<string,readonly {itemId:string;customerTier:string}[]|null>>;
 occupancyByAccount?:Readonly<Record<string,"FREE"|"OCCUPIED"|"UNKNOWN">>;
};
export const LEGACY_TRADE_BATCH_FACTS_KEYS=["mediaGate","releaseByGame","termOptionCodesByGame","priceLinesByGame","occupancyByAccount"] as const;
/** Pure review output for the frozen input file; not an importer and never a proof of live tradability. */
export function planLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[],catalog:readonly TradeCatalogItem[],facts:LegacyTradeBatchFacts={}){
 const repeated=(key:(r:LegacyTradeBatchRow)=>string|null)=>{const counts=new Map<string,number>();for(const row of rows){const id=key(row);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}return new Set([...counts].filter(([,n])=>n>1).map(([id])=>id));};
 const sourceDuplicates=repeated(r=>text(r.legacyId)),accountDuplicates=repeated(r=>text(r.accountId)),digestDuplicates=repeated(r=>text((r.intake as {source?:{sourceDigest?:unknown}}|undefined)?.source?.sourceDigest));
 const mediaByKey=new Map((facts.mediaGate??[]).map(g=>[g.legacyId+"\u0000"+text(g.accountId),g]));
 const items=rows.map(row=>{
  const legacyId=text(row.legacyId),accountId=text(row.accountId),inputDigest=stableFingerprint(row);
  try{
   const sourceDigest=text((row.intake as {source?:{sourceDigest?:unknown}}|undefined)?.source?.sourceDigest);
   const isolated=[...(Array.isArray(row.isolationReasons)?row.isolationReasons:[]),...(!accountId||!row.intake?["SOURCE_BINDING_MISSING"]:[]),...(legacyId&&sourceDuplicates.has(legacyId)||accountId&&accountDuplicates.has(accountId)||sourceDigest&&digestDuplicates.has(sourceDigest)?["DUPLICATE_SOURCE_OR_TARGET"]:[])];
   const base={legacyId:legacyId??"",accountId,sourceDigest:row.intake?.source.sourceDigest??null,inputDigest};
   if(isolated.length)return {...base,admission:"ISOLATED" as const,reasons:[...new Set(isolated)]};
   if(row.intake!.accountId!==accountId || row.intake!.source.legacyId!==legacyId)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_BINDING_MISMATCH"]};
   const plan=prepareLegacyTradeIntake(row.intake!,catalog),extra:string[]=[];
   const media=mediaByKey.get((legacyId??"")+"\u0000"+(accountId??""));
   if(media&&!media.ready)extra.push(...media.reasons);
   const gameId=text(row.intake!.source.expectedGameId);
   if(facts.releaseByGame&&gameId){
    const release=facts.releaseByGame[gameId]??null;
    if(!release)extra.push("RELEASE_NOT_BOUND");
    else if(facts.termOptionCodesByGame!==undefined){
     const terms=facts.termOptionCodesByGame[gameId]??null;
     if(!terms||!terms.includes(row.intake!.termOptionCode))extra.push("TERM_OPTION_UNPROVEN");
    }
   }
   if(facts.priceLinesByGame&&gameId&&plan.draft){
    const lines=facts.priceLinesByGame[gameId]??null;
    if(!lines)extra.push("PRICE_LINE_MISSING");
    else{
     const have=new Set(lines.map(l=>l.itemId+"|"+l.customerTier));
     for(const tier of CUSTOMER_TIERS)for(const item of plan.draft.inventory as Array<{itemId:string}>)if(!have.has(item.itemId+"|"+tier))extra.push(tier==="STANDARD"?"PRICE_LINE_MISSING":"PRICE_MEMBER_TIER_MISSING");
    }
   }
   if(facts.occupancyByAccount){
    const state=accountId?facts.occupancyByAccount[accountId]:undefined;
    if(state!=="FREE")extra.push(state==="OCCUPIED"?"OCCUPIED":"OCCUPANCY_UNKNOWN");
   }
   return {...base,admission:extra.length?"BLOCKED" as const:plan.admission,reasons:[...new Set([...plan.reasons,...extra])]};
  }catch{return {legacyId:legacyId??"",accountId,sourceDigest:null,inputDigest,admission:"ISOLATED" as const,reasons:["SOURCE_SCHEMA_INVALID"]};}
 });
 const counts={total:items.length,tradeCandidate:items.filter(i=>i.admission==="TRADE_CANDIDATE").length,blocked:items.filter(i=>i.admission==="BLOCKED").length,isolated:items.filter(i=>i.admission==="ISOLATED").length};
 const unobservedFacts=LEGACY_TRADE_BATCH_FACTS_KEYS.filter(key=>facts[key]===undefined);
 return {schema:"legacy-trade-intake-plan.v1" as const,writeAllowed:false as const,inputDigest:stableFingerprint({rows,catalog,facts}),counts,items,unobservedFacts,realRuntime:"NOT_RUN" as const};
}
