import { randomUUID } from "node:crypto";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { assertContentBootstrapBoss, bootstrapDefaultContent } from "../content/content-bootstrap";
import { bootstrapLegalDocuments } from "../legal/legal-bootstrap";
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
  const bootstrapFlag = process.argv.find(arg => arg === "--bootstrap-content" || arg.startsWith("--bootstrap-content="));
  const actorAdminId = bootstrapFlag?.slice("--bootstrap-content=".length);
  if (bootstrapFlag && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(actorAdminId ?? "")) {
    throw new ConfigurationError("--bootstrap-content=<boss-admin-id> is required");
  }
  const config = loadConfig();
  if (config.profile !== "migration") {
    throw new ConfigurationError("Business migrations require APP_PROFILE=migration");
  }
  const pool = createBusinessPool(config);
  try {
    await assertBusinessMigrationIdentity(pool, config);
    await runBusinessMigrations(pool, { runtimeUser: config.database.runtimeUser, initialInstall, initialBaseline });
    if (actorAdminId) {
      const result = await withTransaction(pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('confirmed-content-bootstrap', 0))");
        await assertContentBootstrapBoss(client, actorAdminId);
        const input = { actorAdminId, requestId: randomUUID() };
        return { content: await bootstrapDefaultContent(client, input), legal: await bootstrapLegalDocuments(client, input) };
      });
      console.log(JSON.stringify(result));
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`Business migration configuration rejected: ${error.message}`);
  } else if (error instanceof SecurityApiError && process.argv.some(arg => arg.startsWith("--bootstrap-content="))) {
    console.error(`Default content initialization rejected: ${error.message}`);
  } else if (error instanceof BusinessMigrationHistoryError) {
    console.error(error.message);
  } else {
    console.error("Business migration failed; target was not reported.");
  }
  process.exitCode = 1;
});
