import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { ConfigurationError, loadConfig } from "../config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../database/business";
import { withTransaction } from "../auth/security-core";
import { previewCreditInitialization, runCreditInitializationBatch, type CreditInitializationInput } from "./credit-initialization";

/**
 * Maintenance runner for one signed credit initialization batch. Not an npm script and not an HTTP route.
 * Input is a package file whose sha256 must equal CREDIT_INIT_PACKAGE_SHA256 (the digest the leader signed);
 * the package names the exact userIds, batchKey, resourceRef and reason. Default mode is preview (read-only);
 * CREDIT_INIT_MODE=APPLY is required to write, and the target resource must equal the package resourceRef.
 */
export type CreditInitializationPackage = { batchKey: string; userIds: string[]; resourceRef: string; reason: string };

export function readCreditInitializationRun(env: NodeJS.ProcessEnv = process.env, read: (path: string) => Buffer = (p) => readFileSync(p)): { mode: "PREVIEW" | "APPLY"; input: CreditInitializationInput } {
  if (env.CREDIT_INIT_ENABLED?.trim() !== "true") throw new ConfigurationError("CREDIT_INIT_ENABLED=true is required");
  const file = env.CREDIT_INIT_PACKAGE_FILE?.trim();
  const expected = env.CREDIT_INIT_PACKAGE_SHA256?.trim().toLowerCase();
  const actor = env.CREDIT_INIT_ACTOR_ADMIN_ID?.trim();
  const resource = env.CREDIT_INIT_RESOURCE_REF?.trim();
  if (!file || !expected || !actor || !resource) throw new ConfigurationError("CREDIT_INIT_PACKAGE_FILE, CREDIT_INIT_PACKAGE_SHA256, CREDIT_INIT_ACTOR_ADMIN_ID and CREDIT_INIT_RESOURCE_REF are required");
  const bytes = read(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) throw new ConfigurationError("package digest does not match the signed digest");
  const pkg = JSON.parse(bytes.toString("utf8")) as CreditInitializationPackage;
  if (pkg.resourceRef !== resource) throw new ConfigurationError("package resourceRef does not match the target resource");
  const mode = env.CREDIT_INIT_MODE?.trim() === "APPLY" ? "APPLY" : "PREVIEW";
  return { mode, input: { actorAdminId: actor, batchKey: pkg.batchKey, userIds: pkg.userIds, inputDigest: digest, resourceRef: pkg.resourceRef, reason: pkg.reason, requestId: `req_credit_init_${randomUUID().replaceAll("-", "")}` } };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const run = readCreditInitializationRun();
  const pool = createBusinessPool(config);
  try {
    await assertBusinessRuntimeIdentity(pool, config);
    const result = run.mode === "APPLY"
      ? await runCreditInitializationBatch(pool, run.input)
      : await withTransaction(pool, (client) => previewCreditInitialization(client, run.input));
    // Counts and ids only; no personal profile fields are read or printed.
    console.log(JSON.stringify({ mode: run.mode, batchKey: run.input.batchKey, result }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof ConfigurationError ? `Credit initialization rejected: ${error.message}` : "Credit initialization was not completed; the transaction was rolled back.");
    process.exitCode = 1;
  });
}
