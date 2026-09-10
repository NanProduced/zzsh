import { ConfigurationError, loadConfig } from "../config/config";
import { assertBusinessMigrationIdentity, createBusinessPool } from "./business";
import { runBusinessMigrations } from "./business-migrations";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.profile !== "migration") {
    throw new ConfigurationError("Business migrations require APP_PROFILE=migration");
  }
  const pool = createBusinessPool(config);
  try {
    await assertBusinessMigrationIdentity(pool, config);
    await runBusinessMigrations(pool, { runtimeUser: config.database.runtimeUser });
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`Business migration configuration rejected: ${error.message}`);
  } else {
    console.error("Business migration failed; target was not reported.");
  }
  process.exitCode = 1;
});
