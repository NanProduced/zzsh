import { createApp } from "./app";
import { ConfigurationError, loadConfig } from "./config/config";
import {
  createFakeHealthDependencies,
  createRealHealthDependencies,
} from "./health/readiness";

export async function bootstrap() {
  const config = loadConfig();
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
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ health: { dependencies } });
    await app.listen(config.port, config.host);
  } catch (error) {
    if (app) await app.close();
    else await Promise.allSettled([
      dependencies.postgres.close(),
      dependencies.redis.close(),
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
