import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assertQualificationBatches } from './local-distribution-qualification-plan.mjs';

const sameTarget = (a, b) => a?.oid === b?.oid && a?.nonce === b?.nonce && isDeepStrictEqual(a?.instance ?? null, b?.instance ?? null)
  && (a?.migrationProfile ?? null) === (b?.migrationProfile ?? null);

export function validateWorkflowPlan({ value, receipt, ref, inputRef, round, sourceProof, users, canonicalize }) {
  assert(receipt.status === 'PREPARED_POLICY_MAY_REQUIRE_APPROVAL' && receipt.policyActive === false
    && receipt.planSha256 === ref.sha256 && value.inputSha256 === inputRef.sha256
    && value.datasetSha256 === round.dataset.sha256 && value.sourceDigest === round.source.sha256 && sameTarget(value.target, round.target)
    && value.policyDigest === sourceProof.policyDigest && value.readOnlyRollbackAck === true && value.clientClosed === true
    && Array.isArray(value.accepted) && Array.isArray(value.existing) && value.existing.length === 0 && Array.isArray(value.ineligible)
    && Array.isArray(value.unresolved) && Array.isArray(value.exceptions) && value.exceptions.length === 0 && Array.isArray(value.batches)
    && value.accepted.length + value.ineligible.length + value.unresolved.length === users, 'DISTRIBUTION_WORKFLOW_PLAN_REVIEW_REQUIRED');
  assert(typeof canonicalize === 'function', 'DISTRIBUTION_WORKFLOW_CANONICALIZER_REQUIRED');
  assertQualificationBatches(value, canonicalize);
  return { ref, accepted: value.accepted.length, unresolved: value.unresolved.length, ineligible: value.ineligible.length,
    batches: value.batches.length, policyId: value.policyId, policyDigest: value.policyDigest };
}

export function validateWorkflowPolicy({ value, inputRef, plan, round }) {
  assert(value.status === 'NATIVE_POLICY_APPROVED_READBACK_PASSED' && value.mode === '--approve' && value.inputSha256 === inputRef.sha256
    && value.planSha256 === plan.ref.sha256 && value.policyActive === true && value.policyId === plan.policyId
    && value.datasetSha256 === round.dataset.sha256 && value.sourceDigest === round.source.sha256 && sameTarget(value.target, round.target)
    && value.financialWrites === 0 && value.lockReleased === true && value.lockClientClosed === true && value.clientsClosed === true
    && Array.isArray(value.steps) && ['decision', 'execute', 'approval-readback'].every(name => value.steps.some(step => step.step === name && step.status === 200)),
  'DISTRIBUTION_WORKFLOW_POLICY_UNCONFIRMED');
}

export function validateWorkflowReadback({ value, inputRef, plan, round, refs, users, executed }) {
  const count = value.counts;
  assert(value.status === 'EXACT_QUALIFICATION_READBACK_PASSED' && value.mode === (executed ? '--execute' : '--readback')
    && value.inputSha256 === inputRef.sha256 && value.planSha256 === plan.ref.sha256 && value.roundInputSha256 === refs.roundInput.sha256
    && value.roundReceiptSha256 === refs.roundReceipt.sha256 && value.coreReadbackSha256 === refs.coreReadback.sha256
    && value.datasetSha256 === round.dataset.sha256 && value.sourceDigest === round.source.sha256 && sameTarget(value.target, round.target)
    && value.policyActive === true && value.policyId === plan.policyId && value.policyDigest === plan.policyDigest && value.financialWrites === 0
    && value.readOnlyRollbackAck === true && value.readOnlyClientClosed === true && count?.participants === users
    && count.readbackEligible === plan.accepted && count.readbackIneligible === plan.ineligible && count.readbackUnresolved === plan.unresolved
    && count.readbackExceptions === 0 && count.verifiedReceiptBatches === plan.batches && count.verifiedReceiptParticipants === plan.accepted
    && (!executed || value.transaction?.status === 'COMMIT_ACKNOWLEDGED' && value.lockReleased === true && value.clientsClosed === true),
  'DISTRIBUTION_WORKFLOW_READBACK_UNCONFIRMED');
  return { participants: count.participants, eligible: count.readbackEligible, ineligible: count.readbackIneligible, unresolved: count.readbackUnresolved };
}

/** A failed stage leaves its original intent in place; it is never retried by this workflow. */
export async function runDistributionWorkflow({ steps, record }) {
  const required = ['candidate', 'input', 'prepare', 'approve', 'authorize', 'execute', 'readback'];
  assert(steps && required.every(name => typeof steps[name] === 'function') && typeof record === 'function', 'DISTRIBUTION_WORKFLOW_INVALID');
  async function stage(name, work, ...args) {
    await record({ name, status: 'INTENT' });
    const result = await work(...args);
    await record({ name, status: 'ACK', result });
    return result;
  }
  const candidate = await stage('candidate', steps.candidate);
  const input = await stage('input', steps.input, candidate);
  const plan = await stage('prepare', steps.prepare, input);
  assert(Number.isSafeInteger(plan?.accepted) && plan.accepted >= 0 && Number.isSafeInteger(plan?.unresolved) && plan.unresolved >= 0,
    'DISTRIBUTION_WORKFLOW_PLAN_INVALID');
  const policy = await stage('approve', steps.approve, input, plan);
  let readback;
  if (plan.accepted) {
    const authority = await stage('authorize', steps.authorize, input, plan, policy);
    readback = await stage('execute-and-readback', steps.execute, input, plan, authority);
  } else readback = await stage('readback-no-qualifications', steps.readback, input, plan);
  return { status: plan.unresolved ? 'DISTRIBUTION_WORKFLOW_REVIEW_REQUIRED' : 'DISTRIBUTION_WORKFLOW_READBACK_PASS',
    accepted: plan.accepted, unresolved: plan.unresolved, readback };
}
