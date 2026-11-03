import type { Pool } from 'pg';
import {ConfigurationError} from '../config/config';
import {withTransaction} from '../auth/security-core';
import {createLocalFinancialSandbox,assertLocalFinancialSandboxAssembly,assertLocalFinancialSandboxResource,type SandboxOrigins} from './local-financial-sandbox-resource';
import {createSandboxDistributionPolicyScope} from './distribution-policy-store';
import {createSandboxDistributionOrderScope,createPaymentDistributionStore} from './distribution-payment-store';
import {createDistributionEarningStore} from './distribution-earning-store';
import {createSandboxNativeWithdrawalScope} from './native-withdrawal-resource';
import {createSandboxChannelRequestCapability} from '../order/channel-payment-store';
import {createLocalSandboxCheckoutSigner} from '../order/local-sandbox-checkout-crypto';
import {runLocalSandboxRefundBatch,runLocalSandboxRefundStep} from '../order/local-sandbox-refund-worker';
import {runControlledWithdrawalStep,runRegisteredControlledWithdrawalBatch} from './controlled-withdrawal-worker';

const assemblies=new WeakSet<object>();
export type LocalFinancialSandboxAssembly=ReturnType<typeof createLocalFinancialSandboxRuntime>['auth']['localFinancialSandbox'];

/** Constructs only process-local capabilities. No row, role, policy, identity, origin, provider
 * operation, timer or money is created. The Root-owned launcher supplies one pinned registration. */
export function createLocalFinancialSandboxRuntime(input:Parameters<typeof createLocalFinancialSandbox>[0]&{appId:string;checkoutSigningKey:Uint8Array}){
  if(typeof input.appId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.appId))throw new ConfigurationError('Original local IM app ID required');
  const sandbox=createLocalFinancialSandbox(input),orderScope=createSandboxDistributionOrderScope(sandbox),distributionScope=createSandboxDistributionPolicyScope(sandbox);
  const distribution=createPaymentDistributionStore(orderScope),earnings=createDistributionEarningStore(orderScope),nativeWithdrawalScope=createSandboxNativeWithdrawalScope(sandbox);
  const capability=createSandboxChannelRequestCapability(sandbox),signer=createLocalSandboxCheckoutSigner(sandbox,input.checkoutSigningKey);
  const checkout=Object.freeze({sandbox,signer,appId:input.appId,distribution}),refund=Object.freeze({sandbox,capability});
  const assembly=Object.freeze({sandbox,checkout,refund,distributionScope,earnings,nativeWithdrawalScope});assemblies.add(assembly);
  return Object.freeze({auth:Object.freeze({localFinancialSandbox:assembly,distributionScope,distributionReadScope:distributionScope,
    distributionEarnings:earnings,nativeWithdrawalScope}),earnings,
    maintenance:Object.freeze({refundStep:(pool:Pool,id:string,owner?:string)=>runLocalSandboxRefundStep(pool,refund,id,owner),
      refundBatch:(pool:Pool,limit:number,owner:string)=>runLocalSandboxRefundBatch(pool,refund,limit,owner),
      withdrawalStep:(pool:Pool,id:string)=>runControlledWithdrawalStep(pool,id,nativeWithdrawalScope),
      withdrawalBatch:(pool:Pool,limit:number)=>runRegisteredControlledWithdrawalBatch(pool,nativeWithdrawalScope,limit)})});
}

/** The complete bundle has its own brand. Field copies cannot swap a reader, writer or real provider into it. */
export function assertLocalFinancialSandboxRuntimeAssembly(assembly:LocalFinancialSandboxAssembly,options:SandboxOrigins&{
  distributionScope?:unknown;distributionReadScope?:unknown;distributionEarnings?:unknown;nativeWithdrawalScope?:unknown;
  localControlledPayments?:unknown;joinpayCollection?:unknown;joinpayRefund?:unknown;joinpayWithdrawal?:unknown;joinpayAccountObservation?:unknown;
}):void{
  if(!assembly||!assemblies.has(assembly)||options.localControlledPayments||options.joinpayCollection||options.joinpayRefund||options.joinpayWithdrawal||options.joinpayAccountObservation
    ||options.distributionScope!==assembly.distributionScope||options.distributionReadScope!==assembly.distributionScope
    ||options.distributionEarnings!==assembly.earnings||options.nativeWithdrawalScope!==assembly.nativeWithdrawalScope)
    throw new ConfigurationError('Exact local sandbox bundle is exclusive of formal provider assemblies');
  assertLocalFinancialSandboxAssembly(assembly.sandbox,options);
}

/** Startup read validation only; schema installation/enrollment and every worker remain explicit Root actions. */
export async function preflightLocalFinancialSandboxRuntime(pool:Pool,assembly:LocalFinancialSandboxAssembly):Promise<void>{
  if(!assembly||!assemblies.has(assembly))throw new ConfigurationError('Local sandbox bundle is not registered');
  await withTransaction(pool,async c=>{
    await assertLocalFinancialSandboxResource(c,assembly.sandbox,'READ_ORIGINAL');
    const row=(await c.query(`WITH expected(relation_name,trigger_name,function_name) AS(VALUES
      ('zzsh_order.local_financial_sandbox_registration','local_financial_sandbox_registration_guard','zzsh_order.guard_local_financial_sandbox_registration()'),
      ('zzsh_order.distribution_order_admission','sandbox_order_admission_guard','zzsh_order.guard_sandbox_order_admission()'),
      ('zzsh_order.controlled_payment_declaration','sandbox_payment_declaration_guard','zzsh_order.guard_sandbox_payment_declaration()'),
      ('zzsh_order.payment_confirmation','sandbox_payment_confirmation_guard','zzsh_order.guard_sandbox_payment_confirmation()'),
      ('zzsh_order.withdrawal_admission','sandbox_withdrawal_admission_guard','zzsh_order.guard_sandbox_withdrawal_admission()'),
      ('zzsh_order.withdrawal_destination','sandbox_withdrawal_destination_guard','zzsh_order.guard_sandbox_withdrawal_destination()'),
      ('zzsh_order.withdrawal_intent','aaa_sandbox_withdrawal_intent_guard','zzsh_order.guard_sandbox_withdrawal_intent()'),
      ('zzsh_order.controlled_payout_operation','aaa_sandbox_controlled_operation_guard','zzsh_order.guard_sandbox_withdrawal_original_provider()'),
      ('zzsh_order.withdrawal_provider_fact','aaa_sandbox_withdrawal_fact_guard','zzsh_order.guard_sandbox_withdrawal_original_provider()'),
      ('zzsh_order.channel_refund_intent','sandbox_refund_write_guard','zzsh_order.guard_sandbox_refund_intent()'),
      ('zzsh_order.local_controlled_refund_operation','local_refund_operation_guard','zzsh_order.guard_local_refund_source()'),
      ('zzsh_order.local_controlled_refund_evidence','local_refund_evidence_guard','zzsh_order.guard_local_refund_source()'),
      ('zzsh_order.finance_economic_root','local_refund_root_guard','zzsh_order.guard_local_refund_money()'),
      ('zzsh_order.finance_event','local_refund_event_guard','zzsh_order.guard_local_refund_money()'),
      ('zzsh_order.settlement_ledger_entry','local_refund_entry_guard','zzsh_order.guard_local_refund_money()'),
      ('zzsh_order.channel_refund_intent','local_refund_intent_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.local_controlled_refund_operation','local_refund_operation_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.local_controlled_refund_evidence','local_refund_evidence_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.finance_economic_root','local_refund_root_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.finance_event','local_refund_event_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.settlement_ledger_entry','local_refund_entry_closure','zzsh_order.check_local_refund_closure()'),
      ('zzsh_order.finance_event','native_refund_wallet_revision','zzsh_order.withdrawal_wallet_revision()'))
      SELECT to_regprocedure('zzsh_order.local_controlled_refund_terminal_complete(text)') IS NOT NULL
      AND to_regclass('zzsh_order.local_controlled_refund_operation') IS NOT NULL AND to_regclass('zzsh_order.local_controlled_refund_evidence') IS NOT NULL
      AND to_regclass('zzsh_order.controlled_payment_declaration') IS NOT NULL AND to_regclass('zzsh_order.withdrawal_bank_binding') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.withdrawal_destination') AND attname='valid_until' AND NOT attisdropped)
      AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(e.relation_name) AND t.tgname=e.trigger_name
        WHERE t.oid IS NULL OR t.tgenabled<>'O' OR t.tgfoid IS DISTINCT FROM to_regprocedure(e.function_name)) AS ready`)).rows[0];
    if(row?.ready!==true)throw new ConfigurationError('Registered local sandbox schema is incomplete');
  });
}
