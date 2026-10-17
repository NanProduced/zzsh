import {canonicalize} from "./content-hash";
import {sha256Hex} from "./supply-util";
import {accountColumns} from "../legacy-load/user-order-offline-plan";
import {prepareLegacyTradeIntake,type LegacyTradeIntake,type TradeCatalogItem} from "./legacy-trade-takeover";

const DIGEST=/^[a-f0-9]{64}$/,UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3}|\.\d{6})?Z$/,text=(value:unknown)=>typeof value==="string"&&value?value:null;
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
/** Media association assembly: account → legacy original media reference → sealed original→asset association → observed target media_asset → local byte evidence. */
export type LegacyTradeMediaAssetRef={assetId:string;accountId:string|null;ownerUserId:string|null;purpose:string|null;accessClass:string|null;technicalState:string|null;storageKey:string|null;contentHash:string|null};
/** A sealed association record binding one real original reference to one target asset and its byte identity. */
export type LegacyTradeMediaAssociation={sourceRef:string;assetId:string;storageKey:string;contentHash:string};
export type LegacyTradeMediaAssemblyRow={legacyId:string;accountId:string|null;expectedOwnerUserId:string|null;
 /** Real original media references from the reviewed source row; only non-empty string values count, null when the original row itself was not observed. */
 sourceImageRefs:readonly string[]|null;
 /** Observed target media_asset rows for the account; null when no database observation exists for the row. */
 targetAssets:readonly LegacyTradeMediaAssetRef[]|null;
 /** Sealed original→asset→byte association records; without them no original lineage is proven, whatever the subject match says. */
 associations:readonly LegacyTradeMediaAssociation[]|null;};
export type LegacyTradeMediaByteEvidence={storageKey:string;sha256:string|null;issues:readonly {kind:string}[]};
export type LegacyTradeMediaGateResult={legacyId:string;accountId:string|null;ready:boolean;reasons:string[];provenAssets:Array<{assetId:string;storageKey:string|null;contentHash:string|null}>;evidence:{sourceRefCount:number;observedAssetCount:number;byteBoundAssets:number}};
/** Every dimension blocks separately: missing original, missing reference, unproven lineage, wrong subject, unusable bytes, purpose/visibility/state. */
export function assembleLegacyTradeMediaGate(rows:readonly (LegacyTradeMediaAssemblyRow|null|undefined)[],byteEvidence:readonly LegacyTradeMediaByteEvidence[]=[]):LegacyTradeMediaGateResult[]{
 // Conflicting byte facts for one storage key never last-win; exact duplicates are the same fact.
 const bytes=new Map<string,LegacyTradeMediaByteEvidence>(),conflictingBytes=new Set<string>();
 for(const entry of byteEvidence){
  if(!entry||typeof entry!=="object"||typeof entry.storageKey!=="string")continue;
  const prior=bytes.get(entry.storageKey);
  if(prior===undefined)bytes.set(entry.storageKey,entry);
  else if(stableFingerprint({sha256:prior.sha256,issues:prior.issues})!==stableFingerprint({sha256:entry.sha256,issues:entry.issues}))conflictingBytes.add(entry.storageKey);
 }
 return rows.map(raw=>{
  if(!raw||typeof raw!=="object")return {legacyId:"",accountId:null,ready:false,reasons:["MEDIA_ROW_INVALID"],provenAssets:[],
   evidence:{sourceRefCount:0,observedAssetCount:0,byteBoundAssets:0}};
  const row:LegacyTradeMediaAssemblyRow=raw;
  const legacyId=text(row.legacyId)??"",accountId=text(row.accountId);
  try{
   const reasons=new Set<string>();
   const refs=Array.isArray(row.sourceImageRefs)?row.sourceImageRefs:null;
   const validRefs=(refs??[]).filter((ref):ref is string=>typeof ref==="string"&&ref.length>0);
   if(refs===null||validRefs.length===0)reasons.add("MEDIA_SOURCE_REFERENCE_MISSING");
   else if(validRefs.length!==refs!.length)reasons.add("MEDIA_SOURCE_REFERENCE_INVALID");
   if(!accountId)reasons.add("MEDIA_SUBJECT_UNPROVEN");
   if(!text(row.expectedOwnerUserId))reasons.add("MEDIA_SUBJECT_UNPROVEN");
   const assets=Array.isArray(row.targetAssets)?row.targetAssets:null;
   let byteBoundAssets=0;
   const provenAssets:LegacyTradeMediaGateResult["provenAssets"]=[];
   if(assets===null||assets.length===0)reasons.add("MEDIA_ASSET_REFERENCE_MISSING");
   else{
    const associations=Array.isArray(row.associations)?row.associations.filter(a=>a&&typeof a==="object"):[];
    const associationConflicts=new Set<string>();
    const byAsset=new Map<string,LegacyTradeMediaAssociation[]>();
    for(const association of associations){const key=String((association as {assetId?:unknown}).assetId);byAsset.set(key,[...(byAsset.get(key)??[]),association]);}
    for(const [assetId,list] of byAsset)if(new Set(list.map(stableFingerprint)).size>1)associationConflicts.add(assetId);
    for(const asset of assets){
     // A null or scalar asset is a malformed row fact: it fails this row only, never the batch.
     if(!asset||typeof asset!=="object"||!text(asset.assetId)){reasons.add("MEDIA_ASSET_INVALID");continue;}
     const assetId=asset.assetId!;
     // Subject first: two nulls are not a binding, and a byte-clean platform file is still not this account's asset.
     if(!text(asset.accountId))reasons.add("MEDIA_SUBJECT_UNPROVEN");
     else if(!accountId||asset.accountId!==row.accountId)reasons.add("MEDIA_SUBJECT_MISMATCH");
     if(!text(asset.ownerUserId))reasons.add("MEDIA_SUBJECT_UNPROVEN");
     else if(!text(row.expectedOwnerUserId)||asset.ownerUserId!==row.expectedOwnerUserId)reasons.add("MEDIA_SUBJECT_MISMATCH");
     if(asset.purpose!=="ACCOUNT_DISPLAY")reasons.add("MEDIA_PURPOSE_INVALID");
     if(asset.accessClass!=="PUBLIC_DISPLAY")reasons.add("MEDIA_VISIBILITY_NOT_PUBLIC");
     if(asset.technicalState!=="READY")reasons.add("MEDIA_NOT_READY");
     // Lineage: only a sealed association whose source reference is one of this row's real originals
     // and whose byte identity matches the observed asset proves the original→asset→byte chain.
     const lineage=byAsset.get(assetId)??[];
     const proven=lineage.find(a=>validRefs.includes(a.sourceRef)&&a.storageKey===asset.storageKey&&a.contentHash===asset.contentHash);
     if(associationConflicts.has(assetId))reasons.add("MEDIA_ASSOCIATION_CONFLICT");
     else if(!proven)reasons.add("MEDIA_ASSOCIATION_UNPROVEN");
     const storageKey=proven?.storageKey??asset.storageKey;
     if(storageKey&&conflictingBytes.has(storageKey))reasons.add("MEDIA_BYTES_CONFLICT");
     const evidence=storageKey?bytes.get(storageKey):undefined;
     if(!evidence||!Array.isArray(evidence.issues)||evidence.issues.length>0||typeof evidence.sha256!=="string"||!DIGEST.test(evidence.sha256)||evidence.sha256!==asset.contentHash)reasons.add("MEDIA_BYTES_UNAVAILABLE");
     else byteBoundAssets++;
     if(proven)provenAssets.push({assetId,storageKey:asset.storageKey,contentHash:asset.contentHash});
    }
   }
   return {legacyId,accountId,ready:reasons.size===0,reasons:[...reasons],provenAssets,
    evidence:{sourceRefCount:validRefs.length,observedAssetCount:assets?.length??0,byteBoundAssets}};
  }catch{return {legacyId,accountId,ready:false,reasons:["MEDIA_ROW_INVALID"],provenAssets:[],
   evidence:{sourceRefCount:0,observedAssetCount:0,byteBoundAssets:0}};}
 });
}
/** Reviewed same-batch facts for the formal gates. An absent family stays visibly unobserved; it never defaults to pass. */
export type LegacyTradeBatchFacts={
 mediaGate?:readonly LegacyTradeMediaGateResult[];
 releaseByGame?:Readonly<Record<string,{releaseId:string;priceVersionId:string}|null>>;
 termOptionCodesByGame?:Readonly<Record<string,{releaseId:string;codes:readonly string[]}|null>>;
 priceLinesByGame?:Readonly<Record<string,{priceVersionId:string;lines:readonly {itemId:string;customerTier:string}[]}|null>>;
 occupancyByAccount?:Readonly<Record<string,"FREE"|"OCCUPIED"|"UNKNOWN">>;
};
export const LEGACY_TRADE_BATCH_FACTS_KEYS=["mediaGate","releaseByGame","termOptionCodesByGame","priceLinesByGame","occupancyByAccount"] as const;
/** Pure review output for the frozen input file; not an importer and never a proof of live tradability.
 * A call without the full fact families is an intake precheck only (stage=INTAKE_PRECHECK);
 * a formal batch must supply every family it relies on, and writeAllowed stays false regardless. */
export function planLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[],catalog:readonly TradeCatalogItem[],facts:LegacyTradeBatchFacts={}){
 const invalidFacts=LEGACY_TRADE_BATCH_FACTS_KEYS.some(key=>{
  const value=facts[key];
  return value!==undefined&&(key==="mediaGate"?!Array.isArray(value):value===null||typeof value!=="object"||Array.isArray(value));
 });
 const repeated=(key:(r:LegacyTradeBatchRow)=>string|null)=>{const counts=new Map<string,number>();for(const row of rows){const id=key(row);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}return new Set([...counts].filter(([,n])=>n>1).map(([id])=>id));};
 const sourceDuplicates=repeated(r=>text(r.legacyId)),accountDuplicates=repeated(r=>text(r.accountId)),digestDuplicates=repeated(r=>text((r.intake as {source?:{sourceDigest?:unknown}}|undefined)?.source?.sourceDigest));
 // Identical gate facts for one subject dedupe; conflicting ones isolate the row instead of picking a winner.
 const mediaGroups=new Map<string,LegacyTradeMediaGateResult[]>();
 for(const gate of Array.isArray(facts.mediaGate)?facts.mediaGate:[]){if(!gate||typeof gate!=="object")continue;const key=text(gate.legacyId)+"\u0000"+text(gate.accountId);mediaGroups.set(key,[...(mediaGroups.get(key)??[]),gate]);}
 const items=rows.map(row=>{
  const legacyId=text(row.legacyId),accountId=text(row.accountId),inputDigest=stableFingerprint(row);
  try{
   const sourceDigest=text((row.intake as {source?:{sourceDigest?:unknown}}|undefined)?.source?.sourceDigest);
   const isolated=[...(Array.isArray(row.isolationReasons)?row.isolationReasons:[]),...(!accountId||!row.intake?["SOURCE_BINDING_MISSING"]:[]),...(legacyId&&sourceDuplicates.has(legacyId)||accountId&&accountDuplicates.has(accountId)||sourceDigest&&digestDuplicates.has(sourceDigest)?["DUPLICATE_SOURCE_OR_TARGET"]:[])];
   const base={legacyId:legacyId??"",accountId,sourceDigest:row.intake?.source.sourceDigest??null,inputDigest};
   if(invalidFacts)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_SCHEMA_INVALID"]};
   if(isolated.length)return {...base,admission:"ISOLATED" as const,reasons:[...new Set(isolated)]};
   if(row.intake!.accountId!==accountId || row.intake!.source.legacyId!==legacyId)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_BINDING_MISMATCH"]};
   const plan=prepareLegacyTradeIntake(row.intake!,catalog),extra:string[]=[];
   if(facts.mediaGate!==undefined){
    const distinct=[...new Map((mediaGroups.get((legacyId??"")+"\u0000"+(accountId??""))??[]).map(g=>[stableFingerprint(g),g])).values()];
    if(distinct.length===0)extra.push("MEDIA_GATE_MISSING");
    else if(distinct.length>1)return {...base,admission:"ISOLATED" as const,reasons:["MEDIA_GATE_CONFLICT"]};
    else{
     const gate=distinct[0]!;
     if(!gate.ready){if(!Array.isArray(gate.reasons)||gate.reasons.length===0)extra.push("MEDIA_GATE_INVALID");else extra.push(...gate.reasons);}
     else{
      // The gate must prove the exact assets this intake declares: another account asset's proof is not this row's proof.
      const proven=new Map((gate.provenAssets??[]).map(p=>[p.assetId,p]));
      const declared=row.intake!.media??[];
      for(const media of declared){const asset=proven.get(media.assetId);if(!asset||asset.contentHash!==media.byteHash)extra.push("MEDIA_GATE_INTAKE_MISMATCH");}
      for(const assetId of proven.keys())if(!declared.some(media=>media.assetId===assetId))extra.push("MEDIA_GATE_INTAKE_MISMATCH");
     }
    }
   }
   const gameId=text(row.intake!.source.expectedGameId);
   if(facts.releaseByGame&&gameId){
    const release=facts.releaseByGame[gameId]??null;
    if(!release)extra.push("RELEASE_NOT_BOUND");
    else{
     const terms=facts.termOptionCodesByGame?.[gameId];
     if(facts.termOptionCodesByGame!==undefined){
      if(!terms||terms.releaseId!==release.releaseId)extra.push(terms?"TERM_FACT_VERSION_MISMATCH":"TERM_OPTION_UNPROVEN");
      else if(!terms.codes.includes(row.intake!.termOptionCode))extra.push("TERM_OPTION_UNPROVEN");
     }
     if(facts.priceLinesByGame!==undefined){
      const prices=facts.priceLinesByGame[gameId]??null;
      // The new growth/benefit chain computes on the formal STANDARD base at confirmation; the
      // retired legacy member tiers are never a publish precondition of this takeover gate.
      if(!prices)extra.push("PRICE_LINE_MISSING");
      else if(prices.priceVersionId!==release.priceVersionId)extra.push("PRICE_FACT_VERSION_MISMATCH");
      else{
       const standard=new Set(prices.lines.filter(l=>l.customerTier==="STANDARD").map(l=>l.itemId));
       if(plan.draft)for(const item of plan.draft.inventory as Array<{itemId:string}>)if(!standard.has(item.itemId))extra.push("PRICE_LINE_MISSING");
      }
     }
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
 const unobservedFacts=LEGACY_TRADE_BATCH_FACTS_KEYS.filter(key=>facts[key]===undefined||facts[key]===null);
 return {schema:"legacy-trade-intake-plan.v1" as const,stage:(unobservedFacts.length===0?"FULL_ADMISSION":"INTAKE_PRECHECK") as "FULL_ADMISSION"|"INTAKE_PRECHECK",
  writeAllowed:false as const,inputDigest:stableFingerprint({rows,catalog,facts}),counts,items,unobservedFacts,realRuntime:"NOT_RUN" as const};
}
