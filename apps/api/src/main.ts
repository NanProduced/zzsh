import { createApp } from "./app";
import { loadJoinpayCollectionRuntime } from "./order/joinpay-collection-runtime";
import { loadJoinpayRefundRuntime } from "./order/joinpay-refund-runtime";
import { loadJoinpayAccountRuntime } from "./finance/joinpay-account-runtime";
import { loadWithdrawalBankBindingRuntime } from "./finance/withdrawal-bank-binding-runtime";
import { loadJoinpayPayoutRuntime } from "./finance/joinpay-payout-runtime";
import { businessFeatureEnabled, ConfigurationError, loadConfig } from "./config/config";
import {
  createFakeHealthDependencies,
  createRealHealthDependencies,
} from "./health/readiness";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "./database/business";
import { loadAuthRuntimeConfig } from "./auth/auth-runtime";
import { loadNativeDistributionRuntime } from "./finance/distribution-native-runtime";
import { createNativeWalletOriginResource, createProvisionedNativeWalletOriginResource } from "./finance/native-wallet-origin";
import { loadDistributionDueRuntime } from "./finance/distribution-due.module";
import { loadOrderSweepRuntime } from "./order/order-sweep.module";

export async function bootstrap() {
  const config = loadConfig();
  const authEnabledValue = businessFeatureEnabled(process.env, "AUTH_ENABLED", true) ? "true" : "false";
  const withdrawalBankBinding = loadWithdrawalBankBindingRuntime({ database: config.database, authEnabled: authEnabledValue === "true" });
  const joinpayWithdrawal = loadJoinpayPayoutRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" }, withdrawalBankBinding);
  const joinpayCollection = loadJoinpayCollectionRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" });
  const distributionNative = loadNativeDistributionRuntime({ config, authEnabled: authEnabledValue === "true", admission: joinpayCollection?.admission });
  const joinpayRefund = loadJoinpayRefundRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" });
  const joinpayAccounts = loadJoinpayAccountRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" });
  const readinessMode = process.env.READINESS_MODE?.trim() || "real";
  if (readinessMode !== "real" && readinessMode !== "fake") {
    throw new ConfigurationError("READINESS_MODE is invalid");
  }
  if (readinessMode === "fake" && config.profile !== "test") {
    throw new ConfigurationError("READINESS_MODE=fake requires APP_PROFILE=test");
  }
  const dependencies = readinessMode === "fake"
    ? createFakeHealthDependencies()
    : createRealHealthDependencies(config);
  // Keep the total at ten; directory reads must not inherit another domain's reused backend.
  const businessPool = authEnabledValue === "true" ? createBusinessPool(config, { max: 8 }) : undefined;
  const directoryReadPool = businessPool ? createBusinessPool(config, { max: 2, maxUses: 1 }) : undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const orderSweep = loadOrderSweepRuntime(businessPool);
    const distributionDue = loadDistributionDueRuntime(businessPool, distributionNative?.auth.distributionEarnings);
    if (businessPool) await assertBusinessRuntimeIdentity(businessPool, config);
    // New-user zero origin trusts the owner's exact resource admission, not a merchant account.
    const nativeWalletOrigin = !businessPool ? undefined
      : config.profile === "dev" || config.profile === "ecs-test" || config.profile === "production"
        ? createProvisionedNativeWalletOriginResource(config)
        : joinpayCollection?.admission ? createNativeWalletOriginResource(joinpayCollection.admission) : undefined;
    app = await createApp({
      health: { dependencies },
      ...(orderSweep ? { orderSweep } : {}),
      ...(distributionDue ? { distributionDue } : {}),
      ...(businessPool
        ? {
            database: { pool: businessPool, directoryReadPool },
            auth: {
              ...loadAuthRuntimeConfig(undefined, undefined, { testOperationsEnabled: config.testOperationsEnabled }),
              pool: businessPool,
              ...(withdrawalBankBinding ? { withdrawalBankBinding } : {}),
              ...(joinpayWithdrawal ? { joinpayWithdrawal } : {}),
              ...(joinpayCollection ? { joinpayCollection } : {}),
              ...(nativeWalletOrigin ? { nativeWalletOrigin } : {}),
              ...(joinpayRefund ? { joinpayRefund } : {}),
              ...(joinpayAccounts ? { joinpayAccountRead: joinpayAccounts.read, joinpayAccountObservation: joinpayAccounts.observation } : {}),
              directoryReadPool,
              ...(distributionNative ? distributionNative.auth : {}),
              ...(config.orderImSdkRouteConfig ? { orderImSdkRouteConfig: config.orderImSdkRouteConfig } : {}),
              ...(config.yunxin.enabled && config.yunxin.appKey && config.yunxin.appSecret
                ? {
                    yunxin: {
                      appId: config.yunxin.appKey,
                      appKey: config.yunxin.appKey,
                      appSecret: config.yunxin.appSecret,
                    },
                  }
                : {}),
              ...(config.orderTeams
                ? {
                    orderTeams: {
                      membersLimit: config.orderTeams.membersLimit,
                      intervalMs: config.orderTeams.intervalMs,
                      batchLimit: config.orderTeams.batchLimit,
                      ...(config.orderTeams.escalationEnabled ? { escalationEnabled: true } : {}),
                    },
                  }
                : {}),
              ...(config.supportDispatch ? { supportDispatch: config.supportDispatch } : {}),
            },
          }
        : {}),
    });
    await app.listen(config.port, config.host);
  } catch (error) {
    if (app) await app.close();
    else await Promise.allSettled([
      dependencies.postgres.close(),
      dependencies.redis.close(),
      businessPool?.end(),
      directoryReadPool?.end(),
    ]);
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`API configuration rejected: ${error.message}`);
  } else {
    console.error("API startup failed; check configuration and port availability.");
  }
  process.exitCode = 1;
});
