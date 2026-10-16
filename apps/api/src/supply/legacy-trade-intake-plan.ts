import {canonicalize} from "./content-hash";
import {sha256Hex} from "./supply-util";
import {prepareLegacyTradeIntake,type LegacyTradeIntake,type TradeCatalogItem} from "./legacy-trade-takeover";

export type LegacyTradeBatchRow={legacyId:string;accountId:string|null;intake:LegacyTradeIntake|null;isolationReasons:string[]};
/** Pure review output for the frozen input file; not an importer and never a proof of live tradability. */
export function planLegacyTradeIntakeBatch(rows:readonly LegacyTradeBatchRow[],catalog:readonly TradeCatalogItem[]){
 const repeated=(key:(r:LegacyTradeBatchRow)=>string|null)=>{const counts=new Map<string,number>();for(const row of rows){const id=key(row);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}return new Set([...counts].filter(([,n])=>n>1).map(([id])=>id));};
 const sourceDuplicates=repeated(r=>r.legacyId),accountDuplicates=repeated(r=>r.accountId);
 const items=rows.map(row=>{
  const isolated=[...row.isolationReasons,...(!row.accountId||!row.intake?["SOURCE_BINDING_MISSING"]:[]),...(sourceDuplicates.has(row.legacyId)||row.accountId&&accountDuplicates.has(row.accountId)?["DUPLICATE_SOURCE_OR_TARGET"]:[])];
  const base={legacyId:row.legacyId,accountId:row.accountId,sourceDigest:row.intake?.source.sourceDigest??null,inputDigest:sha256Hex(canonicalize(row))};
  if(isolated.length)return {...base,admission:"ISOLATED" as const,reasons:[...new Set(isolated)]};
  if(row.intake!.accountId!==row.accountId || row.intake!.source.legacyId!==row.legacyId)return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_BINDING_MISMATCH"]};
  try{const plan=prepareLegacyTradeIntake(row.intake!,catalog);return {...base,admission:plan.admission,reasons:plan.reasons};}
  catch{return {...base,admission:"ISOLATED" as const,reasons:["SOURCE_SCHEMA_INVALID"]};}
 });
 const counts={total:items.length,tradeCandidate:items.filter(i=>i.admission==="TRADE_CANDIDATE").length,blocked:items.filter(i=>i.admission==="BLOCKED").length,isolated:items.filter(i=>i.admission==="ISOLATED").length};
 return {schema:"legacy-trade-intake-plan.v1" as const,writeAllowed:false as const,inputDigest:sha256Hex(canonicalize({rows,catalog})),counts,items,realRuntime:"NOT_RUN" as const};
}
