import {canonicalize} from "./content-hash";
import {sha256Hex} from "./supply-util";
import {prepareLegacyTradeIntake,type LegacyTradeIntake,type TradeCatalogItem} from "./legacy-trade-takeover";

const DIGEST=/^[a-f0-9]{64}$/,text=(value:unknown)=>typeof value==="string"&&value?value:null;
/** Extraction digests stay separate: old12 is the immutable mapped source digest, new13 covers the added payout flag. */
export type LegacyTradeExtractionProjection={old12Digest:string|null;new13Digest:string|null};
export type LegacyTradeBatchRow={legacyId:string;accountId:string|null;intake:LegacyTradeIntake|null;isolationReasons:string[];projection?:LegacyTradeExtractionProjection|null};
const rowDigest=(row:unknown)=>{try{return sha256Hex(canonicalize(row));}catch{return sha256Hex("UNREPRESENTABLE_ROW");}};
/** Binds extraction-level digests before planning. A present payout flag needs a same-backup new13 digest whose old12 projection equals the mapped source digest; missing values stay missing, never 0. */
export function assembleLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[]):LegacyTradeBatchRow[]{
 return rows.map(row=>{
  const reasons=new Set(Array.isArray(row.isolationReasons)?row.isolationReasons:[]);
  try{
   if(!text(row.accountId)||!row.intake||typeof row.intake!=="object")reasons.add("SOURCE_BINDING_MISSING");
   else{
    const projection=row.projection??null,flag=row.intake.isFullPayout,digestOk=(value:unknown)=>value===null||value===undefined||typeof value==="string"&&DIGEST.test(value);
    if(projection!==null&&(!digestOk(projection.old12Digest)||!digestOk(projection.new13Digest)))reasons.add("FLAG_EXTRACTION_BINDING_UNPROVEN");
    else if(flag!==null&&flag!==undefined&&(!projection||!projection.new13Digest||projection.old12Digest!==row.intake.source.sourceDigest))reasons.add("FLAG_EXTRACTION_BINDING_UNPROVEN");
   }
  }catch{reasons.add("SOURCE_SCHEMA_INVALID");}
  return {...row,isolationReasons:[...reasons],projection:row.projection??null};
 });
}
/** Pure review output for the frozen input file; not an importer and never a proof of live tradability. */
export function planLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[],catalog:readonly TradeCatalogItem[]){
 const repeated=(key:(r:LegacyTradeBatchRow)=>string|null)=>{const counts=new Map<string,number>();for(const row of rows){const id=key(row);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}return new Set([...counts].filter(([,n])=>n>1).map(([id])=>id));};
 const sourceDuplicates=repeated(r=>text(r.legacyId)),accountDuplicates=repeated(r=>text(r.accountId));
 const items=rows.map(row=>{
  const legacyId=text(row.legacyId),accountId=text(row.accountId),inputDigest=rowDigest(row);
  try{
   const isolated=[...(Array.isArray(row.isolationReasons)?row.isolationReasons:[]),...(!accountId||!row.intake?["SOURCE_BINDING_MISSING"]:[]),...(legacyId&&sourceDuplicates.has(legacyId)||accountId&&accountDuplicates.has(accountId)?["DUPLICATE_SOURCE_OR_TARGET"]:[])];
   const base={legacyId:legacyId??"",accountId,sourceDigest:row.intake?.source.sourceDigest??null,inputDigest};
   if(isolated.length)return {...base,admission:"ISOLATED" as const,reasons:[...new Set(isolated)]};
   if(row.intake!.accountId!==accountId || row.intake!.source.legacyId!==legacyId)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_BINDING_MISMATCH"]};
   const plan=prepareLegacyTradeIntake(row.intake!,catalog);return {...base,admission:plan.admission,reasons:plan.reasons};
  }catch{return {legacyId:legacyId??"",accountId,sourceDigest:null,inputDigest,admission:"ISOLATED" as const,reasons:["SOURCE_SCHEMA_INVALID"]};}
 });
 const counts={total:items.length,tradeCandidate:items.filter(i=>i.admission==="TRADE_CANDIDATE").length,blocked:items.filter(i=>i.admission==="BLOCKED").length,isolated:items.filter(i=>i.admission==="ISOLATED").length};
 return {schema:"legacy-trade-intake-plan.v1" as const,writeAllowed:false as const,inputDigest:rowDigest({rows,catalog}),counts,items,realRuntime:"NOT_RUN" as const};
}
