import { createApp } from "./app";
import { ConfigurationError, loadConfig } from "./config/config";
import {
  createFakeHealthDependencies,
  createRealHealthDependencies,
} from "./health/readiness";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "./database/business";
import { loadAuthRuntimeConfig } from "./auth/auth-runtime";

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
  const businessPool = authEnabledValue === "true" ? createBusinessPool(config) : undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    if (businessPool) await assertBusinessRuntimeIdentity(businessPool, config);
    app = await createApp({
      health: { dependencies },
      ...(businessPool
        ? {
            database: { pool: businessPool },
            auth: {
              ...loadAuthRuntimeConfig(undefined, undefined, { testOperationsEnabled: config.testOperationsEnabled }),
              pool: businessPool,
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
