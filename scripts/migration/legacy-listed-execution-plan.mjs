import { createHash } from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Check the complete reviewed batch before any per-account transaction is allowed to start. */
export function validateLegacyListedExecutionPlan(input,target,compiled,canonicalize,binding) {
  const fail=()=>{throw new Error('EXECUTION_PLAN_BINDING_CHANGED');};
  if(!input || input.schema!=='zzsh.legacy-listed-execution-plan.v2' || canonicalize(input.target)!==canonicalize(target)
    || canonicalize(input.compiled)!==canonicalize(compiled) || !Array.isArray(input.rows)
    || !Number.isSafeInteger(input.sourceAccountCount) || input.sourceAccountCount<1 || input.sourceAccountCount>10000
    || input.rows.length!==input.sourceAccountCount || !/^[a-f0-9]{64}$/.test(input.policyBundleSha256??'')
    || !/^[a-f0-9]{64}$/.test(input.sourceReceiptSha256??'') || !/^[a-f0-9]{64}$/.test(input.policyAuthoritySha256??'')
    || new Set(input.rows.map(row=>row?.sourceId)).size!==input.rows.length)fail();
  if(input.rows.some(row=>!row?.body || row.blocked))throw new Error('PARTIAL_LISTED_BATCH_NOT_AUTHORIZED');
  const accounts=new Set();
  for(const row of input.rows){
    const intake=row.body.intake,source=intake?.source,evidence=intake?.legacyQuoteEvidence,proof=evidence?.policyBinding;
    if(!intake || !source || !evidence || !proof || typeof intake.accountId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intake.accountId)
      || !['0','1'].includes(intake.isFullPayout) || accounts.has(intake.accountId)
      || source.sourceSystem!=='legacy_mysql_restore' || source.sourceEntity!=='la_rental_accounts' || source.legacyId!==row.sourceId
      || typeof evidence.sourceCanonical!=='string' || sha(evidence.sourceCanonical)!==source.sourceDigest
      || typeof evidence.policyCanonical!=='string' || sha(evidence.policyCanonical)!==input.policyBundleSha256
      || typeof proof.authorityCanonical!=='string' || sha(proof.authorityCanonical)!==input.policyAuthoritySha256 || proof.authoritySha256!==input.policyAuthoritySha256
      || proof.proofSha256!==input.policyBundleSha256 || proof.sourceReceiptSha256!==input.sourceReceiptSha256
      || proof.sourceId!==source.legacyId || proof.sourceDigest!==source.sourceDigest || proof.expectedAccountCount!==input.sourceAccountCount
      || !/^[a-f0-9]{64}$/.test(row.sourceQuoteDigest??'') || !/^[a-f0-9]{64}$/.test(row.policyDigest??'')
      || canonicalize(binding(row.body))!==canonicalize({scope:row.scope,key:row.key,fingerprint:row.fingerprint}))fail();
    accounts.add(intake.accountId);
  }
  return input.rows;
}
