import { createApp } from "./app";
import { ConfigurationError, loadConfig } from "./config/config";
import {
  createFakeHealthDependencies,
  createRealHealthDependencies,
} from "./health/readiness";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "./database/business";
import { loadAuthRuntimeConfig } from "./auth/auth-runtime";
import { createLocalDistributionReadScope } from "./finance/distribution-policy-store";
// Root-accepted local copy identity. This capability only admits existing facts to GET.
const milestoneDistributionReceipt={database:"zzsh_test_order_milestone_real_1",resourceOid:952624,owner:"zzsh",ownerOid:10,marker:"zzsh:order-reservation-test:v1",migrationRole:"zzsh_order_milestone_real_1_m",migrationRoleOid:952625,runtimeRole:"zzsh_order_milestone_real_1_r",runtimeRoleOid:952626};

export async function bootstrap() {
  const config = loadConfig();
  const authEnabledValue = process.env.AUTH_ENABLED?.trim() || "false";
  if (authEnabledValue !== "true" && authEnabledValue !== "false") {
    throw new ConfigurationError("AUTH_ENABLED must be true or false");
  }
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
    if (businessPool) await assertBusinessRuntimeIdentity(businessPool, config);
    app = await createApp({
      health: { dependencies },
      ...(businessPool
        ? {
            database: { pool: businessPool, directoryReadPool },
            auth: {
              ...loadAuthRuntimeConfig(undefined, undefined, { testOperationsEnabled: config.testOperationsEnabled }),
              pool: businessPool,
              directoryReadPool,
              ...(config.database.name===milestoneDistributionReceipt.database?{distributionReadScope:createLocalDistributionReadScope(config,milestoneDistributionReceipt)}:{}),
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
