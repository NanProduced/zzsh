import type {PoolClient} from 'pg';import {SecurityApiError} from '../auth/security-core';import {conflict,invalid} from '../supply/supply-util';
/** Caller already authorized the actor/resource and holds its user-row lock for a write.
 * This covers native referral debts only; it does not declare historical global debt zero. */
export async function readReferralRecovery(c:PoolClient,userId:string){
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId))throw invalid('Exact recovery subject required');
 const installed=(await c.query("SELECT to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AS installed")).rows[0]?.installed;
 if(!installed)return{knowledge:'UNKNOWN' as const,outstandingCents:null,earningCount:null,reason:'REFERRAL_RECOVERY_TEMPLATE_NOT_INSTALLED'};
 const r=(await c.query(`SELECT count(*)::text AS count,COALESCE(sum(recovery_required_cents),0)::text AS amount,
 count(*) FILTER(WHERE recovery_required_cents IS NULL OR recovery_required_cents<>amount_cents OR amount_cents<=0 OR funds_disposition<>'SETTLED')::int AS invalid
 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1 AND state='RECOVERY_REQUIRED'`,[userId])).rows[0];
 if(!r||r.invalid!==0||!/^(0|[1-9]\d*)$/.test(r.count)||!/^(0|[1-9]\d{0,23})$/.test(r.amount))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Original referral recovery obligation requires reconciliation');
 return{knowledge:'KNOWN' as const,outstandingCents:r.amount as string,earningCount:r.count as string,scope:'NATIVE_REFERRAL_OBLIGATIONS_ONLY'};
}
export async function assertNoReferralRecoveryForWithdrawal(c:PoolClient,userId:string){const r=await readReferralRecovery(c,userId);if(r.knowledge!=='KNOWN')throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Referral recovery sources are not installed');if(r.earningCount!=='0'||r.outstandingCents!=='0')throw conflict('Outstanding earning recovery must be reconciled before a new withdrawal');return r;}


