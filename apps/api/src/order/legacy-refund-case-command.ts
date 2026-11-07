import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {SecurityApiError,recordAudit} from '../auth/security-core';
import {readAdminLegacyDutyFinances} from '../finance/legacy-duty-finance-store';
import {canonicalize} from '../supply/content-hash';
import {conflict,invalid,notFound} from '../supply/supply-util';
import {authorizeLegacyFinanceDuty,postLegacyFinanceDuty} from './legacy-finance-duty';
import {readLegacyRefundReview,readLegacyRefundReviewEvidence,recordLegacyRefundReview,type LegacyRefundReviewCommand} from './legacy-refund-review-store';
import {assertRefundBinding,assertRefundStart,describeRefundProfile,type BoundRefundProfile,type FormalRefundAdmission} from './joinpay-refund-profile';
import {LEGACY_REFUND_REASON} from './legacy-refund-review';
import type {LegacyContinuationActor} from './legacy-continuation-model';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type LegacyRefundCaseReceipt={caseId:string;orderId:string;dutyId:string;intentId:string|null;refundOrderNo:string|null;
  dutyCents:string;priorAppliedCents:string;amountCents:string;channelResultAtCreation:'NOT_SUBMITTED'};

/** Caller has an idempotent transaction; this records a liability and intent, never a channel result. */
export async function createLegacyRefundCase(client:PoolClient,actor:LegacyContinuationActor,input:LegacyRefundReviewCommand,
  execution:{admission:FormalRefundAdmission;profile:BoundRefundProfile}):Promise<{status:200;body:LegacyRefundCaseReceipt}>{
  if(actor.realm!=='admin')throw notFound();
  const ready=(await client.query<{ready:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.legacy_refund_case')
    WHERE p.oid=to_regprocedure('zzsh_order.create_legacy_refund_case(text)') AND p.proowner=c.relowner AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog'] AND has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.legacy_refund_review_resolution')
      WHERE p.oid=to_regprocedure('zzsh_order.resume_legacy_refund_review(text,text)') AND p.proowner=c.relowner AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=pg_catalog'] AND has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.legacy_refund_retry_authorization')
      WHERE p.oid=to_regprocedure('zzsh_order.retry_legacy_refund(text,text,text)') AND p.proowner=c.relowner AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=pg_catalog'] AND has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.legacy_refund_terminal_resolution')
      WHERE p.oid=to_regprocedure('zzsh_order.resolve_legacy_refund_terminal(text,text,text)') AND p.proowner=c.relowner AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=pg_catalog'] AND has_function_privilege(current_user,p.oid,'EXECUTE'))
    AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('zzsh_order.legacy_refund_case_unreleased_once') AND indisvalid AND indisready AND indisunique)
    AND to_regclass('zzsh_order.legacy_refund_intent') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('zzsh_order.legacy_refund_observation_number_idx') AND indisvalid AND indisready)
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.payment_request') AND t.tgname='legacy_payment_order_number_guard'
      AND t.tgenabled IN('O','A') AND NOT t.tgisinternal AND t.tgfoid=to_regprocedure('zzsh_order.guard_legacy_payment_order_number()')
      AND position('zzsh:legacy-original-order-no:v1' in pg_get_functiondef(t.tgfoid))>0)
    AND NOT EXISTS(SELECT 1 FROM (VALUES('legacy_native_request_number_idx'),('legacy_native_confirmation_number_idx'),('legacy_native_refund_number_idx')) x(name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('zzsh_order.'||x.name) AND indisvalid AND indisready))
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('zzsh_order.legacy_refund_case','legacy_refund_case_guard','zzsh_order.guard_legacy_refund_case()'),
      ('zzsh_order.legacy_refund_case','legacy_refund_case_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_case','legacy_refund_case_complete','zzsh_order.check_legacy_refund_case_complete()'),
      ('zzsh_order.legacy_refund_intent','legacy_refund_intent_guard','zzsh_order.guard_legacy_refund_intent()'),
      ('zzsh_order.legacy_refund_intent','legacy_refund_intent_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_intent','legacy_refund_intent_complete','zzsh_order.check_legacy_refund_case_complete()'),
      ('zzsh_order.legacy_refund_attempt','legacy_refund_attempt_guard','zzsh_order.guard_legacy_refund_attempt()'),
      ('zzsh_order.legacy_refund_attempt','legacy_refund_attempt_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_observation','legacy_refund_observation_guard','zzsh_order.guard_legacy_refund_observation()'),
      ('zzsh_order.legacy_refund_observation','legacy_refund_observation_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_terminal_evidence','legacy_refund_terminal_guard','zzsh_order.guard_legacy_refund_terminal()'),
      ('zzsh_order.legacy_refund_terminal_evidence','legacy_refund_terminal_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_review_resolution','legacy_refund_review_resolution_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_terminal_resolution','legacy_refund_terminal_resolution_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.legacy_refund_retry_authorization','legacy_refund_retry_authorization_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.joinpay_refund_evidence','zz_legacy_refund_transaction_guard','zzsh_order.guard_native_refund_against_legacy_transaction()'),
      ('zzsh_order.legacy_refund_intent','legacy_refund_terminal_intent_complete','zzsh_order.check_legacy_refund_terminal_complete()'),
      ('zzsh_order.finance_event','legacy_refund_history_event_guard','zzsh_order.guard_legacy_refund_history()'),
      ('zzsh_order.finance_event','legacy_refund_history_event_complete','zzsh_order.check_legacy_refund_case_complete()'),
      ('zzsh_order.finance_event','legacy_refund_history_revision','zzsh_order.withdrawal_wallet_revision()'),
      ('zzsh_order.finance_event','legacy_refund_paid_event_guard','zzsh_order.guard_legacy_refund_paid()'),
      ('zzsh_order.finance_event','legacy_refund_paid_event_complete','zzsh_order.check_legacy_refund_terminal_complete()'),
      ('zzsh_order.finance_event','legacy_refund_paid_revision','zzsh_order.withdrawal_wallet_revision()'),
      ('zzsh_order.settlement_ledger_entry','legacy_refund_history_entry_guard','zzsh_order.guard_legacy_refund_history()'),
      ('zzsh_order.settlement_ledger_entry','legacy_refund_history_entry_complete','zzsh_order.check_legacy_refund_case_complete()'),
      ('zzsh_order.settlement_ledger_entry','legacy_refund_paid_entry_guard','zzsh_order.guard_legacy_refund_paid()'),
      ('zzsh_order.settlement_ledger_entry','legacy_refund_paid_entry_complete','zzsh_order.check_legacy_refund_terminal_complete()')
    ) required(relation,name,procedure) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(required.relation)
      AND t.tgname=required.name AND t.tgfoid=to_regprocedure(required.procedure) AND t.tgenabled IN('O','A') AND NOT t.tgisinternal))
    AND NOT EXISTS(SELECT 1 FROM (VALUES('finance_entry_guard'),('finance_entry_batch_guard')) required(name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.settlement_ledger_entry') AND t.tgname=required.name
        AND t.tgenabled IN('O','A') AND NOT t.tgisinternal AND position('legacyRefundCaseId' in pg_get_triggerdef(t.oid))>0
        AND position('legacyRefundIntentId' in pg_get_triggerdef(t.oid))>0)) AS ready`)).rows[0]?.ready;
  if(ready!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy refund case is unavailable');
  const reviewed=await recordLegacyRefundReview(client,actor,input,execution);
  if(reviewed.refundCents!=='0'){
    assertRefundStart(execution.admission);const profile=describeRefundProfile(execution.profile,'SUBMIT');
    const caseId='legacy_refund_case_'+sha(input.dutyId).slice(0,40),refundOrderNo='LR'+sha(caseId).slice(0,28);
    assertRefundBinding(execution.profile,'SUBMIT',{merchantNo:profile.merchantNo,merchantIdentityId:profile.merchantIdentityId,
      originalPaymentOrderNo:input.paymentOrderNo,refundOrderNo,amountCents:reviewed.refundCents,currency:'CNY',notifyUrl:profile.notifyUrl,
      profileId:profile.profileId,initialProfileSha256:profile.profileSha256,keyVersionRef:profile.keyVersionRef,reason:LEGACY_REFUND_REASON,
      ...(profile.fundsAccount?{fundsAccount:profile.fundsAccount}:{})});
  }
  const authority=await authorizeLegacyFinanceDuty(client,actor,input.orderId,'RENTER_REFUND');
  const liability=await postLegacyFinanceDuty(client,actor,input.orderId,'RENTER_REFUND',
    {dutyId:input.dutyId,expectedRevision:input.expectedDutyRevision,reason:'客服核对旧单退款责任'},authority);
  const audits=(await client.query<{id:string}>(`SELECT id FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed'
    AND object_type='legacy_order_duty' AND object_id=$1 AND actor_type='admin' AND actor_id=$2 AND session_id=$3 AND request_id=$4
    AND outcome='SUCCESS' AND details->>'reviewId'=$5 AND details->>'reviewDigest'=$6 ORDER BY occurred_at,id LIMIT 2`,
    [input.dutyId,actor.userId,actor.sessionId,actor.requestId,reviewed.reviewId,reviewed.reviewDigest])).rows;
  if(audits.length!==1)throw conflict('LEGACY_REFUND_REVIEW_INVALID');
  const result=(await client.query<{result:Record<string,unknown>}>(`SELECT zzsh_order.create_legacy_refund_case($1) AS result`,[audits[0]!.id])).rows[0]?.result;
  if(!result || result.dutyId!==input.dutyId || result.amountCents!==reviewed.refundCents || result.priorAppliedCents!==input.priorAppliedToDutyCents
    || BigInt(liability.body.amountCents)!==BigInt(input.priorAppliedToDutyCents)+BigInt(reviewed.refundCents)
    || result.channelResult!=='NOT_SUBMITTED' || typeof result.caseId!=='string')throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  await recordAudit(client,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
    action:'order.legacy.refund.case_created',objectType:'legacy_order_duty',objectId:input.dutyId,outcome:'SUCCESS',
    details:{orderId:input.orderId,caseId:result.caseId,reviewId:reviewed.reviewId,channelResult:'NOT_SUBMITTED'}});
  return {status:200,body:await readLegacyRefundCaseReceipt(client,actor,input.orderId,input.dutyId,result.caseId)};
}

async function verifyLegacyRefundCase(client:PoolClient,actor:LegacyContinuationActor|null,orderId:string,dutyId:string,caseId:string,selectedIntent:'INITIAL'|'LATEST'|string){
  if(actor!==null && actor.realm!=='admin' || ![orderId,dutyId,caseId].every(value=>typeof value==='string'&&ID.test(value)))throw invalid('Invalid legacy refund case reference');
  const rows=(await client.query<any>(`SELECT x.id,x.order_id,x.duty_id,x.review_audit_id,x.review_digest,x.renter_user_id,x.merchant_identity_id,x.merchant_no,
    x.original_payment_order_no,x.original_payment_record_id,x.paid_cents::text,x.duty_cents::text,x.previously_refunded_cents::text,
    x.prior_applied_cents::text,x.new_refund_cents::text,x.source_digest,x.duty_fact_digest,x.history_event_id,
    a.details->>'reviewId' AS review_id,i.id AS intent_id,i.generation AS intent_generation,i.retry_of_id,i.refund_order_no,i.amount_cents::text AS intent_amount,i.state AS intent_state,
    i.initial_admission_ref,i.initial_admission_sha256,i.initial_admission_canonical,i.initial_profile_id,i.initial_profile_sha256,
    i.initial_profile_canonical,i.initial_key_version_ref,i.notify_url,i.funds_account,
    f.root_id,f.facts_digest AS stored_fact_digest,e.kind AS history_kind,e.economic_root_id AS history_root,e.subject_user_id AS history_subject,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('line',l.line_no,'account',l.account_code,'debit',l.debit_cents::text,'credit',l.credit_cents::text,
      'subject',l.counterparty_user_id,'details',l.details) ORDER BY l.line_no) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=x.history_event_id),'[]'::jsonb) AS lines
    FROM zzsh_order.legacy_refund_case x JOIN zzsh_iam.audit_event a ON a.id=x.review_audit_id
    JOIN zzsh_order.legacy_duty_finance_fact f ON f.duty_id=x.duty_id LEFT JOIN LATERAL (
      SELECT * FROM zzsh_order.legacy_refund_intent candidate WHERE candidate.case_id=x.id
        AND ($4::text='LATEST' OR $4::text='INITIAL' AND candidate.generation=1 OR candidate.id=$4)
      ORDER BY candidate.generation DESC LIMIT 1) i ON true
    LEFT JOIN zzsh_order.finance_event e ON e.id=x.history_event_id WHERE x.id=$1 AND x.order_id=$2 AND x.duty_id=$3 LIMIT 2`,[caseId,orderId,dutyId,selectedIntent])).rows;
  if(rows.length!==1)throw notFound();const r=rows[0];
  if(typeof r.review_id!=='string' || !ID.test(r.review_id))throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  const review=actor ? await readLegacyRefundReview(client,actor,orderId,dutyId,r.review_id) : await readLegacyRefundReviewEvidence(client,orderId,dutyId,r.review_id);
  const duty=(await readAdminLegacyDutyFinances(client,{dutyId})).get(dutyId);
  const suffix=sha(caseId),expectedCase='legacy_refund_case_'+sha(dutyId).slice(0,40);
  const intentSuffix=r.intent_generation===1?suffix:sha(caseId+':retry:'+String(r.intent_generation));
  const expectedIntent='legacy_refund_intent_'+intentSuffix.slice(0,40),expectedNo='LR'+intentSuffix.slice(0,28);
  const amounts=[r.paid_cents,r.duty_cents,r.previously_refunded_cents,r.prior_applied_cents,r.new_refund_cents];
  if(amounts.some(value=>typeof value!=='string'||!/^(0|[1-9]\d{0,23})$/.test(value)))throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  const [paid,total,prior,applied,remaining]=amounts.map(value=>BigInt(value)) as [bigint,bigint,bigint,bigint,bigint];
  if(caseId!==expectedCase || review.reviewDigest!==r.review_digest || review.sourceDigest!==r.source_digest
    || review.merchantIdentityId!==r.merchant_identity_id || review.merchantNo!==r.merchant_no || review.paymentOrderNo!==r.original_payment_order_no
    || review.paymentRecordId!==r.original_payment_record_id || review.paidCents!==r.paid_cents || review.dutyCents!==r.duty_cents
    || review.previouslyRefundedCents!==r.previously_refunded_cents || review.priorAppliedToDutyCents!==r.prior_applied_cents || review.refundCents!==r.new_refund_cents
    || prior>paid || applied>prior || applied>total || remaining!==total-applied || remaining>paid-prior
    || !duty || duty.knowledge!=='KNOWN' || duty.kind!=='RENTER_REFUND' || duty.orderId!==orderId || duty.subjectId!==r.renter_user_id
    || duty.amountCents!==r.duty_cents || duty.parentSourceDigest!==r.source_digest || duty.reference?.digest!==r.duty_fact_digest || r.stored_fact_digest!==r.duty_fact_digest)
    throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  const expectedLines=applied===0n?[]:[
    {line:1,account:'RENTER_REFUND_PAYABLE',debit:r.prior_applied_cents,credit:'0',subject:r.renter_user_id,details:{legacyRefundCaseId:caseId,reviewDigest:r.review_digest}},
    {line:2,account:'LEGACY_LIABILITY_SOURCE',debit:'0',credit:r.prior_applied_cents,subject:null,details:{legacyRefundCaseId:caseId,reviewDigest:r.review_digest}},
  ];
  const historyMatches=applied===0n ? r.history_event_id===null && r.history_kind===null : r.history_event_id==='legacy_refund_history_'+suffix.slice(0,40)
    && r.history_kind==='LEGACY_REFUND_HISTORY_OFFSET' && r.history_root===r.root_id && r.history_subject===r.renter_user_id;
  if(!historyMatches || canonicalize(r.lines)!==canonicalize(expectedLines))throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  if(remaining===0n ? r.intent_id!==null || r.refund_order_no!==null || r.intent_state!==null
    : !Number.isSafeInteger(r.intent_generation) || r.intent_generation<1 || r.intent_id!==expectedIntent || r.refund_order_no!==expectedNo || r.intent_amount!==r.new_refund_cents
      || !['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.intent_state)
      || typeof r.initial_admission_canonical!=='string' || sha(r.initial_admission_canonical)!==r.initial_admission_sha256
      || typeof r.initial_profile_canonical!=='string' || sha(r.initial_profile_canonical)!==r.initial_profile_sha256
      || review.admissionRef!==r.initial_admission_ref || review.admissionSha256!==r.initial_admission_sha256 || review.admissionCanonical!==r.initial_admission_canonical
      || review.profileId!==r.initial_profile_id || review.profileSha256!==r.initial_profile_sha256 || review.profileCanonical!==r.initial_profile_canonical
      || review.keyVersionRef!==r.initial_key_version_ref || review.notifyUrl!==r.notify_url || review.fundsAccount!==r.funds_account)throw conflict('LEGACY_REFUND_CASE_MISMATCH');
  let chainReview=false,blockedBy:{intentId:string;refundOrderNo:string;generation:number}|null=null;
  if(r.intent_id){
    const chain=(await client.query<any>(`WITH RECURSIVE chain AS (
      SELECT id,case_id,generation,retry_of_id,state,budget_disposition,requires_review,terminal_evidence_id,refund_order_no FROM zzsh_order.legacy_refund_intent WHERE id=$1
      UNION ALL SELECT parent.id,parent.case_id,parent.generation,parent.retry_of_id,parent.state,parent.budget_disposition,parent.requires_review,parent.terminal_evidence_id,parent.refund_order_no
        FROM zzsh_order.legacy_refund_intent parent JOIN chain child ON parent.id=child.retry_of_id AND parent.case_id=child.case_id AND parent.generation=child.generation-1)
      SELECT chain.*,auth.id AS retry_authorization_id,auth.case_id AS authorized_case_id,auth.previous_intent_id,auth.next_intent_id,auth.generation AS authorized_generation,
        auth.previous_evidence_id,auth.previous_evidence_digest,auth.confirmed_refunded_cents::text,
        proof.terminal AS previous_terminal,proof.facts_digest AS previous_digest
      FROM chain LEFT JOIN zzsh_order.legacy_refund_retry_authorization auth ON auth.next_intent_id=chain.id
      LEFT JOIN zzsh_order.legacy_refund_terminal_evidence proof ON proof.id=auth.previous_evidence_id ORDER BY chain.generation DESC`,[r.intent_id])).rows;
    if(chain.length!==r.intent_generation)throw conflict('LEGACY_REFUND_RETRY_CHAIN_INVALID');
    for(let index=0;index<chain.length;index++){
      const item=chain[index]!,generation=r.intent_generation-index,hash=generation===1?suffix:sha(caseId+':retry:'+generation);
      if(item.case_id!==caseId||item.generation!==generation||item.id!=='legacy_refund_intent_'+hash.slice(0,40)||item.refund_order_no!=='LR'+hash.slice(0,28))throw conflict('LEGACY_REFUND_RETRY_CHAIN_INVALID');
      if(index>0 && (item.state!=='FAILED'||item.budget_disposition!=='RELEASED'))throw conflict('LEGACY_REFUND_RETRY_CHAIN_INVALID');
      if(index>0 && item.requires_review){chainReview=true;blockedBy={intentId:item.id,refundOrderNo:item.refund_order_no,generation};}
      if(generation===1 ? item.retry_of_id!==null||item.retry_authorization_id!==null : !chain[index+1] || item.retry_of_id!==chain[index+1].id
        || item.authorized_case_id!==caseId || item.previous_intent_id!==chain[index+1].id || item.next_intent_id!==item.id || item.authorized_generation!==generation
        || item.previous_evidence_id!==chain[index+1].terminal_evidence_id || item.previous_terminal!=='FAILED_NO_EXECUTION'
        || item.previous_evidence_digest!==item.previous_digest || item.confirmed_refunded_cents!==r.previously_refunded_cents)throw conflict('LEGACY_REFUND_RETRY_CHAIN_INVALID');
    }
  }
  return {row:r,review,chainReview,blockedBy};
}

/** A stored request is readable only after rechecking its source, liability and historical offset. */
export async function readLegacyRefundCaseReceipt(client:PoolClient,actor:LegacyContinuationActor,orderId:string,dutyId:string,caseId:string):Promise<LegacyRefundCaseReceipt>{
  const {row:r}=await verifyLegacyRefundCase(client,actor,orderId,dutyId,caseId,'INITIAL');
  return {caseId,orderId,dutyId,intentId:r.intent_id,refundOrderNo:r.refund_order_no,dutyCents:r.duty_cents,
    priorAppliedCents:r.prior_applied_cents,amountCents:r.new_refund_cents,channelResultAtCreation:'NOT_SUBMITTED'};
}

/** Worker-only verification under the shared original-payment lock; it never authorizes an HTTP caller. */
export async function readLegacyRefundCaseForExecution(client:PoolClient,orderId:string,dutyId:string,caseId:string,intentId:string){
  const {row,review,chainReview}=await verifyLegacyRefundCase(client,null,orderId,dutyId,caseId,intentId);
  if(!row.intent_id)throw conflict('LEGACY_REFUND_NO_NEW_PAYMENT');
  return {row,review,chainReview};
}

/** Internal projection after the order reader has checked the actual participant. */
export async function readLegacyRefundCaseForStatus(client:PoolClient,orderId:string,dutyId:string,caseId:string){
  const {row,chainReview,blockedBy}=await verifyLegacyRefundCase(client,null,orderId,dutyId,caseId,'LATEST');
  return {intentId:row.intent_id as string|null,refundOrderNo:row.refund_order_no as string|null,generation:row.intent_generation as number|null,
    amountCents:row.new_refund_cents as string,dutyCents:row.duty_cents as string,priorAppliedCents:row.prior_applied_cents as string,
    previouslyRefundedCents:row.previously_refunded_cents as string,chainReview,blockedBy};
}
