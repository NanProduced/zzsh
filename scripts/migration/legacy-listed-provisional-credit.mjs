/** Read-only prequote classification; never turns UNKNOWN into an allowed/satisfied guarantee. */
export async function inspectDeferredLegacyCredit(client,{account,version,raw,gate,readGuaranteeContext,threshold,lockRows=false}){
 if(!account||!version||!raw||!Number.isSafeInteger(threshold)||gate?.occupancy!=='FREE'||gate.rentalCompleted===true
  ||gate.publisherBail!=='UNKNOWN'||gate.creditGuarantee?.status!=='UNKNOWN'
  ||version.id!==account.current_version_id||version.origin!=='LEGACY_OBSERVATION'||version.review_state!=='IMPORTED_UNVERIFIED'
  ||version.payload!==null||version.rule_release_id!==null||raw.status!=='3'||raw.is_delete!=='0')return null;
 if(lockRows)await assertDeferredLocks(client);
 const suffix=lockRows?' FOR SHARE':'';
 const credit=(await client.query(`SELECT score,revision::text revision FROM zzsh_credit.user_credit_state WHERE user_id=$1${suffix}`,[account.owner_user_id])).rows[0];
 if(!credit||!Number.isSafeInteger(credit.score)||credit.score<threshold||!/^[1-9]\d*$/.test(credit.revision??''))return null;
 const context=await readGuaranteeContext(client,account.id,account.owner_user_id);
 if(!context||context.accountId!==account.id||context.ownerUserId!==account.owner_user_id||context.versionId!==null||context.state!=='UNKNOWN'||context.reasonCode!=='STANDARD_QUOTE_UNAVAILABLE'||context.score!==credit.score||context.creditRevision!==credit.revision)return null;
 if(!await noLegacyGuaranteeHistory(client,account.id,lockRows))return null;
 return {kind:'FROZEN_QUOTE_REQUIRED',creditRevision:credit.revision};
}
async function assertDeferredLocks(client){
 const locks=(await client.query(`SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND mode='ShareLock' AND relation=ANY(ARRAY['zzsh_order.owner_guarantee_requirement'::regclass,'zzsh_supply.account_guarantee_proof'::regclass,'zzsh_supply.game_service_operation'::regclass,'zzsh_order.rental_order'::regclass,'zzsh_credit.user_credit_state'::regclass])`)).rows[0];
 if(locks?.n!==5)throw new Error('DEFERRED_GUARANTEE_TABLE_LOCKS_REQUIRED');
}
export async function noLegacyGuaranteeHistory(client,accountId,lockRows=false){
 if(lockRows)await assertDeferredLocks(client);const suffix=lockRows?' FOR SHARE':'';
 const obligations=(await client.query(`SELECT id FROM zzsh_order.owner_guarantee_requirement WHERE account_id=$1${suffix}`,[accountId])).rows;
 const proofs=(await client.query(`SELECT id FROM zzsh_supply.account_guarantee_proof WHERE account_id=$1${suffix}`,[accountId])).rows;
 const financial=(await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id WHERE r.account_id=$1) AS payment_exists,EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_refund f JOIN zzsh_order.owner_guarantee_requirement r ON r.id=f.requirement_id WHERE r.account_id=$1) AS refund_exists`,[accountId])).rows[0];
 return obligations.length===0&&proofs.length===0&&financial?.payment_exists===false&&financial?.refund_exists===false;
}
/** Only in the dedicated exclusive maintenance window; before the transaction's first SELECT. */
export async function lockDeferredLegacyCreditTables(client){
 await client.query('LOCK TABLE zzsh_order.owner_guarantee_requirement, zzsh_supply.account_guarantee_proof, zzsh_supply.game_service_operation, zzsh_order.rental_order, zzsh_credit.user_credit_state IN SHARE MODE');
}

export function requiresFullRollbackTrial(action,input,rows){
 return action==='--execute' && (Boolean(input.roundBinding)||rows.some(row=>Boolean(row.deferredCredit)));
}

/** A forged prior-version field cannot bypass the source observation precheck. */
export function rejectUnmarkedObservation(row,gate){
 return async(client,account,purpose)=>{
  if(account.current_version_id===row.body.intake.source.expectedObservationVersionId)throw new Error('DEFERRED_CREDIT_PLAN_REQUIRED');
  return gate(client,account,purpose);
 };
}

/** Wrap only this controlled takeover; leave every actual business gate unchanged. */
export function deferredCreditGateForRow(row,{gate,readCurrentVersion,readPublishingAccount,readGuaranteeContext,threshold}){
 let checked=false;
 return {
  gate:async(c,account,purpose)=>{
   const observed=await gate(c,account,purpose);
   if(account.current_version_id===row.body.intake.source.expectedObservationVersionId){
    const version=await readCurrentVersion(c,account),raw=JSON.parse(row.body.intake.legacyQuoteEvidence.sourceCanonical);
    const proof=await inspectDeferredLegacyCredit(c,{account,version,raw,gate:observed,readGuaranteeContext,threshold,lockRows:true});
    if(!proof||proof.creditRevision!==row.deferredCredit.creditRevision)throw new Error('DEFERRED_CREDIT_STATE_CHANGED');
    checked=true;
   }
   return observed;
  },
  assertReady:async(client,replayed)=>{
   if(!checked&&!replayed)throw new Error('DEFERRED_CREDIT_PRECHECK_NOT_PERFORMED');
   if(!await noLegacyGuaranteeHistory(client,row.body.intake.accountId,true))throw new Error('DEFERRED_GUARANTEE_HISTORY_CHANGED');
   const current=await readPublishingAccount(client,row.body.intake.accountId),finalGate=await gate(client,current,'WRITE');
   if(finalGate.occupancy!=='FREE'||finalGate.rentalCompleted||finalGate.publisherBail!=='NOT_REQUIRED'||finalGate.creditGuarantee?.status!=='NOT_REQUIRED'
    ||finalGate.creditGuarantee.creditRevision!==row.deferredCredit.creditRevision||finalGate.creditGuarantee.requiredCents!=='0'||!finalGate.reference)
    throw new Error('FINAL_CREDIT_GUARANTEE_NOT_READY');
  },
 };
}
