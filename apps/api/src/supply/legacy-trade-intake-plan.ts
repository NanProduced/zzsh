import {canonicalize} from "./content-hash";
import {sha256Hex} from "./supply-util";
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
/** Pure review output for the frozen input file; not an importer and never a proof of live tradability. */
export function planLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[],catalog:readonly TradeCatalogItem[]){
 const repeated=(key:(r:LegacyTradeBatchRow)=>string|null)=>{const counts=new Map<string,number>();for(const row of rows){const id=key(row);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}return new Set([...counts].filter(([,n])=>n>1).map(([id])=>id));};
 const sourceDuplicates=repeated(r=>text(r.legacyId)),accountDuplicates=repeated(r=>text(r.accountId));
 const items=rows.map(row=>{
  const legacyId=text(row.legacyId),accountId=text(row.accountId),inputDigest=stableFingerprint(row);
  try{
   const isolated=[...(Array.isArray(row.isolationReasons)?row.isolationReasons:[]),...(!accountId||!row.intake?["SOURCE_BINDING_MISSING"]:[]),...(legacyId&&sourceDuplicates.has(legacyId)||accountId&&accountDuplicates.has(accountId)?["DUPLICATE_SOURCE_OR_TARGET"]:[])];
   const base={legacyId:legacyId??"",accountId,sourceDigest:row.intake?.source.sourceDigest??null,inputDigest};
   if(isolated.length)return {...base,admission:"ISOLATED" as const,reasons:[...new Set(isolated)]};
   if(row.intake!.accountId!==accountId || row.intake!.source.legacyId!==legacyId)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_BINDING_MISMATCH"]};
   const plan=prepareLegacyTradeIntake(row.intake!,catalog);return {...base,admission:plan.admission,reasons:plan.reasons};
  }catch{return {legacyId:legacyId??"",accountId,sourceDigest:null,inputDigest,admission:"ISOLATED" as const,reasons:["SOURCE_SCHEMA_INVALID"]};}
 });
 const counts={total:items.length,tradeCandidate:items.filter(i=>i.admission==="TRADE_CANDIDATE").length,blocked:items.filter(i=>i.admission==="BLOCKED").length,isolated:items.filter(i=>i.admission==="ISOLATED").length};
 return {schema:"legacy-trade-intake-plan.v1" as const,writeAllowed:false as const,inputDigest:stableFingerprint({rows,catalog}),counts,items,realRuntime:"NOT_RUN" as const};
}
