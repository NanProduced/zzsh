import {WalletRequestError} from './personal-wallet-client.ts';
import {commissionRecord,commissionRecordSummary,type CommissionRecord,type CommissionRecordSummary} from './distribution-earnings-client.ts';

export type SummaryMetric={knowledge:'KNOWN'|'UNKNOWN';cents:string|null;count:string|null;reasonCodes:string[]};
export type DistributionSummary={
  contractVersion:'distribution-self-summary.v1';asOf:string;subjectId:string;
  native:{settled:SummaryMetric;pending:SummaryMetric;recovery:SummaryMetric;revoked:SummaryMetric;orders:SummaryMetric};
  legacy:{settled:SummaryMetric;pending:SummaryMetric;expired:SummaryMetric;coverage:string};
  flow:{accrued:SummaryMetric;settled:SummaryMetric;monthSettled:SummaryMetric;reversed:SummaryMetric;recovered:SummaryMetric};
  network:{inviter:SummaryMetric;leader:SummaryMetric};
  trend:{date:string;cents:string;knowledge:'KNOWN'|'UNKNOWN'}[];
  recent:{id:string;source:'NATIVE'|'LEGACY';beneficiaryId:string;beneficiaryName:string|null;role:string;amountCents:string;state:string;occurredAt:string|null}[];
  reasonCodes:string[];
  unified?:CommissionRecordSummary;recentRecords?:CommissionRecord[];
};
const bad=()=>new WalletRequestError(502,'DISTRIBUTION_SUMMARY_CONTRACT_REQUIRED');
const obj=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v as Record<string,any>};
const cents=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v};
function metric(value:unknown):SummaryMetric{const m=obj(value);if(!['KNOWN','UNKNOWN'].includes(String(m.knowledge))||(m.knowledge==='KNOWN')!==(m.cents!==null)||!Array.isArray(m.reasonCodes))throw bad();return{knowledge:m.knowledge,cents:m.cents===null?null:cents(m.cents),count:m.count===null||m.count===undefined?null:cents(m.count),reasonCodes:m.reasonCodes.map(String)}}
export function distributionSummary(value:unknown,userId:string):DistributionSummary{
  const b=obj(value);if(b.subjectId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');if(b.contractVersion!=='distribution-self-summary.v1'||typeof b.asOf!=='string')throw bad();
  const n=obj(b.native),l=obj(b.legacy),f=obj(b.flow),net=obj(b.network);
  if(!Array.isArray(b.trend)||b.trend.length>40||!Array.isArray(b.recent)||b.recent.length>20)throw bad();
  return{contractVersion:'distribution-self-summary.v1',asOf:b.asOf,subjectId:userId,
    native:{settled:metric(n.settled),pending:metric(n.pending),recovery:metric(n.recovery),revoked:metric(n.revoked),orders:metric(n.orders)},
    legacy:{settled:metric(l.settled),pending:metric(l.pending),expired:metric(l.expired),coverage:String(l.coverage)},
    flow:{accrued:metric(f.accrued),settled:metric(f.settled),monthSettled:metric(f.monthSettled??f.settled),reversed:metric(f.reversed),recovered:metric(f.recovered)},
    network:{inviter:metric(net.inviter),leader:metric(net.leader)},
    trend:b.trend.map((p:any)=>{const x=obj(p);if(typeof x.date!=='string'||!['KNOWN','UNKNOWN'].includes(x.knowledge))throw bad();return{date:x.date,cents:cents(x.cents),knowledge:x.knowledge}}),
    recent:b.recent.map((r:any)=>{const x=obj(r);if(!['NATIVE','LEGACY'].includes(x.source))throw bad();return{id:String(x.id),source:x.source,beneficiaryId:String(x.beneficiaryId),beneficiaryName:x.beneficiaryName===null?null:String(x.beneficiaryName),role:String(x.role),amountCents:cents(x.amountCents),state:String(x.state),occurredAt:x.occurredAt===null?null:String(x.occurredAt)}}),
    reasonCodes:Array.isArray(b.reasonCodes)?b.reasonCodes.map(String):[],
    ...(b.unified===undefined?{}:{unified:commissionRecordSummary(b.unified)}),
    ...(b.recentRecords===undefined?{}:{recentRecords:(()=>{if(!Array.isArray(b.recentRecords)||b.recentRecords.length>5)throw bad();const records=b.recentRecords.map(commissionRecord);if(new Set(records.map((r:CommissionRecord)=>r.key)).size!==records.length)throw bad();return records;})()})};
}
export async function readDistributionSummary(signal?:AbortSignal,userId?:string){
  let response:Response;try{response=await fetch('/api/account/distribution/summary',{credentials:'same-origin',cache:'no-store',signal});}catch(e){if(signal?.aborted)throw e;throw new WalletRequestError(0,'NETWORK_ERROR')}
  const body=await response.json().catch(()=>null);if(!response.ok)throw new WalletRequestError(response.status,body?.error?.code??'SUMMARY_UNAVAILABLE');
  if(typeof body?.subjectId!=='string')throw bad();return distributionSummary(body,userId??body.subjectId);
}
