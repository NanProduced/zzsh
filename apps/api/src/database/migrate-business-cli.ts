import { ConfigurationError, loadConfig } from "../config/config";
import { assertBusinessMigrationIdentity, createBusinessPool } from "./business";
import { BusinessMigrationHistoryError, runBusinessMigrations } from "./business-migrations";

async function main(): Promise<void> {
  const initialInstall = process.argv.includes("--initial");
  const baselineFlag = process.argv.find(arg => arg.startsWith("--baseline="));
  const baselineIndex = process.argv.indexOf("--baseline");
  const initialBaseline = baselineFlag ? baselineFlag.slice("--baseline=".length) : baselineIndex >= 0 ? process.argv[baselineIndex + 1] : undefined;
  const baselineRequested = baselineFlag !== undefined || baselineIndex >= 0;
  if (baselineRequested && !initialInstall) throw new ConfigurationError("--baseline requires --initial");
  if (baselineRequested && !/^release_[a-zA-Z0-9_]{1,60}$/.test(initialBaseline ?? "")) throw new ConfigurationError("baseline name is invalid");
  const config = loadConfig();
  if (config.profile !== "migration") {
    throw new ConfigurationError("Business migrations require APP_PROFILE=migration");
  }
  const pool = createBusinessPool(config);
  try {
    await assertBusinessMigrationIdentity(pool, config);
    await runBusinessMigrations(pool, { runtimeUser: config.database.runtimeUser, initialInstall, initialBaseline });
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`Business migration configuration rejected: ${error.message}`);
  } else if (error instanceof BusinessMigrationHistoryError) {
    console.error(error.message);
  } else {
    console.error("Business migration failed; target was not reported.");
  }
  process.exitCode = 1;
});
