import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { assertContentBootstrapBoss, bootstrapDefaultContent } from "../content/content-bootstrap";
import { bootstrapLegalDocuments } from "../legal/legal-bootstrap";
import { ConfigurationError, loadConfig } from "../config/config";
import { assertBusinessMigrationIdentity, createBusinessPool } from "./business";
import { initializeFixedFeeDeployment } from "../supply/fixed-fee-first-deployment";
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
  const pricingFlags = process.argv.filter(arg => /^--bootstrap-fixed-fee(?:=|$)/.test(arg));
  const shaFlags = process.argv.filter(arg => /^--bootstrap-fixed-fee-sha256(?:=|$)/.test(arg));
  const packagePath = pricingFlags[0]?.slice("--bootstrap-fixed-fee=".length) ?? "";
  const packageSha256 = shaFlags[0]?.slice("--bootstrap-fixed-fee-sha256=".length) ?? "";
  let pricingPackage: Buffer | undefined;
  if (pricingFlags.length || shaFlags.length) {
    if (pricingFlags.length !== 1 || shaFlags.length !== 1 || !isAbsolute(packagePath) || !/^[a-f0-9]{64}$/.test(packageSha256))
      throw new ConfigurationError("--bootstrap-fixed-fee=<absolute-path> and --bootstrap-fixed-fee-sha256=<sha256> are required together");
    const file = statSync(packagePath);
    if (!file.isFile() || file.size > 1_000_000) throw new ConfigurationError("Initial fixed-fee package is invalid");
    pricingPackage = readFileSync(packagePath);
    if (pricingPackage.length > 1_000_000 || createHash("sha256").update(pricingPackage).digest("hex") !== packageSha256)
      throw new ConfigurationError("Initial fixed-fee package digest differs");
  }
  const config = loadConfig();
  if (config.profile !== "migration") {
    throw new ConfigurationError("Business migrations require APP_PROFILE=migration");
  }
  const pool = createBusinessPool(config);
  try {
    await assertBusinessMigrationIdentity(pool, config);
    await runBusinessMigrations(pool, { runtimeUser: config.database.runtimeUser, initialInstall, initialBaseline });
    if (pricingPackage) {
      const bytes = pricingPackage;
      const result = await withTransaction(pool, client => initializeFixedFeeDeployment(client, bytes, packageSha256));
      console.log(JSON.stringify(result));
    }
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
  } else if (error instanceof SecurityApiError && process.argv.some(arg => arg.startsWith("--bootstrap-fixed-fee="))) {
    console.error("First fixed-fee initialization rejected:", error.code);
  } else if (error instanceof SecurityApiError && process.argv.some(arg => arg.startsWith("--bootstrap-content="))) {
    console.error(`Default content initialization rejected: ${error.message}`);
  } else if (error instanceof BusinessMigrationHistoryError) {
    console.error(error.message);
  } else {
    console.error("Business migration failed; target was not reported.");
  }
  process.exitCode = 1;
});
