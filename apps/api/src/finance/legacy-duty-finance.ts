import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {conflict,ensureOnlyFields,invalid} from '../supply/supply-util';
import {exactCents} from './finance-money';

export const LEGACY_DUTY_FINANCE_CONTRACT='legacy-duty-finance.v1';
export const LEGACY_DUTY_KINDS=['RENTER_REFUND','OWNER_CREDIT','COMMISSION','DEPOSIT_COMPENSATION'] as const;
export type LegacyFinanceDuty={id:string;orderId:string;kind:typeof LEGACY_DUTY_KINDS[number];sourceRecordId:string;counterpartyUserId:string|null;amountCents:string;currency:'CNY';revision:string;status:string;source:string;sourceStatus:string|null;continuationVersionId:string|null;admissionId?:string|null;maturityAt:string|null;settledBy:string|null;settledRefType:string|null;settledRefId:string|null;settledRefDigest:string|null};
/** Produced only by T's verified confirm/admission reader under the common order lock, never HTTP JSON. */
export type LegacyDutyFinalBasis={
 kind:'CONFIRMED_CONTINUATION'|'COMPLETED_COMMISSION_ADMISSION'|'CONFISCATED_CONTINUATION'|'HISTORICAL_UNREFUNDED_ADMISSION';
 dutyId:string;orderId:string;dutyKind:LegacyFinanceDuty['kind'];sourceRecordId:string;subjectId:string;amountCents:string;currency:'CNY';dutyRevision:string;
 parentSourceDigest:string;parentSourceId:string;sourceRecordEntity:'la_distribution_order'|'la_order'|'legacy_continuation_version';sourceRecordDigest:string;basisFactsDigest:string;evidenceId:string;evidenceDigest:string;continuationVersionId:string|null;admissionId:string|null;effectiveHeadId:string|null;effectiveHeadRevision:string|null;
 sourceTimeKind:'CONFIRMED_AT'|'COMPLETED_AT'|'MATURES_AT'|'DISPOSED_AT'|'SOURCE_COMPLETED_AT';sourceTime:string;maturityAt:string|null;
 finalAmountKnown:true;netRefundKnown:boolean;currentNetRefundCents:string|null;fundsDisposition:'AVAILABLE'|'HELD'|'CONFISCATED'|'UNKNOWN';
};
export type LegacyDutyPostingInput={dutyId:string;expectedRevision:string;expectedEvidenceDigest:string;expectedAmountCents:string};
export type LegacyDutyFundingProof={
 contractVersion:typeof LEGACY_DUTY_FINANCE_CONTRACT;dutyId:string;orderId:string;kind:LegacyFinanceDuty['kind'];subjectId:string;amountCents:string;currency:'CNY';
 originalSourceSystem:'legacy_mysql_restore';originalSourceEntity:'la_order'|'la_distribution_order';originalSourceId:string;originalSourceDigest:string;
 originalOrderNumber:string|null;
 finalEvidenceDigest:string;coverageDecision:'NOT_PREVIOUSLY_CREDITED';coverageEvidenceDigest:string;sourceStatus:'CONFIRMED_UNPAID_LIABILITY';evidenceRef:string;
 witness:{openingBasisId:string;openingSourceDigest:string;coveredSetDigest:string;historyCoverageVersion:string;historyReferenceDigest:string;historyCutoff:string;sourceCount:string};
};
export type LegacyDutyRef={type:'LEDGER_ENTRY'|'FINANCE_EVENT';id:string;digest:string};
export type LegacyDutyFinalization='NONE'|'POSTED_POSITIVE_REFUND'|'FINALIZED_ZERO'|'UNKNOWN';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),digest=/^[a-f0-9]{64}$/,id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
/** Thin consumption of T's already verified reader. No current policy lookup, recalculation, or raw FINANCE label. */
export function legacyDutyBasisFromTrade(duty:LegacyFinanceDuty,raw:Record<string,any>):{knowledge:'KNOWN';basis:LegacyDutyFinalBasis}|{knowledge:'UNKNOWN';reason:string}{
 if(!raw||typeof raw!=='object')return{knowledge:'UNKNOWN',reason:'FINAL_BASIS_BINDING_INCOMPLETE'};
 if(raw.state==='UNKNOWN')return{knowledge:'UNKNOWN',reason:typeof raw.reason==='string'?raw.reason:'FINAL_BASIS_UNKNOWN'};
 if(raw.state!=='KNOWN'||raw.dutyId!==duty.id||raw.orderId!==duty.orderId||raw.kind!==duty.kind||raw.beneficiaryUserId!==duty.counterpartyUserId||raw.amountCents!==duty.amountCents||raw.currency!=='CNY'||raw.revision!==duty.revision
  ||![raw.parentSourceDigest,raw.sourceRecordDigest,raw.basisFactsDigest,raw.effectiveFactsDigest].every(s=>typeof s==='string'&&digest.test(s))||typeof raw.basisEvidenceId!=='string'||!id.test(raw.basisEvidenceId)
  ||raw.admissionId!==duty.admissionId||raw.continuationVersionId!==duty.continuationVersionId
  ||![raw.admissionId,raw.continuationVersionId,raw.effectiveHeadId].every(v=>v===null||typeof v==='string'&&id.test(v))
  ||!(raw.effectiveHeadRevision===null||typeof raw.effectiveHeadRevision==='string'&&/^[1-9]\d{0,18}$/.test(raw.effectiveHeadRevision))
  ||(raw.effectiveHeadId===null)!==(raw.effectiveHeadRevision===null))return{knowledge:'UNKNOWN',reason:'FINAL_BASIS_BINDING_INCOMPLETE'};
 const historic=raw.sourceTimeKind==='SOURCE_COMPLETED_AT',completed=typeof raw.admissionId==='string';
 const basis:LegacyDutyFinalBasis={kind:completed?'COMPLETED_COMMISSION_ADMISSION':historic?'HISTORICAL_UNREFUNDED_ADMISSION':duty.kind==='DEPOSIT_COMPENSATION'?'CONFISCATED_CONTINUATION':'CONFIRMED_CONTINUATION',
  dutyId:duty.id,orderId:duty.orderId,dutyKind:duty.kind,sourceRecordId:duty.sourceRecordId,subjectId:raw.beneficiaryUserId,amountCents:raw.amountCents,currency:'CNY',dutyRevision:raw.revision,
  parentSourceDigest:raw.parentSourceDigest,parentSourceId:raw.parentSourceId,sourceRecordEntity:raw.sourceRecordEntity,sourceRecordDigest:raw.sourceRecordDigest,basisFactsDigest:raw.basisFactsDigest,evidenceId:raw.basisEvidenceId,evidenceDigest:raw.effectiveFactsDigest,continuationVersionId:raw.continuationVersionId,admissionId:raw.admissionId,effectiveHeadId:raw.effectiveHeadId,effectiveHeadRevision:raw.effectiveHeadRevision,
  sourceTimeKind:raw.sourceTimeKind,sourceTime:raw.sourceTime,maturityAt:raw.maturityAt,finalAmountKnown:true,netRefundKnown:duty.kind!=='RENTER_REFUND'||raw.currentNetRefundCents===duty.amountCents,currentNetRefundCents:raw.currentNetRefundCents??null,fundsDisposition:raw.fundsDisposition};
 if(duty.kind==='RENTER_REFUND'&&!basis.netRefundKnown)return{knowledge:'UNKNOWN',reason:'CURRENT_NET_REFUND_NOT_CLOSED'};return{knowledge:'KNOWN',basis};
}
function cents(n:string){if(BigInt(exactCents(n))<0n)throw invalid('Nonnegative duty amount required');return n;}
export function parseLegacyDutyPostingInput(value:Record<string,unknown>):LegacyDutyPostingInput{
 ensureOnlyFields(value,['dutyId','expectedRevision','expectedEvidenceDigest','expectedAmountCents']);
 if(typeof value.dutyId!=='string'||!/^legacy_duty_[a-f0-9]{40}$/.test(value.dutyId)||typeof value.expectedRevision!=='string'||!/^[1-9]\d{0,18}$/.test(value.expectedRevision)
  ||typeof value.expectedEvidenceDigest!=='string'||!digest.test(value.expectedEvidenceDigest)||typeof value.expectedAmountCents!=='string')throw invalid('Exact duty posting intent required');
 return{dutyId:value.dutyId,expectedRevision:value.expectedRevision,expectedEvidenceDigest:value.expectedEvidenceDigest,expectedAmountCents:cents(value.expectedAmountCents)};
}
const micros=(v:string)=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v.slice(0,23)+'Z').toISOString()!==v.slice(0,23)+'Z')throw conflict('DUTY_FINAL_TIME_UNKNOWN');return BigInt(Date.parse(v.slice(0,23)+'Z'))*1000n+BigInt(v.slice(23,26));};
export function planLegacyDutyFinalization(duty:LegacyFinanceDuty,basis:LegacyDutyFinalBasis,funding:LegacyDutyFundingProof,input:LegacyDutyPostingInput,now:string){
 if(!duty||!basis||!funding||!LEGACY_DUTY_KINDS.includes(duty.kind)||duty.currency!=='CNY'||!duty.counterpartyUserId||!id.test(duty.counterpartyUserId)
  ||duty.id!==input.dutyId||duty.revision!==input.expectedRevision||cents(duty.amountCents)!==input.expectedAmountCents||!['PENDING','MATURED'].includes(duty.status)
  ||duty.settledBy!==null||duty.settledRefType!==null||duty.settledRefId!==null||duty.settledRefDigest!==null)throw conflict('DUTY_CHANGED_OR_NOT_PAYABLE');
 if(!['CONFIRMED_CONTINUATION','COMPLETED_COMMISSION_ADMISSION','CONFISCATED_CONTINUATION','HISTORICAL_UNREFUNDED_ADMISSION'].includes(basis.kind)||!['AVAILABLE','HELD','CONFISCATED','UNKNOWN'].includes(basis.fundsDisposition)
  ||basis.finalAmountKnown!==true||typeof basis.netRefundKnown!=='boolean'||basis.dutyId!==duty.id||basis.orderId!==duty.orderId||basis.dutyKind!==duty.kind||basis.sourceRecordId!==duty.sourceRecordId
  ||basis.subjectId!==duty.counterpartyUserId||basis.amountCents!==duty.amountCents||basis.currency!==duty.currency||basis.dutyRevision!==duty.revision||basis.evidenceDigest!==input.expectedEvidenceDigest
  ||basis.continuationVersionId!==duty.continuationVersionId||basis.admissionId!==duty.admissionId
  ||![basis.effectiveHeadId,basis.admissionId,basis.continuationVersionId].every(v=>v===null||typeof v==='string'&&id.test(v))
  ||!(basis.effectiveHeadRevision===null||typeof basis.effectiveHeadRevision==='string'&&/^[1-9]\d{0,18}$/.test(basis.effectiveHeadRevision))
  ||(basis.effectiveHeadId===null)!==(basis.effectiveHeadRevision===null)
  ||!/^[1-9]\d{0,23}$/.test(basis.parentSourceId)||basis.sourceRecordEntity!==(duty.kind==='COMMISSION'?'la_distribution_order':basis.kind==='HISTORICAL_UNREFUNDED_ADMISSION'?'la_order':'legacy_continuation_version')
  ||![basis.parentSourceDigest,basis.sourceRecordDigest,basis.basisFactsDigest,basis.evidenceDigest].every(s=>typeof s==='string'&&digest.test(s))||!id.test(basis.evidenceId))throw conflict('DUTY_FINAL_EVIDENCE_MISMATCH');
 if(basis.kind==='COMPLETED_COMMISSION_ADMISSION'){
  if(duty.kind!=='COMMISSION'||!basis.admissionId||basis.evidenceId!==basis.admissionId||basis.continuationVersionId!==null||!['COMPLETED_AT','MATURES_AT'].includes(basis.sourceTimeKind))throw conflict('COMPLETED_ADMISSION_CANNOT_REPLACE_CONFIRM');
 }else if(basis.kind==='HISTORICAL_UNREFUNDED_ADMISSION'){
  if(duty.kind!=='RENTER_REFUND'||duty.source!=='LEGACY_IMPORT'||!['COMPLETED_UNREFUNDED','DETAINED'].includes(duty.sourceStatus??'')||basis.sourceTimeKind!=='SOURCE_COMPLETED_AT'
   ||basis.admissionId!==null||basis.continuationVersionId!==null)throw conflict('HISTORICAL_UNPAID_REFUND_EVIDENCE_REQUIRED');
 }else if(!basis.effectiveHeadId||!basis.effectiveHeadRevision||!id.test(basis.effectiveHeadId)||!/^[1-9]\d{0,18}$/.test(basis.effectiveHeadRevision)
  ||basis.admissionId!==null||!basis.continuationVersionId||(basis.kind==='CONFISCATED_CONTINUATION')!==(duty.kind==='DEPOSIT_COMPENSATION')
  ||basis.sourceTimeKind!==(basis.kind==='CONFISCATED_CONTINUATION'?'DISPOSED_AT':'CONFIRMED_AT'))throw conflict('CURRENT_HEAD_FINAL_EVIDENCE_REQUIRED');
 if(duty.kind==='RENTER_REFUND'&&(basis.fundsDisposition!=='AVAILABLE'||!basis.netRefundKnown||basis.currentNetRefundCents!==duty.amountCents)||duty.kind==='DEPOSIT_COMPENSATION'&&basis.fundsDisposition!=='CONFISCATED')throw conflict('DUTY_FUNDS_DISPOSITION_NOT_PAYABLE');
 if(micros(basis.sourceTime)>micros(now))throw conflict('DUTY_FINAL_TIME_IN_FUTURE');
 if(duty.kind==='COMMISSION'){
  if(duty.status!=='MATURED'||basis.maturityAt===null||duty.maturityAt!==basis.maturityAt)throw conflict('COMMISSION_NOT_MATURED');
  const expected=basis.sourceTimeKind==='MATURES_AT'?micros(basis.sourceTime):micros(basis.sourceTime)+7n*86400000000n;
  if(micros(basis.maturityAt)!==expected||expected>micros(now))throw conflict('COMMISSION_MATURITY_EVIDENCE_MISMATCH');
 }else if(basis.maturityAt!==null)throw conflict('NONCOMMISSION_MATURITY_INVALID');
 if(funding.contractVersion!==LEGACY_DUTY_FINANCE_CONTRACT||funding.dutyId!==duty.id||funding.orderId!==duty.orderId||funding.kind!==duty.kind||funding.subjectId!==duty.counterpartyUserId
  ||funding.amountCents!==duty.amountCents||funding.currency!=='CNY'||funding.originalSourceSystem!=='legacy_mysql_restore'||funding.finalEvidenceDigest!==basis.evidenceDigest
  ||funding.originalSourceDigest!==(duty.kind==='COMMISSION'?basis.sourceRecordDigest:basis.parentSourceDigest)||funding.originalSourceEntity!==(duty.kind==='COMMISSION'?'la_distribution_order':'la_order')
  ||!/^[1-9]\d{0,23}$/.test(funding.originalSourceId)||funding.originalSourceId!==(duty.kind==='COMMISSION'?duty.sourceRecordId:basis.parentSourceId)
  ||funding.originalOrderNumber!==null&&(typeof funding.originalOrderNumber!=='string'||!funding.originalOrderNumber||funding.originalOrderNumber.length>255)
  ||funding.coverageDecision!=='NOT_PREVIOUSLY_CREDITED'||funding.sourceStatus!=='CONFIRMED_UNPAID_LIABILITY'||!digest.test(funding.coverageEvidenceDigest)||!funding.evidenceRef||funding.evidenceRef.length>512)throw conflict('DUTY_FUNDING_OR_NONREPEAT_PROOF_REQUIRED');
 const w=funding.witness;
 if(!w||!id.test(w.openingBasisId)||!digest.test(w.openingSourceDigest)||!digest.test(w.coveredSetDigest)||!id.test(w.historyCoverageVersion.split(':')[0]??'')||!digest.test(w.historyReferenceDigest)
  ||!/^(0|[1-9]\d{0,8})$/.test(w.sourceCount)||sha(canonicalize(w))!==funding.coverageEvidenceDigest)throw conflict('DUTY_FUNDING_WITNESS_REQUIRED');
 const canonical=canonicalize({contractVersion:LEGACY_DUTY_FINANCE_CONTRACT,duty,basis,funding}),factDigest=sha(canonical),rootId='legacy_duty_root_'+sha(duty.id).slice(0,40),eventId='legacy_duty_settled_'+sha(duty.id).slice(0,40);
 const positiveId='legacy_duty_cr_'+sha(duty.id).slice(0,40),zero=duty.amountCents==='0';
 return{canonical,factDigest,rootId,eventId,zero,ref:{type:zero?'FINANCE_EVENT':'LEDGER_ENTRY',id:zero?eventId:positiveId,digest:factDigest} as LegacyDutyRef,
  lines:zero?[]:[{id:'legacy_duty_dr_'+sha(duty.id).slice(0,40),line:1,account:duty.kind==='COMMISSION'?'DISTRIBUTION_EXPENSE':'LEGACY_LIABILITY_SOURCE',debit:duty.amountCents,credit:'0',subject:null},
   {id:positiveId,line:2,account:duty.kind==='RENTER_REFUND'?'RENTER_REFUND_PAYABLE':duty.kind==='OWNER_CREDIT'||duty.kind==='DEPOSIT_COMPENSATION'?'OWNER_AVAILABLE':'WALLET_AVAILABLE',debit:'0',credit:duty.amountCents,subject:duty.counterpartyUserId}]};
}

/** Verify complete immutable final facts; a raw FINANCE status or same ref id is insufficient. */
export function verifyLegacyDutyFinalization(duty:LegacyFinanceDuty,actual:{canonical:string;digest:string;rootId:string;eventId:string;eventKind:string;ref:LegacyDutyRef;lines:ReturnType<typeof planLegacyDutyFinalization>['lines']}):LegacyDutyFinalization{
 if(duty.settledBy==='LEGACY_RECORDS')return duty.settledRefType===null&&duty.settledRefId===null&&duty.settledRefDigest===null?'NONE':'UNKNOWN';
 if(duty.status!=='SETTLED'||duty.settledBy!=='FINANCE')return'UNKNOWN';
 try{
  if(sha(actual.canonical)!==actual.digest||actual.eventKind!=='LEGACY_DUTY_SETTLED')return'UNKNOWN';
  const original=JSON.parse(actual.canonical),p=planLegacyDutyFinalization(original.duty,original.basis,original.funding,{dutyId:duty.id,expectedRevision:original.duty.revision,expectedEvidenceDigest:original.basis.evidenceDigest,expectedAmountCents:duty.amountCents},original.basis.maturityAt??original.basis.sourceTime);
  const old=original.duty as LegacyFinanceDuty;
  if(old.orderId!==duty.orderId||old.sourceRecordId!==duty.sourceRecordId||old.kind!==duty.kind||old.counterpartyUserId!==duty.counterpartyUserId||old.currency!==duty.currency||old.maturityAt!==duty.maturityAt||old.source!==duty.source||old.sourceStatus!==duty.sourceStatus||old.continuationVersionId!==duty.continuationVersionId||old.admissionId!==duty.admissionId||BigInt(old.revision)+1n!==BigInt(duty.revision)
   ||p.factDigest!==actual.digest||p.rootId!==actual.rootId||p.eventId!==actual.eventId||canonicalize(actual.lines)!==canonicalize(p.lines)||canonicalize(actual.ref)!==canonicalize(p.ref)
   ||duty.settledRefType!==p.ref.type||duty.settledRefId!==p.ref.id||duty.settledRefDigest!==p.ref.digest)return'UNKNOWN';
  return p.zero?'FINALIZED_ZERO':duty.kind==='RENTER_REFUND'?'POSTED_POSITIVE_REFUND':'NONE';
 }catch{return'UNKNOWN';}
}
