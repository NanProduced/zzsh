import type {PoolClient} from 'pg';
import {distributionAccrualTaskContractSql} from './distribution-accrual-tasks';
import {fixedFeeSupportCancelContractSql,supportPoststartExecutorSafeSql,supportPoststartTriggersSql} from './support-poststart-schema';

/** Fixed-fee orders may advance only when their accounting and cancellation guards are installed together. */
export async function fixedFeeSettlementSchemaReady(client:Pick<PoolClient,'query'>):Promise<boolean> {
 const row=(await client.query(`SELECT COALESCE(
  current_setting('session_replication_role')='origin'
  AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_order.settlement_ledger_entry')
   AND c.conname='settlement_ledger_accounts' AND c.convalidated
   AND position('PLATFORM_SERVICE_FEE' IN pg_get_constraintdef(c.oid))>0
   AND position('PLATFORM_MEMBER_DISCOUNT' IN pg_get_constraintdef(c.oid))>0)
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('zzsh_order.guard_supply_final_funding()','zzsh_order.rental_order','personal-quote-v5','credit_guarantee_waived_revision'),
   ('zzsh_order.guard_fixed_fee_personal_order()','zzsh_order.rental_order','fixed fee order contract mismatch','assert_fixed_fee_personal_order_v5'),
   ('zzsh_order.guard_settlement_ledger_entry()','zzsh_order.settlement_ledger_entry','PLATFORM_SERVICE_FEE','PLATFORM_MEMBER_DISCOUNT'),
   ('zzsh_order.check_settlement_posting_batch()','zzsh_order.settlement_posting','settlement-version-v4','proposedPlatformServiceFee'),
   ('zzsh_order.derive_payment_referral_inputs(text)','zzsh_order.payment_distribution_basis','IN (''2''::jsonb,''4''::jsonb)','ELSIF (raw_amounts[i]=0 OR raw_amounts[i]<minimum) AND o.quote_snapshot->>''schemaVersion'' IS DISTINCT FROM ''4'''),
   ('zzsh_order.guard_payment_distribution_basis()','zzsh_order.payment_distribution_basis','payment-distribution-basis.v2','fixedFeePricing'),
   ('zzsh_order.guard_rental_referral_earning()','zzsh_order.rental_referral_earning','derive_frozen_referral_accrual','frozen_referral_earning_seed')
  ) required(signature,relation,first_marker,second_marker) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass(required.relation)
   WHERE p.oid=to_regprocedure(required.signature) AND p.proowner=c.relowner AND NOT p.prosecdef
    AND position(required.first_marker IN p.prosrc)>0 AND position(required.second_marker IN p.prosrc)>0))
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('zzsh_order.rental_order','supply_final_funding_guard','zzsh_order.guard_supply_final_funding()',false,7,NULL),
   ('zzsh_order.rental_order','rental_order_fixed_fee_personal_guard','zzsh_order.guard_fixed_fee_personal_order()',false,23,NULL),
   ('zzsh_order.settlement_ledger_entry','settlement_ledger_entry_guard','zzsh_order.guard_settlement_ledger_entry()',false,7,'(new.posting_id IS NOT NULL)'),
   ('zzsh_order.settlement_posting','settlement_posting_batch_guard','zzsh_order.check_settlement_posting_batch()',true,5,NULL),
   ('zzsh_order.settlement_ledger_entry','settlement_ledger_batch_guard','zzsh_order.check_settlement_posting_batch()',true,5,NULL),
   ('zzsh_order.payment_distribution_basis','payment_distribution_basis_guard','zzsh_order.guard_payment_distribution_basis()',false,7,NULL),
   ('zzsh_order.payment_confirmation','applied_distribution_basis_pair','zzsh_order.check_payment_distribution_basis_pair()',true,5,NULL),
   ('zzsh_order.payment_distribution_basis','distribution_basis_applied_pair','zzsh_order.check_payment_distribution_basis_pair()',true,5,NULL),
   ('zzsh_order.rental_referral_earning','rental_referral_earning_guard','zzsh_order.guard_rental_referral_earning()',false,31,NULL)
  ) required(relation,name,signature,deferred,type,qual) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid=to_regclass(required.relation) AND t.tgname=required.name AND t.tgfoid=to_regprocedure(required.signature)
    AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.type::smallint
    AND t.tgdeferrable=required.deferred AND t.tginitdeferred=required.deferred
    AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qual))
  AND (${supportPoststartTriggersSql})=12 AND (${fixedFeeSupportCancelContractSql}) AND (${distributionAccrualTaskContractSql})
  AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_order.channel_refund_intent')
   AND c.conname='channel_refund_current_basis_only' AND c.convalidated
   AND position('SUPPORT_CANCELLATION' IN pg_get_constraintdef(c.oid))>0 AND position('POSTING' IN pg_get_constraintdef(c.oid))>0)
  AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_order.support_cancellation_refund_original_key') AND i.indisvalid AND i.indisready AND i.indisunique)
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('zzsh_order.support_poststart_cancellation_complete(text)'),('zzsh_order.support_cancellation_refund_liability_complete(text)'),
   ('zzsh_order.support_cancellation_refund_terminal_complete(text)'),('zzsh_order.derive_payment_referral_inputs(text)')
  ) required(signature) WHERE NOT COALESCE(has_function_privilege(current_user,to_regprocedure(required.signature),'EXECUTE'),false))
  AND COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.cancel_order_after_start_v3(text,bigint,numeric,numeric,text)'),'EXECUTE'),false)
  AND COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.fixed_fee_poststart_rate(jsonb,text,text,text,text,text,text)'),'EXECUTE'),false)
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('zzsh_order.settlement_posting','SELECT'),('zzsh_order.settlement_posting','INSERT'),
   ('zzsh_order.settlement_ledger_entry','SELECT'),('zzsh_order.settlement_ledger_entry','INSERT'),
   ('zzsh_order.payment_distribution_basis','SELECT'),('zzsh_order.rental_referral_earning','SELECT')
  ) required(relation,privilege) WHERE NOT COALESCE(has_table_privilege(current_user,to_regclass(required.relation),required.privilege),false))
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('zzsh_order.payment_distribution_basis','id,order_id,payment_confirmation_id,admission_id,admission_revision,canonical_basis,basis_digest'),
   ('zzsh_order.rental_referral_earning','id,economic_root_id,economic_key,order_id,payment_confirmation_id,posting_id,beneficiary_user_id,beneficiary_role,amount_cents,due_at,basis_digest,posting_digest,canonical_seed,seed_digest,state,funds_disposition,version')
  ) required(relation,columns) CROSS JOIN LATERAL unnest(string_to_array(required.columns,',')) AS col(name)
   WHERE NOT COALESCE(has_column_privilege(current_user,to_regclass(required.relation),col.name,'INSERT'),false))
 ,false) AS ready`)).rows[0];
 return row?.ready===true;
}

/** New publication and reservation also need the single-publication and v5 write contracts. */
export async function fixedFeeTradeSchemaReady(client: Pick<PoolClient, "query">): Promise<boolean> {
  const row = (await client.query(`SELECT
    NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('listing_publication', 'listing_publication_shape', 'guard_listing_publication_shape', 7, false),
        ('listing_publication', 'listing_publication_immutable', 'guard_listing_publication_immutable', 27, false),
        ('listing_publication', 'listing_publication_consistency', 'guard_listing_publication_consistency', 29, true),
        ('listing_publication', 'listing_publication_effective_rule_guard', 'guard_publication_effective_rule', 7, false),
        ('listing_publication', 'listing_legacy_delta_republication_guard', 'guard_legacy_delta_republication', 7, false),
        ('listing_version', 'listing_version_publication', 'guard_listing_version_publication', 21, true),
        ('rental_order', 'rental_order_guard', 'guard_rental_order', 23, false)
      ) required(relation, name, signature, type, deferred)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace n ON n.oid=c.relnamespace AND n.oid=p.pronamespace
        WHERE c.oid=to_regclass((CASE WHEN required.relation='rental_order' THEN 'zzsh_order.' ELSE 'zzsh_supply.' END)||required.relation)
          AND t.tgname=required.name AND p.proname=required.signature AND p.pronargs=0 AND p.proowner=c.relowner AND NOT p.prosecdef
          AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.type AND t.tgqual IS NULL
          AND t.tgdeferrable=required.deferred AND t.tginitdeferred=required.deferred
      )
    )
    AND EXISTS (
      SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_supply.listing_publication_one_per_account')
        AND i.indrelid=to_regclass('zzsh_supply.listing_publication') AND i.indisvalid AND i.indisready AND i.indisunique
        AND i.indpred IS NULL AND i.indnkeyatts=1 AND pg_get_indexdef(i.indexrelid,1,true)='account_id'
    )
    AND EXISTS (
      SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_order.rental_order_single_occupancy')
        AND i.indrelid=to_regclass('zzsh_order.rental_order') AND i.indisvalid AND i.indisready AND i.indisunique
        AND i.indnkeyatts=1 AND pg_get_indexdef(i.indexrelid,1,true)='account_id'
        AND pg_get_expr(i.indpred,i.indrelid)='(status = ANY (ARRAY[''PENDING_PAYMENT''::text, ''PAID''::text]))'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
      WHERE c.conrelid=to_regclass('zzsh_order.rental_order') AND c.conname='rental_order_confirmation_unique'
        AND c.contype='u' AND c.convalidated AND i.indisvalid AND pg_get_indexdef(i.indexrelid,1,true)='confirmation_id'
    )
    AND (${supportPoststartExecutorSafeSql})
    AND COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.cancel_order_after_start_v2(text,bigint,numeric,numeric,text)'),'EXECUTE'),false)
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order)'),
        ('zzsh_order.assert_personal_growth_for_fixed_fee_v5(zzsh_order.rental_order,text)')
      ) required(signature)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.rental_order')
        WHERE p.oid=to_regprocedure(required.signature) AND p.proowner=c.relowner AND NOT p.prosecdef
          AND has_function_privilege(current_user,p.oid,'EXECUTE')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('zzsh_supply.listing_publication','SELECT'), ('zzsh_supply.listing_publication','INSERT'),
        ('zzsh_supply.rule_acceptance','SELECT'), ('zzsh_supply.rule_acceptance','INSERT'),
        ('zzsh_order.rental_order','SELECT'), ('zzsh_order.rental_order','INSERT'),
        ('zzsh_order.support_poststart_cancellation','SELECT')
      ) required(relation,privilege)
      WHERE NOT COALESCE(has_table_privilege(current_user,to_regclass(required.relation),required.privilege),false)
    ) AS ready`)).rows[0];
  return row?.ready === true && await fixedFeeSettlementSchemaReady(client);
}

/** Scheduled spread also needs the versioned insertion and full-payout readers. */
export async function scheduledSpreadSettlementSchemaReady(client: Pick<PoolClient, "query">): Promise<boolean> {
  const shape = (await client.query(`SELECT
    COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.assert_scheduled_spread_order_v6(zzsh_order.rental_order)'),'EXECUTE'),false)
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.rental_order')
      AND t.tgname='rental_order_scheduled_spread_personal_guard'
      AND t.tgfoid=to_regprocedure('zzsh_order.guard_scheduled_spread_personal_order()')
      AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=23 AND t.tgqual IS NULL)
    AND EXISTS(SELECT 1 FROM pg_proc p WHERE
      p.oid=to_regprocedure('zzsh_order.poststart_full_payout_selected(jsonb,text,text,text,text,text,text)')
      AND position('personal-quote-v6' IN p.prosrc)>0)
    AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_order.check_settlement_posting_batch()')
      AND position('scheduled spread settlement basis differs' IN p.prosrc)>0) AS ready`)).rows[0];
  return shape?.ready === true && await fixedFeeSettlementSchemaReady(client);
}
