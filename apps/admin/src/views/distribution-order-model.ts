import { AdminApiError } from '../api';
import { commissionStateLabel } from '@zzsh/ui/display-distribution';
import { parseDistributionPercent } from './distribution-policy-model';

type Origin='NATIVE'|'LEGACY';
type Item={id:string;origin:'NATIVE'|'LEGACY_MYSQL';beneficiary:{userId:string|null;name:string|null};role:string;amountCents:string;state:string;fundsDisposition:string;occurredAt:string;dueAt:string|null;calculation:{knowledge:'KNOWN'|'UNKNOWN';policyVersion:string|null;levelCode:string|null;rateMode?:'UNIFORM';percent:string|null;baseCents:string|null;formula:string|null;reasonCodes:string[]};channelArrival:'UNKNOWN';documentRef:string|null;recoveryRequiredCents:string|null;events:Array<{eventId:string;knowledge:'KNOWN'|'UNKNOWN';action:string|null;occurredAt:string|null}>};
export type OrderRead={schema:'admin-distribution-order.v1';knowledge:'KNOWN'|'UNAVAILABLE';contextKey:string;order:{id:string;origin:Origin;number:string|null};items:Item[];truncated:boolean;coverage:'THIS_AUTHORIZED_ORDER_ONLY';currentLegacyCommissions:Array<{dutyId:string;subjectId:string|null;amountCents:string|null;knowledge:'KNOWN'|'UNKNOWN';state:string;finalization:'POSTED'|'FINALIZED_ZERO'|'UNKNOWN';documentRef:string|null}>;reasonCodes:string[]};
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/,money=/^(0|[1-9]\d{0,23})$/;
const fail=():never=>{throw new AdminApiError(502,'DISTRIBUTION_READ_CONTRACT_REQUIRED');};
export function parseDistributionOrder(value:unknown):OrderRead{
 const v=value as OrderRead;if(!v||v.schema!=='admin-distribution-order.v1'||!['KNOWN','UNAVAILABLE'].includes(v.knowledge)||v.coverage!=='THIS_AUTHORIZED_ORDER_ONLY'||!v.order||!id.test(v.order.id)||!['NATIVE','LEGACY'].includes(v.order.origin)||!Array.isArray(v.items)||v.items.length>100||typeof v.truncated!=='boolean'||!Array.isArray(v.currentLegacyCommissions)||v.currentLegacyCommissions.length>100)return fail();
 for(const item of v.items){if(!item||typeof item.id!=='string'||!['NATIVE','LEGACY_MYSQL'].includes(item.origin)||(typeof item.amountCents!=='string'||!money.test(item.amountCents))||!item.beneficiary||!item.calculation||!['KNOWN','UNKNOWN'].includes(item.calculation.knowledge)||item.calculation.baseCents!==null&&(typeof item.calculation.baseCents!=='string'||!money.test(item.calculation.baseCents))||item.channelArrival!=='UNKNOWN'||!Array.isArray(item.events)||item.events.length>500)return fail();if(item.origin==='NATIVE'&&(['PENDING','SETTLED','REVOKED'].includes(item.state)&&item.fundsDisposition!==item.state||item.state==='RECOVERY_REQUIRED'&&item.fundsDisposition!=='SETTLED')||item.origin==='LEGACY_MYSQL'&&item.fundsDisposition!=='HISTORICAL_STATUS_ONLY')return fail();if(item.calculation.percent!==null)try{parseDistributionPercent(item.calculation.percent);}catch{return fail();}}
 return v;
}
export function distributionState(item:Pick<Item,'origin'|'state'|'fundsDisposition'>){
 // A recorded pending state alone does not prove a current payable responsibility.
 if(item.fundsDisposition==='HISTORICAL_STATUS_ONLY'&&item.state==='PENDING')return commissionStateLabel('UNKNOWN');
 return commissionStateLabel(item.state);
}
