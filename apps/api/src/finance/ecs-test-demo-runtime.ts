import type { Pool } from "pg";
import { ConfigurationError } from "../config/config";
import { withTransaction } from "../auth/security-core";
import { assertEcsTestDemoAssembly, assertEcsTestDemoResource, createEcsTestDemoResource, createLocalDemoCloneResource,
  type DemoFinanceResource, type DemoOrigins } from "./ecs-test-demo-resource";
import { createEcsDemoDistributionOrderScope, createPaymentDistributionStore } from "./distribution-payment-store";
import { createDistributionEarningStore } from "./distribution-earning-store";
import { createEcsDemoCollectionCapability, createEcsDemoRefundCapability } from "../order/channel-payment-store";
import { createDemoNativeWithdrawalScope } from "./native-withdrawal-resource";
import type { WithdrawalBusinessPolicy } from "./withdrawal-business-policy";

const assemblies = new WeakSet<object>();
export type EcsTestDemoRuntime = NonNullable<ReturnType<typeof createEcsTestDemoRuntime>>;

/** Creates process-local capabilities only; enrollment and database installation are separate owner steps. */
export function createEcsTestDemoRuntime(input: Parameters<typeof createEcsTestDemoResource>[0] & { appId: string; withdrawalPolicy?:WithdrawalBusinessPolicy }) {
  const demo = createEcsTestDemoResource(input); if (!demo) return undefined;
  return assemble(demo,input.appId,input.withdrawalPolicy);
}
export function createLocalDemoCloneRuntime(input:Parameters<typeof createLocalDemoCloneResource>[0] & {appId:string;withdrawalPolicy?:WithdrawalBusinessPolicy}) {
  return assemble(createLocalDemoCloneResource(input),input.appId,input.withdrawalPolicy);
}
function assemble(demo:DemoFinanceResource,appId:string,withdrawalPolicy?:WithdrawalBusinessPolicy) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(appId)) throw new ConfigurationError("ECS_TEST_DEMO_IM_APP_INVALID");
  const orderScope = createEcsDemoDistributionOrderScope(demo);
  const checkout = Object.freeze({ demo, appId, distribution: createPaymentDistributionStore(orderScope), capability: createEcsDemoCollectionCapability(demo) });
  const earnings = createDistributionEarningStore(orderScope);
  const refund = Object.freeze({ demo, capability: createEcsDemoRefundCapability(demo) });
  const withdrawal = Object.freeze({ demo, scope:createDemoNativeWithdrawalScope(demo,withdrawalPolicy) });
  const assembly = Object.freeze({ demo, checkout, earnings, refund, withdrawal }); assemblies.add(assembly); return assembly;
}

export function assertEcsTestDemoRuntimeAssembly(assembly: EcsTestDemoRuntime, options: DemoOrigins & {
  distributionEarnings?: unknown; nativeWithdrawalScope?:unknown; localFinancialSandbox?: unknown; localControlledPayments?: unknown;
  joinpayCollection?: unknown; joinpayRefund?: unknown; joinpayWithdrawal?: unknown; joinpayAccountObservation?: unknown;
}) {
  if (!assembly || !assemblies.has(assembly) || options.localFinancialSandbox || options.localControlledPayments
    || options.distributionEarnings !== assembly.earnings || options.nativeWithdrawalScope !== assembly.withdrawal.scope)
    throw new ConfigurationError("ECS_TEST_DEMO_FINANCE_ASSEMBLY_MISMATCH");
  assertEcsTestDemoAssembly(assembly.demo, options);
}

/** Startup checks the exact target and test guards before exposing any demo endpoint. */
export async function preflightEcsTestDemoRuntime(pool: Pool, assembly: EcsTestDemoRuntime) {
  if (!assembly || !assemblies.has(assembly)) throw new ConfigurationError("ECS_TEST_DEMO_FINANCE_ASSEMBLY_MISMATCH");
  await withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertEcsTestDemoResource(c, assembly.demo, "READ_ORIGINAL");
    const row = (await c.query(`WITH required(relation_name,trigger_name,function_name) AS (VALUES
      ('zzsh_order.ecs_test_demo_finance_registration','guard_ecs_test_demo_finance_registration','zzsh_order.guard_ecs_test_demo_finance_registration()'),
      ('zzsh_order.distribution_order_admission','ecs_demo_order_admission_guard','zzsh_order.guard_ecs_demo_order_admission()'),
      ('zzsh_order.controlled_payment_declaration','ecs_demo_payment_declaration_guard','zzsh_order.guard_ecs_demo_payment_declaration()'),
      ('zzsh_order.controlled_payment_declaration','controlled_payment_declaration_immutable','zzsh_order.finance_immutable()'),
      ('zzsh_order.controlled_payment_declaration','controlled_payment_declaration_no_truncate','zzsh_order.finance_immutable()'),
      ('zzsh_order.payment_confirmation','ecs_demo_payment_confirmation_guard','zzsh_order.guard_ecs_demo_payment_confirmation()'),
      ('zzsh_order.channel_refund_intent','ecs_demo_refund_write_guard','zzsh_order.guard_sandbox_refund_intent()'),
      ('zzsh_order.local_controlled_refund_operation','local_refund_operation_guard','zzsh_order.guard_local_refund_source()'),
      ('zzsh_order.local_controlled_refund_evidence','local_refund_evidence_guard','zzsh_order.guard_local_refund_source()'),
      ('zzsh_order.channel_refund_intent','local_refund_intent_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.finance_economic_root','local_refund_root_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.finance_event','local_refund_event_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.settlement_ledger_entry','local_refund_entry_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.withdrawal_admission','sandbox_withdrawal_admission_guard','zzsh_order.guard_sandbox_withdrawal_admission()'),
      ('zzsh_order.withdrawal_destination','sandbox_withdrawal_destination_guard','zzsh_order.guard_sandbox_withdrawal_destination()'),
      ('zzsh_order.withdrawal_destination','sandbox_withdrawal_target_receipt','zzsh_order.check_sandbox_withdrawal_target_receipt()'),
      ('zzsh_order.withdrawal_intent','aaa_sandbox_withdrawal_intent_guard','zzsh_order.guard_sandbox_withdrawal_intent()'),
      ('zzsh_order.withdrawal_intent','withdrawal_intent_guard','zzsh_order.guard_withdrawal_intent()'),
      ('zzsh_order.withdrawal_intent','withdrawal_intent_commit_guard','zzsh_order.check_withdrawal_intent_consistency()'),
      ('zzsh_order.controlled_payout_operation','controlled_operation_guard','zzsh_order.guard_controlled_operation()'),
      ('zzsh_order.withdrawal_provider_fact','withdrawal_fact_guard','zzsh_order.guard_withdrawal_fact()'),
      ('zzsh_order.finance_economic_root','withdrawal_root_guard','zzsh_order.guard_withdrawal_root()'),
      ('zzsh_order.finance_event','withdrawal_event_guard','zzsh_order.guard_withdrawal_event()'),
      ('zzsh_order.finance_event','withdrawal_event_batch_guard','zzsh_order.check_withdrawal_batch()'),
      ('zzsh_order.settlement_ledger_entry','withdrawal_entry_guard','zzsh_order.guard_withdrawal_entry()'),
      ('zzsh_order.settlement_ledger_entry','withdrawal_entry_batch_guard','zzsh_order.check_withdrawal_batch()'),
      ('zzsh_order.ecs_demo_legacy_refund','demo_legacy_refund_guard','zzsh_order.guard_demo_legacy_refund()'),
      ('zzsh_order.ecs_demo_legacy_refund','demo_legacy_refund_complete','zzsh_order.check_demo_legacy_refund_complete()'),
      ('zzsh_order.finance_event','demo_legacy_refund_event_guard','zzsh_order.guard_demo_legacy_refund_money()'),
      ('zzsh_order.finance_event','demo_legacy_refund_event_complete','zzsh_order.check_demo_legacy_refund_complete()'),
      ('zzsh_order.settlement_ledger_entry','demo_legacy_refund_entry_guard','zzsh_order.guard_demo_legacy_refund_money()'),
      ('zzsh_order.settlement_ledger_entry','demo_legacy_refund_entry_complete','zzsh_order.check_demo_legacy_refund_complete()'))
      SELECT to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NOT NULL
      AND position('ecs_test_demo_finance_matches' IN pg_get_functiondef(to_regprocedure('zzsh_order.derive_payment_referral_inputs(text)')))>0
      AND has_table_privilege(current_user,'zzsh_order.ecs_test_demo_finance_registration','SELECT')
      AND has_column_privilege(current_user,'zzsh_order.ecs_test_demo_finance_registration','active','UPDATE')
      AND NOT has_table_privilege(current_user,'zzsh_order.ecs_test_demo_finance_registration','INSERT')
      AND NOT has_table_privilege(current_user,'zzsh_order.ecs_test_demo_finance_registration','DELETE')
      AND NOT has_table_privilege(current_user,'zzsh_order.ecs_test_demo_finance_registration','TRUNCATE')
      AND has_column_privilege(current_user,'zzsh_order.controlled_payment_declaration','canonical_payment','INSERT')
      AND NOT has_table_privilege(current_user,'zzsh_order.controlled_payment_declaration','UPDATE')
      AND NOT has_table_privilege(current_user,'zzsh_order.controlled_payment_declaration','DELETE')
      AND to_regprocedure('zzsh_order.local_controlled_refund_terminal_complete(text)') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.channel_refund_intent')
        AND conname='sandbox_refund_source_reference' AND convalidated AND position('PRESTART_TERMINATION' IN pg_get_constraintdef(oid))>0)
      AND COALESCE(position('ecs_test_demo_finance_registration' IN pg_get_functiondef(to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)')))>0,false)
      AND COALESCE(position('session_user' IN pg_get_functiondef(to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)')))>0,false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.local_controlled_refund_operation'),'final_canonical','INSERT'),false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.local_controlled_refund_evidence'),'facts_canonical','INSERT'),false)
      AND NOT COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.local_controlled_refund_operation'),'UPDATE'),false)
      AND NOT COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.local_controlled_refund_evidence'),'UPDATE'),false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.withdrawal_admission'),'resource_oid','INSERT'),false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.withdrawal_intent'),'lease_until','UPDATE'),false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.controlled_payout_operation'),'payout_key','INSERT'),false)
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.withdrawal_provider_fact'),'result_key','INSERT'),false)
      AND NOT EXISTS(SELECT 1 FROM (VALUES
        ('zzsh_order.guard_controlled_operation()','2a746e49329750525137238bf901240e65202fb30438fb73de0f2bca7fcf8254'),
        ('zzsh_order.guard_sandbox_withdrawal_destination()','81e3335ebfeb2cb77ea95f5652eefe64bffa4cf6b4ae177b305d307e5193f3b2'),
        ('zzsh_order.guard_sandbox_withdrawal_intent()','42e8ca7dd1f2ea9a72c65d11420c5af5753ec1e78c88937a1f3d41aa7ab16d4b'),
        ('zzsh_order.guard_local_refund_source()','ef171dfa5ec8d0ccba1fdbe23613f96af7c11e02794afc1e8b7c76afa4203d8b')) expected(signature,digest)
        LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
        WHERE p.oid IS NULL OR p.proowner IS DISTINCT FROM (SELECT nspowner FROM pg_namespace WHERE nspname='zzsh_order')
          OR encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex') IS DISTINCT FROM expected.digest)
      AND NOT EXISTS(SELECT 1 FROM (VALUES('zzsh_order.withdrawal_destination','withdrawal_destination_scenario_check'),
        ('zzsh_order.controlled_payout_operation','controlled_payout_operation_scenario_check')) expected(relation_name,name)
        WHERE NOT EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=to_regclass(expected.relation_name)
          AND p.conname=expected.name AND p.convalidated AND pg_get_constraintdef(p.oid)=
          $$CHECK ((scenario = ANY (ARRAY['FAIL_UNPAID'::text, 'TIMEOUT_THEN_SUCCEED'::text, 'IMMEDIATE_SUCCESS'::text])))$$))
      AND EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=to_regclass('zzsh_order.local_controlled_refund_operation')
        AND p.conname='local_controlled_refund_operation_scenario_check' AND p.convalidated AND pg_get_constraintdef(p.oid)=
        $$CHECK ((scenario = ANY (ARRAY['TIMEOUT_THEN_SUCCEED'::text, 'IMMEDIATE_SUCCESS'::text])))$$)
      AND NOT COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.withdrawal_intent'),'DELETE'),true)
      AND to_regclass('zzsh_order.controlled_payout_notice') IS NULL
      AND has_function_privilege(current_user,to_regprocedure('zzsh_order.withdrawal_expected_lines(text)'),'EXECUTE')
      AND COALESCE(has_column_privilege(current_user,to_regclass('zzsh_order.ecs_demo_legacy_refund'),'duty_id','INSERT'),false)
      AND NOT COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.ecs_demo_legacy_refund'),'UPDATE'),true)
      AND NOT COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.ecs_demo_legacy_refund'),'DELETE'),true)
      AND NOT EXISTS(SELECT 1 FROM (VALUES('finance_entry_guard'),('finance_entry_batch_guard')) expected(name)
        WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.settlement_ledger_entry')
          AND t.tgname=expected.name AND t.tgenabled IN('O','A') AND position('demoLegacyRefundId' IN pg_get_triggerdef(t.oid))>0))
      AND NOT EXISTS (SELECT 1 FROM required r LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(r.relation_name) AND t.tgname=r.trigger_name
        WHERE t.oid IS NULL OR t.tgenabled NOT IN ('O','A') OR t.tgfoid IS DISTINCT FROM to_regprocedure(r.function_name)) AS ready`)).rows[0];
    if (row?.ready !== true) throw new ConfigurationError("ECS_TEST_DEMO_FINANCE_SCHEMA_NOT_READY");
    const cashier = (await c.query(`WITH required(relation_name,trigger_name,function_name) AS (VALUES
      ('zzsh_order.payment_request','test_channel_request_guard','zzsh_order.guard_test_channel_operation()'),
      ('zzsh_order.payment_channel_observation','test_channel_observation_guard','zzsh_order.guard_test_channel_operation()'),
      ('zzsh_order.payment_channel_transaction','test_channel_transaction_guard','zzsh_order.guard_test_channel_operation()'),
      ('zzsh_order.payment_request','test_channel_transition_guard','zzsh_order.check_test_channel_transition()'))
      SELECT NOT EXISTS(SELECT 1 FROM required r LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(r.relation_name) AND t.tgname=r.trigger_name
          WHERE t.oid IS NULL OR t.tgenabled NOT IN ('O','A') OR t.tgfoid IS DISTINCT FROM to_regprocedure(r.function_name))
        AND has_column_privilege(current_user,'zzsh_order.payment_request','state','UPDATE')
        AND has_column_privilege(current_user,'zzsh_order.payment_request','method','INSERT')
        AND has_column_privilege(current_user,'zzsh_order.payment_channel_observation','event','INSERT')
        AND has_column_privilege(current_user,'zzsh_order.payment_channel_transaction','confirmation_id','INSERT')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_request','DELETE')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_request','TRUNCATE')
        AND NOT has_any_column_privilege(current_user,'zzsh_order.payment_channel_observation','UPDATE')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_channel_observation','DELETE')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_channel_observation','TRUNCATE')
        AND NOT has_any_column_privilege(current_user,'zzsh_order.payment_channel_transaction','UPDATE')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_channel_transaction','DELETE')
        AND NOT has_table_privilege(current_user,'zzsh_order.payment_channel_transaction','TRUNCATE') AS ready`)).rows[0];
    if (cashier?.ready !== true) throw new ConfigurationError("TEST_CASHIER_SCHEMA_NOT_READY");
  });
}
