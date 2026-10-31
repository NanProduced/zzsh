import { createHash } from 'node:crypto';
import type { ApprovalOperationExecutor } from '../auth/auth-security';
import { loadEffectiveAdminAccess, hasPermission, type EffectiveAdminAccess } from '../auth/admin-authorization';
import { SecurityApiError } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { applyApprovedDistributionPolicyInTransaction, assertDistributionPolicyWriteReadyInTransaction, distributionPolicyScopeOf, type LocalDistributionScope } from './distribution-policy-store';
import { DISTRIBUTION_POLICY_OPERATION, parseDistributionPolicyChange } from './distribution-policy-change';
import { prepareDistributionPolicyChange } from './distribution-policy-change';
import { readDistributionPolicyRowInTransaction } from './distribution-policy-store';
import type { PoolClient } from 'pg';

export function assertDistributionApprovalAccess(access:EffectiveAdminAccess|null,stage:'REQUEST'|'DECIDE'|'EXECUTE'){
 if(!access||access.status!=='ACTIVE'||access.passwordChangeRequired||stage==='DECIDE'&&!access.isBoss||stage!=='DECIDE'&&!hasPermission(access,'personal.distribution.policy.manage'))throw new SecurityApiError(403,'FORBIDDEN','Distribution approval stage is not authorized');
}
/** Creation hook runs inside the existing approval transaction, before inserting its request. */
export async function validateDistributionPolicySubmission(client:PoolClient,payload:Record<string,unknown>,writeScope?:LocalDistributionScope){
 const input=parseDistributionPolicyChange(payload);
 await assertDistributionPolicyWriteReadyInTransaction(client,writeScope);
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy-approval:v1',0))");
 const current=await readDistributionPolicyRowInTransaction(client,false,distributionPolicyScopeOf(writeScope));
 if(current.knowledge!=='KNOWN')throw new SecurityApiError(409,'CONFLICT','Distribution policy baseline unavailable');
 prepareDistributionPolicyChange(current.policy,input);
 const existing=(await client.query("SELECT id FROM zzsh_iam.approval_request WHERE operation_code=$1 AND status IN ('PENDING','APPROVED','EXECUTION_FAILED') AND expires_at>clock_timestamp() ORDER BY created_at,id COLLATE \"C\" LIMIT 1",[DISTRIBUTION_POLICY_OPERATION])).rows[0];
 if(existing)throw new SecurityApiError(409,'CONFLICT','A distribution policy change already requires handling');
}
/** Called only by the existing approved-request executor, on its original transaction client. */
export function createDistributionPolicyApprovalExecutor(binding?:LocalDistributionScope):ApprovalOperationExecutor{
 return async(client,input,actor,requestId)=>{
  if(input.operationCode!==DISTRIBUTION_POLICY_OPERATION||input.payloadVersion!==1)throw new SecurityApiError(409,'CONFLICT','Unsupported distribution approval operation');
  if(input.requestedBy===input.decidedBy)throw new SecurityApiError(409,'CONFLICT','Policy requester cannot approve itself');
  assertDistributionApprovalAccess(await loadEffectiveAdminAccess(client,input.decidedBy),'DECIDE');
  assertDistributionApprovalAccess(await loadEffectiveAdminAccess(client,actor.userId),'EXECUTE');
  const payload=parseDistributionPolicyChange(input.operationPayload);
  if(createHash('sha256').update(canonicalize(input.operationPayload)).digest('hex')!==input.operationPayloadHash)throw new SecurityApiError(409,'CONFLICT','Approved distribution payload changed');
  const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0]?.at;
  const now=new Date(at).getTime(),expires=new Date(input.expiresAt).getTime();
  if(!Number.isFinite(now)||!Number.isFinite(expires)||expires<=now)throw new SecurityApiError(409,'CONFLICT','Approved distribution request expired');
  if(!binding)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Approved distribution write scope is not assembled');
  const result=await applyApprovedDistributionPolicyInTransaction(client,{...actor,requestId},payload,{approvalRequestId:input.requestId,payloadHash:input.operationPayloadHash},binding);
  return{resultCode:'DISTRIBUTION_POLICY_APPLIED',resultDetail:result.policy.versionId};
 };
}
