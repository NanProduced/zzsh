import {assertNativeWithdrawalResource,nativeWithdrawalSubjectInScope,type NativeWithdrawalScope} from './native-withdrawal-resource';
import {readReferralRecovery} from './distribution-recovery-gate';
import type {PoolClient} from 'pg';import {SecurityApiError} from '../auth/security-core';import {exactCents} from './finance-money';
const money=(n:string|null)=>({currency:'CNY',unit:'cent',knowledge:n===null?'UNKNOWN':'KNOWN',amountCents:n});
/** Caller has authenticated the subject. Only a proved native genesis closes native ledger buckets;
 * legacy and unclosed sources retain their existing UNKNOWN buckets. */
export async function readNativeWalletBuckets(c:PoolClient,userId:string){
 const origin=(await c.query(`SELECT c.origin,b.source_kind,b.available_cents::text AS opening_amount,b.covered_count FROM zzsh_order.wallet_coverage c JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id WHERE c.user_id=$1`,[userId])).rows[0];
 if(!origin||origin.origin!=='NATIVE_GENESIS')return null;
 if(origin.source_kind!=='NATIVE_GENESIS'||origin.opening_amount!=='0'||origin.covered_count!==0)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Native origin source is inconsistent');
 const totals=(await c.query(`SELECT COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')),0)::text AS available,
 COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_RESERVED'),0)::text AS reserved,
 COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_PENDING_EARNINGS'),0)::text AS pending,
 COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='RENTER_REFUND_PAYABLE'),0)::text AS refund
 FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1`,[userId])).rows[0];
 for(const key of ['available','reserved','pending','refund'])if(BigInt(exactCents(totals[key]))<0n)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Native wallet requires reconciliation');
 return{available:money(totals.available),reserved:money(totals.reserved),pendingEarnings:money(totals.pending),refundPayable:money(totals.refund),restricted:money(null)};
}

/** Debt knowledge is finite. Passing this check only permits requesting a fresh quote. */
export async function readNativeReservationStatus(c:PoolClient,userId:string,scope:NativeWithdrawalScope){
 await assertNativeWithdrawalResource(c,scope);const subjectInScope=nativeWithdrawalSubjectInScope(scope,userId);
 let recovery:Awaited<ReturnType<typeof readReferralRecovery>>;try{recovery=await readReferralRecovery(c,userId);}catch(error){if(!(error instanceof SecurityApiError&&error.status===503))throw error;recovery={knowledge:'UNKNOWN',outstandingCents:null,earningCount:null,reason:'REFERRAL_RECOVERY_REQUIRES_RECONCILIATION'};}
 const reservationState=!subjectInScope?'NOT_IN_SCOPE':recovery.knowledge!=='KNOWN'?'UNKNOWN':recovery.earningCount!=='0'||recovery.outstandingCents!=='0'?'BLOCKED_BY_RECOVERY':'REQUIRES_CURRENT_QUOTE';
 return{scope:'NATIVE_REFERRAL_OBLIGATIONS_ONLY' as const,subjectInScope,recovery,reservationState,globalWithdrawable:'UNKNOWN' as const};
}
