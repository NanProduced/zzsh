import { ConfigurationError, loadConfig, readSecret } from "../config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../database/business";
import { DisasterRecoveryError, issueDisasterRecovery, type DisasterRecoveryIssueInput } from "./disaster-recovery";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigurationError(`${key} is required`);
  return value;
}

export function readDisasterRecoveryInput(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): DisasterRecoveryIssueInput {
  if (env.M2_DISASTER_RECOVERY_ENABLED?.trim() !== "true") {
    throw new ConfigurationError("M2_DISASTER_RECOVERY_ENABLED=true is required");
  }
  return {
    targetAdminId: required(env, "M2_DISASTER_RECOVERY_TARGET_ADMIN_ID"),
    operatorId: required(env, "M2_DISASTER_RECOVERY_OPERATOR_ID"),
    offlineConfirmationId: required(env, "M2_DISASTER_RECOVERY_OFFLINE_CONFIRMATION_ID"),
    targetRecoveryCredentialHash: readSecret(
      env,
      "M2_DISASTER_RECOVERY_TARGET_CREDENTIAL_HASH",
      "M2_DISASTER_RECOVERY_TARGET_CREDENTIAL_HASH_FILE",
      workingDirectory,
    ),
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  if (config.profile !== "test" || config.database.targetProfile !== "test" || config.database.target !== "local-compose" || config.provider !== "fake") {
    throw new ConfigurationError("disaster recovery CLI is restricted to the isolated test profile and fake providers");
  }
  const input = readDisasterRecoveryInput();
  const pool = createBusinessPool(config);
  try {
    await assertBusinessRuntimeIdentity(pool, config);
    const result = await issueDisasterRecovery(pool, input);
    console.log(JSON.stringify({
      recoveryRequestId: result.recoveryRequestId,
      targetAdminId: result.targetAdminId,
      requestId: result.requestId,
      status: result.status,
      expiresAt: result.expiresAt.toISOString(),
      credentialDelivery: "target_submitted_hash_only",
      notifications: "pre_registered_outbox_only",
    }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    if (error instanceof ConfigurationError || error instanceof DisasterRecoveryError) {
      console.error(`Disaster recovery rejected: ${error.message}`);
    } else {
      console.error("Disaster recovery was not completed; no credential or target secret was reported.");
    }
    process.exitCode = 1;
  });
}
