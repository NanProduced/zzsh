import { createApp } from "./app";
import { loadJoinpayCollectionRuntime } from "./order/joinpay-collection-runtime";
import { loadJoinpayRefundRuntime } from "./order/joinpay-refund-runtime";
import { loadEcsTestJoinpayAccountSnapshotRuntime, loadJoinpayAccountRuntime } from "./finance/joinpay-account-runtime";
import { loadWithdrawalBankBindingRuntime } from "./finance/withdrawal-bank-binding-runtime";
import { loadJoinpayPayoutRuntime } from "./finance/joinpay-payout-runtime";
import { businessFeatureEnabled, ConfigurationError, isEcsTestWithoutJoinpay, loadConfig } from "./config/config";
import {
  createFakeHealthDependencies,
  createRealHealthDependencies,
} from "./health/readiness";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "./database/business";
import { loadAuthRuntimeConfig } from "./auth/auth-runtime";
import { loadEcsTestDistributionRuntime, loadNativeDistributionRuntime } from "./finance/distribution-native-runtime";
import { createDemoDistributionManagementResource, createProvisionedDistributionManagementResource } from "./finance/distribution-management-resource";
import { createDemoNativeDistributionScope } from "./finance/distribution-policy-store";
import { createDemoNativeWalletOriginResource, createNativeWalletOriginResource, createProvisionedNativeWalletOriginResource } from "./finance/native-wallet-origin";
import { loadDistributionDueRuntime } from "./finance/distribution-due.module";
import { loadDocsImageFeature } from "./docs/docs-images";
import { loadTrashPurgeRuntime } from "./content/trash-purge.module";
import { loadOrderSweepRuntime } from "./order/order-sweep.module";
import { loadDemoFinanceRuntime } from "./finance/ecs-test-demo-loader";

export async function bootstrap() {
  const config = loadConfig();
  const authEnabledValue = businessFeatureEnabled(process.env, "AUTH_ENABLED", true) ? "true" : "false";
  const settlementRecordingEnabled = businessFeatureEnabled(process.env, "ORDER_SETTLEMENT_RECORDING_ENABLED");
  const withdrawalBankBinding = loadWithdrawalBankBindingRuntime({ database: config.database, authEnabled: authEnabledValue === "true" });
  const joinpayWithdrawal = loadJoinpayPayoutRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" }, withdrawalBankBinding);
  const joinpayCollection = loadJoinpayCollectionRuntime({ provider: config.provider, database: config.database,
    authEnabled: authEnabledValue === "true", settlementRecordingEnabled });
  const withoutJoinpay = isEcsTestWithoutJoinpay(process.env);
  const joinpayRefund = loadJoinpayRefundRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" });
  const joinpayAccountSnapshot = loadEcsTestJoinpayAccountSnapshotRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" });
  const joinpayAccounts = loadJoinpayAccountRuntime({ provider: config.provider, database: config.database, authEnabled: authEnabledValue === "true" }) ?? joinpayAccountSnapshot;
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
    const authConfig=businessPool?loadAuthRuntimeConfig(undefined,undefined,{testOperationsEnabled:config.testOperationsEnabled}):undefined;
    if(!authConfig&&(process.env.LOCAL_DEMO_CLONE_FINANCE_ENABLED==='true'||process.env.ECS_TEST_DEMO_FINANCE_ENABLED==='true'))
      throw new ConfigurationError('DEMO_FINANCE_REQUIRES_AUTH');
    // Closed settlement keeps the collection callback/recovery assembly but the
    // loader omits new-request admission; accepted callbacks still auto-generate.
    const demo=authConfig?loadDemoFinanceRuntime({config,origins:authConfig}):undefined;
    const distributionNative = !demo && !withoutJoinpay
      ? loadNativeDistributionRuntime({ config, authEnabled: authEnabledValue === "true", admission: joinpayCollection?.admission }) : undefined;
    const distributionEcsTest = !demo && withoutJoinpay
      ? loadEcsTestDistributionRuntime({ config, authEnabled: authEnabledValue === "true", admission: joinpayCollection?.admission }) : undefined;
    const demoDistributionScope = demo ? createDemoNativeDistributionScope(demo.demo) : undefined;
    const distributionManagement = demo && demoDistributionScope
      ? createDemoDistributionManagementResource(demo.demo, demoDistributionScope)
      : ["dev","ecs-test","production"].includes(config.profile) && !/^zzsh_(?:test|provider_test)(?:_|$)/.test(config.database.name)
        ? createProvisionedDistributionManagementResource(config) : undefined;
    const orderSweep = loadOrderSweepRuntime(businessPool);
    const distributionDue = loadDistributionDueRuntime(businessPool, distributionNative?.auth.distributionEarnings);
    const docsImages = businessPool ? loadDocsImageFeature(process.env) : undefined;
    const trashPurge = loadTrashPurgeRuntime(businessPool, docsImages?.enabled ? docsImages.storage : undefined);
    if (businessPool) await assertBusinessRuntimeIdentity(businessPool, config);
    // New-user zero origin trusts the owner's exact resource admission, not a merchant account.
    const nativeWalletOrigin = !businessPool ? undefined : demo ? createDemoNativeWalletOriginResource(demo.demo)
      : config.profile === "dev" || config.profile === "ecs-test" || config.profile === "production"
        ? createProvisionedNativeWalletOriginResource(config)
        : joinpayCollection?.admission ? createNativeWalletOriginResource(joinpayCollection.admission) : undefined;
    app = await createApp({
      health: { dependencies },
      ...(orderSweep ? { orderSweep } : {}),
      ...(distributionDue ? { distributionDue } : {}),
      ...(trashPurge ? { trashPurge } : {}),
      ...(businessPool
        ? {
            database: { pool: businessPool, directoryReadPool },
            auth: {
              ...authConfig!,
              docsImages,
              pool: businessPool,
              ...(withdrawalBankBinding ? { withdrawalBankBinding } : {}),
              ...(joinpayWithdrawal ? { joinpayWithdrawal } : {}),
              ...(joinpayCollection ? { joinpayCollection } : {}),
              ...(nativeWalletOrigin ? { nativeWalletOrigin } : {}),
              ...(joinpayRefund ? { joinpayRefund } : {}),
              ...(joinpayAccounts ? { joinpayAccountRead: joinpayAccounts.read, joinpayAccountObservation: joinpayAccounts.observation } : {}),
              directoryReadPool,
              ...(demoDistributionScope ? { distributionScope:demoDistributionScope, distributionReadScope:demoDistributionScope }
                : distributionNative?.auth ?? distributionEcsTest?.auth ?? {}),
              ...(demo ? { ecsTestDemo:demo, distributionEarnings:demo.earnings, nativeWithdrawalScope:demo.withdrawal.scope, settlementRecordingEnabled:true } : {}),
              ...(distributionManagement ? { distributionManagement } : {}),
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
