import type { AppConfig } from '../config/config';
import { ConfigurationError } from '../config/config';
import { invalid } from '../supply/supply-util';
import { assertLocalControlledPaymentAssembly, type LocalControlledPaymentOptions } from '../order/local-payment-routes';
import { createLocalDistributionScope } from './distribution-policy-store';
import { createPaymentDistributionStore, type DistributionOrderScope } from './distribution-payment-store';
import { createDistributionEarningStore } from './distribution-earning-store';
import { createNativeWithdrawalScope, type NativeWithdrawalBinding } from './native-withdrawal-resource';

/** Explicit test assembly only. This creates capabilities, never policy, admission, identities or money. */
export function createLocalDistributionRuntime(input: {
  config: AppConfig;
  receipt: Parameters<typeof createLocalDistributionScope>[1];
  resourceSet: string;
  approvalDigest: string;
  allowedOrderIds: readonly string[];
  payment: { appId: string; merchantScopeId: string };
  withdrawalBindings?: readonly NativeWithdrawalBinding[];
}) {
  const { config, receipt, resourceSet } = input;
  if (receipt.database !== `zzsh_test_order_${resourceSet}` || receipt.runtimeRole !== `zzsh_order_${resourceSet}_r`) {
    throw new ConfigurationError('Distribution, payment and wallet must use the same reviewed resource');
  }
  if (!input.allowedOrderIds.length || input.allowedOrderIds.length > 100 || new Set(input.allowedOrderIds).size !== input.allowedOrderIds.length) {
    throw invalid('One bounded, unique native order cohort required');
  }
  const scope: DistributionOrderScope = Object.freeze({ resourceSet, resourceOid: receipt.resourceOid,
    approvalDigest: input.approvalDigest, allowedOrderIds: Object.freeze([...input.allowedOrderIds]) });
  const distributionScope = createLocalDistributionScope(config, receipt);
  const payment = createPaymentDistributionStore(scope);
  const earnings = createDistributionEarningStore(scope);
  const localControlledPayments: LocalControlledPaymentOptions = Object.freeze({ config, resourceSet,
    appId: input.payment.appId, merchantScopeId: input.payment.merchantScopeId, distribution: payment });
  assertLocalControlledPaymentAssembly(localControlledPayments);
  const nativeWithdrawalScope = input.withdrawalBindings === undefined ? undefined : createNativeWithdrawalScope({ config, resourceSet,
    resourceOid: receipt.resourceOid, bindings: input.withdrawalBindings });
  return Object.freeze({
    auth: Object.freeze({ distributionScope, distributionReadScope: distributionScope, distributionEarnings: earnings, localControlledPayments,
      nativeWalletOrigin: Object.freeze({ resourceSet, resourceOid: receipt.resourceOid }),
      ...(nativeWithdrawalScope ? { nativeWithdrawalScope } : {}) }),
    earnings,
  });
}
