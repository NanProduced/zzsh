import type {SettledContributionFact} from "../auth/membership-growth";
import {canonicalize} from "../supply/content-hash";
import {sha256Hex} from "../supply/supply-util";
import {legacyOwnerUserId} from "../supply/legacy-user-migration";
import {legacyEpochTimestamp} from "./legacy-order-read";
import {planLegacyContinuation,type LegacyCommand} from "./legacy-continuation-calc";
import {deriveLegacyFacts,legacyPlanYuanToCents,legacyTimeMicros,readSealedLegacyFacts,type LegacyContinuationActor,type LegacyEvidenceRow,type LegacyOrderBinding} from "./legacy-continuation-model";

type Proof={canonical:string;digest:string};
type Confirm={id:string;revision:string;createdAt:string;inputEvidenceId:string;resultEvidenceId:string;planFingerprint:string;actor:LegacyContinuationActor};
export type LegacyGrowthConsumptionInput={binding:LegacyOrderBinding;subjectUserId:string;recordedAt:string;origin:
  | {kind:"CONTINUATION_CONFIRM";command:Confirm;input:LegacyEvidenceRow;result:LegacyEvidenceRow;components?:Proof}
  | {kind:"LEGACY_COMPLETED"|"LEGACY_CANCELLED_UNCONSUMED";parentSourceSnapshot:Record<string,string|null>;sourceRecord:Proof;components:Proof}};
export type LegacyGrowthProjection={sourceKey:string;orderId:string;knowledge:"KNOWN"|"UNKNOWN"|"EXCLUDED";reason:string|null;facts:SettledContributionFact[];
  evidence:{parentSourceDigest:string;basisDigest:string|null;basisRef:string|null;componentDigest:string|null};observedResourceChargeCents:string|null};
const cents=(x:unknown)=>{if(typeof x!=="string" || !/^(0|[1-9]\d{0,23})$/.test(x))throw new Error("COMPONENT_AMOUNT_INVALID");return BigInt(x);};
const parsedProof=(p:Proof)=>{if(!p || p.canonical.length>262144 || sha256Hex(p.canonical)!==p.digest)throw new Error("SOURCE_EVIDENCE_INVALID");const value=JSON.parse(p.canonical) as Record<string,unknown>;if(!value || typeof value!=="object" || Array.isArray(value) || canonicalize(value)!==p.canonical)throw new Error("SOURCE_EVIDENCE_INVALID");return value;};
const sourceKey=(b:LegacyOrderBinding)=>`legacy_mysql_restore:la_order:${b.legacyId}`;
/** Pure source projection. The E caller owns authority, admitted extraction receipts and all growth persistence. */
export function projectLegacyGrowthConsumption(input:LegacyGrowthConsumptionInput,admittedComponentDigests?:ReadonlySet<string>,receipt?:LegacyGrowthCoverageReceipt):LegacyGrowthProjection{
  const b=input.binding,base={sourceKey:sourceKey(b),orderId:b.id,evidence:{parentSourceDigest:b.sourceDigest,basisDigest:null as string|null,basisRef:null as string|null,componentDigest:null as string|null},observedResourceChargeCents:null as string|null};
  const unknown=(reason:string):LegacyGrowthProjection=>({...base,knowledge:"UNKNOWN",reason,facts:[]});
  try{
    if(input.subjectUserId!==b.renterUserId || b.renterUserId!==legacyOwnerUserId("legacy_mysql_restore","la_user",b.legacyRenterId) || !/^[1-9]\d{0,23}$/.test(b.legacyId) || !/^[a-f0-9]{64}$/.test(b.sourceDigest) || b.id!=="legacy_order_"+sha256Hex(JSON.stringify(["legacy_mysql_restore","la_order",b.legacyId])).slice(0,40))return unknown("IDENTITY_SOURCE_UNMAPPED");
    if(b.sourcePayStatus===0){
      if(input.origin.kind!=="LEGACY_COMPLETED")return unknown("PAID_SOURCE_UNPROVEN");const o=input.origin,row=parsedProof(o.sourceRecord);
      if(row.pay_is!=="0" || row.id!==b.legacyId || row.user_id!==b.legacyRenterId || sha256Hex(canonicalize(o.parentSourceSnapshot))!==b.sourceDigest || Object.keys(o.parentSourceSnapshot).some(k=>row[k]!==o.parentSourceSnapshot[k]))return unknown("LEGACY_SOURCE_BINDING_CONFLICT");
      base.evidence.basisDigest=o.sourceRecord.digest;base.evidence.basisRef=sourceKey(b);return {...base,knowledge:"EXCLUDED",reason:"NOT_PAID",facts:[]};
    }
    if(b.sourcePayStatus!==1 || b.paidCents===null)return unknown("PAID_SOURCE_UNPROVEN");
    if(input.origin.kind==="LEGACY_CANCELLED_UNCONSUMED"){
      const o=input.origin,row=parsedProof(o.sourceRecord);
      if(b.sourceOrderStatus!==5 || b.completedAt!==null || row.order_status!=="5" || row.pay_is!=="1"
        || sha256Hex(canonicalize(o.parentSourceSnapshot))!==b.sourceDigest || Object.keys(o.parentSourceSnapshot).some(k=>row[k]!==o.parentSourceSnapshot[k])
        || row.id!==b.legacyId || row.user_id!==b.legacyRenterId || row.accounts_id!==b.legacyAccountId || row.sale_user_id!==b.legacyOwnerId)return unknown("LEGACY_SOURCE_BINDING_CONFLICT");
      if(!receipt || receipt.subjectUserId!==input.subjectUserId || !receipt.expectedSourceKeys.includes(base.sourceKey) || !Array.isArray(receipt.refundReviewEvidenceRefs))return unknown("CANCELLATION_SCOPE_UNPROVEN");
      if(!admittedComponentDigests?.has(o.components.digest))return unknown("COMPONENT_EVIDENCE_NOT_ADMITTED");
      const p=parsedProof(o.components),listed=(digest:string)=>receipt.refundReviewEvidenceRefs.some(ref=>ref===digest || ref.endsWith(`:${digest}`));
      if(p.schema!=="legacy-consumption-exclusion.v1" || p.classification!=="PAID_CANCELLED_UNCONSUMED" || p.parentSourceDigest!==b.sourceDigest || p.basisDigest!==o.sourceRecord.digest
        || p.legacyOrderId!==b.legacyId || p.subjectUserId!==input.subjectUserId || p.cutoff!==receipt.cutoff || typeof p.oldRuleEvidenceRef!=="string" || !p.oldRuleEvidenceRef || p.oldRuleEvidenceRef.length>512)return unknown("CANCELLATION_EVIDENCE_BINDING_CONFLICT");
      if(!listed(o.components.digest))return unknown("CANCELLATION_NOT_IN_RECEIPT_LINEAGE");
      const money=(v:unknown)=>{if(typeof v!=="string")throw new Error("CANCELLATION_AMOUNT_UNPROVEN");return cents(legacyPlanYuanToCents(v));};
      // This is an explicit unfulfilled-source class; NULL measurement/return is never converted into a zero amount.
      if(row.express_is!=="0" || row.is_settle!=="0" || row.express_time!==null&&row.express_time!=="0" || row.confirm_time!==null&&row.confirm_time!=="0"
        || row.expend_haff!==null || row.return_order_money!==null || money(row.expend_pay_money)!==0n)return unknown("CANCELLATION_NOT_UNCONSUMED");
      const paid=cents(b.paidCents);if(paid<=0n || money(row.pay_money)!==paid || money(row.need_pay_money)!==paid)return unknown("CANCELLATION_AMOUNT_CONFLICT");
      const rows:Record<string,unknown>[]=[],digests:string[]=[];
      for(const[field,entity]of [["payment","la_pay_order"],["refundRecord","la_refund_record"],["refundLog","la_refund_log"]] as const){
        const source=p[field] as Record<string,unknown>|undefined;
        if(!source || source.sourceSystem!=="legacy_mysql_restore" || source.sourceEntity!==entity || typeof source.extractSha256!=="string" || !/^[a-f0-9]{64}$/.test(source.extractSha256)
          || !Array.isArray(source.records) || source.records.length!==1)return unknown("CANCELLATION_SOURCE_EVIDENCE_INVALID");
        const proof=source.records[0] as Proof,record=parsedProof(proof);if(typeof record.id!=="string" || !/^[1-9]\d{0,23}$/.test(record.id))return unknown("CANCELLATION_SOURCE_EVIDENCE_INVALID");rows.push(record);digests.push(proof.digest);
      }
      const payment=rows[0]!,refund=rows[1]!,log=rows[2]!;
      if(!listed(digests[1]!) || !listed(digests[2]!))return unknown("CANCELLATION_NOT_IN_RECEIPT_LINEAGE");
      if(payment.order_type!=="1" || payment.pay_is!=="1" || payment.order_id!==b.legacyId || money(payment.pay_money)!==paid
        || refund.order_type!=="order" || refund.refund_type!=="1" || refund.refund_status!=="1" || refund.order_id!==b.legacyId || refund.user_id!==b.legacyRenterId
        || typeof row.order_sn!=="string" || !row.order_sn || refund.order_sn!==row.order_sn || log.record_id!==refund.id || log.user_id!==b.legacyRenterId || log.refund_status!=="1"
        || money(refund.order_amount)!==paid || money(refund.refund_amount)!==paid || money(log.order_amount)!==paid || money(log.refund_amount)!==paid)return unknown("CANCELLATION_REFUND_LINEAGE_CONFLICT");
      const instant=(v:unknown)=>{if(typeof v!=="string")throw new Error("CANCELLATION_TIME_UNPROVEN");const utc=legacyEpochTimestamp(v);if(!utc)throw new Error("CANCELLATION_TIME_UNPROVEN");return legacyTimeMicros(utc);};
      const cutoff=legacyTimeMicros(receipt.cutoff),recorded=legacyTimeMicros(input.recordedAt),payAt=instant(row.pay_time),cancelAt=instant(row.cancel_time),times=[payAt,cancelAt,instant(payment.pay_time),instant(refund.create_time),instant(refund.update_time),instant(log.create_time),instant(log.update_time)];
      if(cancelAt<payAt || instant(payment.pay_time)>cancelAt || times.some(t=>t>cutoff || t>recorded || t<payAt) || instant(refund.update_time)<instant(refund.create_time) || instant(log.update_time)<instant(log.create_time))return unknown("CANCELLATION_TIME_CONFLICT");
      base.evidence.basisDigest=o.sourceRecord.digest;base.evidence.basisRef=base.sourceKey;base.evidence.componentDigest=o.components.digest;
      return {...base,knowledge:"EXCLUDED",reason:"CANCELLED_UNCONSUMED",facts:[]};
    }
    let paid:bigint,returned:bigint,items:bigint|null=null,rental:bigint|null=null,minimum=0n,effectiveAt:string,version:string,revision:number,proof:Proof|undefined;
    if(input.origin.kind==="CONTINUATION_CONFIRM"){
      const o=input.origin,c=o.command,before=readSealedLegacyFacts(o.input),result=readSealedLegacyFacts(o.result),role=c.actor.realm==="user"?(c.actor.userId===b.ownerUserId?"owner":c.actor.userId===b.renterUserId?"renter":"other"):"admin";
      const cmd:LegacyCommand={kind:"confirm",caller:{role,legacyUserId:role==="owner"?b.legacyOwnerId:role==="renter"?b.legacyRenterId:""}},plan=planLegacyContinuation(before.evidence,cmd);
      if(!plan.ok || plan.fingerprint!==c.planFingerprint || o.result.sourceKind!=="DERIVED" || BigInt(o.result.evidenceVersion)!==BigInt(o.input.evidenceVersion)+1n || !/^[1-9]\d{0,17}$/.test(c.revision) || c.inputEvidenceId!==o.input.id || c.resultEvidenceId!==o.result.id || o.input.orderId!==b.id || o.result.orderId!==b.id || o.result.sourceDigest!==b.sourceDigest || o.input.sourceDigest!==b.sourceDigest
        || result.evidence.source.legacyOrderId!==b.legacyId || result.evidence.source.renterId!==b.legacyRenterId || result.evidence.source.orderStatus!=="4" || canonicalize(deriveLegacyFacts(before,plan,cmd,o.input.id,c.id))!==canonicalize(result))return unknown("CONFIRMED_RESULT_UNPROVEN");
      paid=BigInt(legacyPlanYuanToCents(result.evidence.source.payMoney!));returned=BigInt(legacyPlanYuanToCents(result.evidence.source.returnOrderMoney!));
      if(result.amounts.expendOrder!=null)items=BigInt(legacyPlanYuanToCents(result.amounts.expendOrder));
      effectiveAt=c.createdAt;version=c.id;revision=Number(c.revision);proof=o.components;base.evidence.basisDigest=o.result.factsDigest;base.evidence.basisRef=o.result.id;
    }else{
      const o=input.origin,row=parsedProof(o.sourceRecord);
      if(b.sourceOrderStatus!==4 || !b.completedAt)return unknown(b.sourceOrderStatus===3||b.sourceOrderStatus===8||b.sourceOrderStatus===9?"NOT_EFFECTIVELY_SETTLED":"LEGACY_SETTLEMENT_CLASSIFICATION_PENDING");
      if(sha256Hex(canonicalize(o.parentSourceSnapshot))!==b.sourceDigest || Object.keys(o.parentSourceSnapshot).some(k=>row[k]!==o.parentSourceSnapshot[k]) || row.id!==b.legacyId || row.user_id!==b.legacyRenterId || row.accounts_id!==b.legacyAccountId || row.sale_user_id!==b.legacyOwnerId || row.order_status!=="4" || row.pay_is!=="1")return unknown("LEGACY_SOURCE_BINDING_CONFLICT");
      const originalTime=legacyEpochTimestamp(row.confirm_time);if(!originalTime || legacyTimeMicros(originalTime)!==legacyTimeMicros(b.completedAt))return unknown("ORIGINAL_SETTLEMENT_TIME_UNPROVEN");
      paid=BigInt(legacyPlanYuanToCents(row.pay_money as string));returned=BigInt(legacyPlanYuanToCents(row.return_order_money as string));effectiveAt=b.completedAt;version="legacy-cutoff:"+o.sourceRecord.digest;revision=1;proof=o.components;base.evidence.basisDigest=o.sourceRecord.digest;base.evidence.basisRef=sourceKey(b);
    }
    if(paid.toString()!==b.paidCents || returned>paid)return unknown("RESOURCE_CHARGE_SOURCE_CONFLICT");
    const resource=paid-returned;base.observedResourceChargeCents=resource.toString();
    if(proof){
      if(!admittedComponentDigests?.has(proof.digest))return unknown("COMPONENT_EVIDENCE_NOT_ADMITTED");
      const p=parsedProof(proof);
      if(p.schema!=="legacy-consumption-components.v1" || p.parentSourceDigest!==b.sourceDigest || p.basisDigest!==base.evidence.basisDigest || p.legacyOrderId!==b.legacyId || typeof p.oldRuleEvidenceRef!=="string" || !p.oldRuleEvidenceRef || p.oldRuleEvidenceRef.length>512)return unknown("COMPONENT_EVIDENCE_BINDING_CONFLICT");
      rental=cents(p.rentalCents);items=cents(p.materialCents);minimum=cents(p.minimumBillingCents);
      if(minimum>0n && (typeof p.minimumAgreementRef!=="string" || !p.minimumAgreementRef))return unknown("MINIMUM_BILLING_AGREEMENT_UNPROVEN");
      if(rental+items+minimum!==resource)return unknown("COMPONENT_TOTAL_CONFLICT");base.evidence.componentDigest=proof.digest;
    }else{
      if(items===null)return unknown("ITEM_COMPONENT_NOT_FROZEN");
      if(items>resource)return unknown("COMPONENT_TOTAL_CONFLICT");rental=resource-items;
      // Old calc v1 has no independently booked minimum component; no extra minimum fact is invented.
    }
    if(!Number.isSafeInteger(revision) || revision<1)return unknown("SOURCE_REVISION_UNREPRESENTABLE");
    const utc6=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
    if(!utc6.test(effectiveAt) || !utc6.test(input.recordedAt) || legacyTimeMicros(input.recordedAt)<legacyTimeMicros(effectiveAt))return unknown("SOURCE_TIME_CONFLICT");
    const fact=(component:SettledContributionFact["component"],amount:bigint):SettledContributionFact=>({userId:b.renterUserId,settlementId:sourceKey(b),settlementVersion:version,component,effectiveAt,recordedAt:input.recordedAt,amountCents:amount.toString(),status:"SETTLED",revision});
    return {...base,knowledge:"KNOWN",reason:null,facts:[fact("RENTAL_SETTLEMENT",rental!),fact("MATERIAL_CONSUMPTION",items!),...(minimum>0n?[fact("MINIMUM_BILLING",minimum)]:[])]};
  }catch(error){const reason=error instanceof Error&&/^[A-Z_]{3,80}$/.test(error.message)?error.message:"SOURCE_EVIDENCE_INVALID";return unknown(reason);}
}

/** Effective price corrections use the original component/time, never channel success or deposit refunds as a proxy. */
export function projectLegacyGrowthCorrection(base:SettledContributionFact,proof:Proof,admittedCorrectionDigests:ReadonlySet<string>):SettledContributionFact{
  if(!admittedCorrectionDigests.has(proof.digest))throw new Error("CORRECTION_EVIDENCE_NOT_ADMITTED");const p=parsedProof(proof),key=`${base.component}:${base.settlementId}`;
  if(!["RENTAL_SETTLEMENT","MATERIAL_CONSUMPTION","MINIMUM_BILLING"].includes(base.component) || p.schema!=="legacy-growth-correction.v1" || p.originalSourceKey!==key || p.userId!==base.userId || p.originalEffectiveAt!==base.effectiveAt || p.previousAmountCents!==base.amountCents
    || p.classification!=="EFFECTIVE_PRICE_CORRECTION" || p.alreadyReflectedInGrossReturn!==false || typeof p.sourceSystem!=="string" || !p.sourceSystem || typeof p.sourceEntity!=="string" || !p.sourceEntity || typeof p.sourceId!=="string" || !p.sourceId || typeof p.recordedAt!=="string" || !Number.isSafeInteger(p.revision) || Number(p.revision)<=base.revision)throw new Error("CORRECTION_BINDING_CONFLICT");
  cents(p.correctedAmountCents);legacyTimeMicros(p.recordedAt);
  return {userId:base.userId,settlementId:`${p.sourceSystem}:${p.sourceEntity}:${p.sourceId}`,settlementVersion:proof.digest,component:"REFUND_CORRECTION",effectiveAt:base.effectiveAt,recordedAt:p.recordedAt,amountCents:p.correctedAmountCents as string,status:"SETTLED",revision:Number(p.revision),previousAmountCents:base.amountCents,correctionOf:key,correctionMode:"REPLACE"};
}
export type LegacyGrowthCoverageReceipt={subjectUserId:string;cutoff:string;fromExclusive:string|null;sourceExtractSha256:string;sourceSetSha256:string;expectedSourceKeys:string[];refundReviewEvidenceRefs:string[]};
/** A reviewed full-source receipt is required; observed rows and empty arrays cannot self-certify coverage. */
export function closeLegacyGrowthCoverage(subjectUserId:string,rows:readonly LegacyGrowthProjection[],receipt:LegacyGrowthCoverageReceipt|null,admittedReceiptDigests?:ReadonlySet<string>){
  const present=rows.map(r=>r.sourceKey),missing=receipt?.expectedSourceKeys.filter(k=>!present.includes(k))??null,unknown=rows.filter(r=>r.knowledge==="UNKNOWN").map(r=>({sourceKey:r.sourceKey,reason:r.reason}));
  const allFacts=rows.flatMap(r=>r.facts),base={subjectUserId,scope:receipt?{cutoff:receipt.cutoff,fromExclusive:receipt.fromExclusive}:null,presentSourceKeys:present,expectedSourceKeys:receipt?.expectedSourceKeys??null,missingSourceKeys:missing,unknown,facts:allFacts,outOfScopeFacts:[] as SettledContributionFact[]};
  if(!receipt)return {...base,state:"BACKFILL_PENDING" as const,reason:"FULL_SOURCE_RECEIPT_MISSING"};
  if(!admittedReceiptDigests?.has(sha256Hex(canonicalize(receipt))))return {...base,state:"BACKFILL_PENDING" as const,reason:"SOURCE_COVERAGE_NOT_ADMITTED"};
  const expectedSetDigest=sha256Hex(canonicalize({subjectUserId,cutoff:receipt.cutoff,fromExclusive:receipt.fromExclusive,expectedSourceKeys:[...receipt.expectedSourceKeys].sort()}));
  if(receipt.subjectUserId!==subjectUserId || allFacts.some(f=>f.userId!==subjectUserId) || !/^[a-f0-9]{64}$/.test(receipt.sourceExtractSha256) || receipt.sourceSetSha256!==expectedSetDigest || !receipt.refundReviewEvidenceRefs.length || new Set(receipt.expectedSourceKeys).size!==receipt.expectedSourceKeys.length || new Set(present).size!==present.length || present.some(k=>!receipt.expectedSourceKeys.includes(k)))return {...base,state:"SOURCE_CONFLICT" as const,reason:"SOURCE_COVERAGE_CONFLICT"};
  legacyTimeMicros(receipt.cutoff);if(receipt.fromExclusive!==null && legacyTimeMicros(receipt.fromExclusive)>=legacyTimeMicros(receipt.cutoff))throw new Error("SOURCE_RANGE_INVALID");
  const inScope=(f:SettledContributionFact)=>legacyTimeMicros(f.effectiveAt)<=legacyTimeMicros(receipt.cutoff) && (receipt.fromExclusive===null || legacyTimeMicros(f.effectiveAt)>legacyTimeMicros(receipt.fromExclusive));
  return {...base,facts:allFacts.filter(inScope),outOfScopeFacts:allFacts.filter(f=>!inScope(f)),state:missing!.length||unknown.length?"BACKFILL_PENDING" as const:"COMPLETE" as const,reason:missing!.length||unknown.length?"SOURCE_FACTS_PENDING":null};
}
