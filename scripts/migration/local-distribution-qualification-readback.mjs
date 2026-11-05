import assert from 'node:assert/strict';

/** Independently verify the original per-batch idempotency and audit receipts in one read-only snapshot. */
export async function verifyQualificationReceipts(client,{plan,actorId,sourceDigest},fingerprintRequest){
  assert(typeof actorId==='string'&&actorId&&Array.isArray(plan.batches),'QUALIFICATION_READBACK_ACTOR_REQUIRED');
  if(!plan.batches.length)return{batches:0,participants:0};
  const operation='distribution.legacy-qualification.v1',scope=JSON.stringify(['admin',actorId,operation,null]);
  const byKey=new Map(plan.batches.map(batch=>['legacy-qualification-'+batch.bodyDigest,batch]));
  assert.equal(byKey.size,plan.batches.length,'QUALIFICATION_RECEIPT_DUPLICATE_BATCH');
  const records=(await client.query(`SELECT key,request_fingerprint AS fingerprint,response_status AS status,response_body AS body
    FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])`,[scope,[...byKey.keys()]])).rows;
  assert.equal(records.length,plan.batches.length,'QUALIFICATION_IDEMPOTENCY_RECEIPTS_MISSING');
  const seen=new Set();
  for(const row of records){
    const batch=byKey.get(row.key);assert(batch&&!seen.has(row.key),'QUALIFICATION_IDEMPOTENCY_RECEIPT_CONFLICT');seen.add(row.key);
    assert(row.fingerprint===fingerprintRequest(operation,undefined,{bodyDigest:batch.bodyDigest})&&row.status===200&&row.body?.bodyDigest===batch.bodyDigest&&row.body?.policyId===plan.policyId&&row.body?.participants===batch.body.subjects.length&&row.body?.financialEffects===false,'QUALIFICATION_IDEMPOTENCY_RECEIPT_DIFFERS');
  }
  const audits=(await client.query(`SELECT details FROM zzsh_iam.audit_event WHERE actor_type='admin' AND actor_id=$1 AND action='distribution.legacy_qualification.admitted'
    AND object_type='distribution_policy_version' AND object_id=$2 AND outcome='SUCCESS' AND details->>'bodyDigest'=ANY($3::text[])`,[actorId,plan.policyId,plan.batches.map(batch=>batch.bodyDigest)])).rows;
  assert.equal(audits.length,plan.batches.length,'QUALIFICATION_AUDIT_RECEIPTS_MISSING');
  const auditSeen=new Set();
  for(const row of audits){
    const d=row.details,batch=byKey.get('legacy-qualification-'+d?.bodyDigest);
    assert(batch&&!auditSeen.has(d.bodyDigest)&&d.sourceDigest===sourceDigest&&d.participants===batch.body.subjects.length&&d.financialEffects===false&&typeof d.reviewRef==='string'&&d.reviewRef&&typeof d.attempt==='string'&&d.attempt,'QUALIFICATION_AUDIT_RECEIPT_DIFFERS');
    auditSeen.add(d.bodyDigest);
  }
  return{batches:records.length,participants:plan.batches.reduce((sum,batch)=>sum+batch.body.subjects.length,0)};
}
