import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const CONFIG_PROFILES = ["dev", "test", "provider-test", "migration", "ecs-test"] as const;
export type ConfigProfile = (typeof CONFIG_PROFILES)[number];
export const MIGRATION_TARGET_PROFILES = ["dev", "test", "provider-test"] as const;
export type MigrationTargetProfile = (typeof MIGRATION_TARGET_PROFILES)[number];

export const PROVIDER_MODES = ["fake", "real"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

type DatabaseTarget = "local-compose" | "ecs-test";

export type AppConfig = {
  profile: ConfigProfile;
  provider: ProviderMode;
  testOperationsEnabled: boolean;
  host: string;
  port: number;
  database: {
    target: DatabaseTarget;
    targetProfile: MigrationTargetProfile;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    runtimeUser: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
  providerTestScope?: string;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const LOCAL_HOST = "127.0.0.1";
const LOCAL_DB_PORT = 55432;
const LOCAL_REDIS_PORT = 56379;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PROFILE_DATABASE_PREFIX: Record<ConfigProfile, string> = {
  dev: "zzsh_dev",
  test: "zzsh_test",
  "provider-test": "zzsh_provider_test",
  migration: "zzsh_migration",
  "ecs-test": "zzsh_ecs_test",
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") throw new ConfigurationError(`${key} is required`);
  return value;
}

function parsePort(env: NodeJS.ProcessEnv, key: string, fallback?: number): number {
  const raw = env[key] === undefined ? String(fallback ?? "") : env[key]!;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`${key} must be between 1 and 65535`);
  }
  return port;
}

export function readSecret(
  env: NodeJS.ProcessEnv,
  valueKey: string,
  fileKey: string,
  workingDirectory: string,
): string {
  const fileValue = env[fileKey];
  if (fileValue !== undefined) {
    const file = fileValue.trim();
    if (file === "") throw new ConfigurationError(`${fileKey} must not be blank`);
    if (isAbsolute(file)) throw new ConfigurationError(`${fileKey} must be relative to .secrets`);
    const root = resolve(workingDirectory, ".secrets");
    const path = resolve(workingDirectory, file);
    const pathFromRoot = relative(root, path);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new ConfigurationError(`${fileKey} must point inside .secrets`);
    }
    try {
      const secret = readFileSync(path, "utf8").trim();
      if (secret !== "") return secret;
    } catch {
      throw new ConfigurationError(`${fileKey} could not be read`);
    }
    throw new ConfigurationError(`${fileKey} must point to a non-empty file`);
  }
  return required(env, valueKey).trim();
}

function assertIdentifier(value: string, key: string): void {
  if (!IDENTIFIER.test(value)) throw new ConfigurationError(`${key} must be a safe identifier`);
}

function assertDatabaseName(profile: ConfigProfile, name: string, key = "DB_NAME"): void {
  assertIdentifier(name, key);
  const prefix = PROFILE_DATABASE_PREFIX[profile];
  if (name !== prefix && !name.startsWith(`${prefix}_`)) {
    throw new ConfigurationError(`${key} is outside the ${profile} target boundary`);
  }
}

function migrationTargetProfile(env: NodeJS.ProcessEnv): MigrationTargetProfile {
  const value = required(env, "MIGRATION_TARGET_PROFILE");
  if (!MIGRATION_TARGET_PROFILES.includes(value as MigrationTargetProfile)) {
    throw new ConfigurationError("MIGRATION_TARGET_PROFILE is invalid");
  }
  return value as MigrationTargetProfile;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const profileValue = env.APP_PROFILE === undefined ? "dev" : env.APP_PROFILE.trim();
  if (!CONFIG_PROFILES.includes(profileValue as ConfigProfile)) {
    throw new ConfigurationError("APP_PROFILE is invalid");
  }
  const profile = profileValue as ConfigProfile;
  if (profile === "ecs-test") {
    throw new ConfigurationError("APP_PROFILE=ecs-test is disabled until an isolated target is confirmed and registered");
  }

  const providerValue = env.PROVIDER_MODE === undefined ? "fake" : env.PROVIDER_MODE.trim();
  if (!PROVIDER_MODES.includes(providerValue as ProviderMode)) {
    throw new ConfigurationError("PROVIDER_MODE is invalid");
  }
  const provider = providerValue as ProviderMode;

  const host = env.HOST === undefined ? LOCAL_HOST : env.HOST.trim();
  if (host === "") throw new ConfigurationError("HOST is required");
  if (host !== LOCAL_HOST) {
    throw new ConfigurationError("HOST must remain loopback outside ecs-test");
  }
  const port = parsePort(env, "PORT", 3102);

  const target = required(env, "DB_TARGET") as DatabaseTarget;
  if (target !== "local-compose" && target !== "ecs-test") {
    throw new ConfigurationError("DB_TARGET is invalid");
  }
  if (target !== "local-compose") {
    throw new ConfigurationError("DB_TARGET does not match APP_PROFILE");
  }

  const databaseHost = required(env, "DB_HOST").trim();
  const databasePort = parsePort(env, "DB_PORT");
  const targetProfile = profile === "migration" ? migrationTargetProfile(env) : profile;
  const databaseNameKey = profile === "migration" ? "MIGRATION_TARGET_DB_NAME" : "DB_NAME";
  const databaseName = required(env, databaseNameKey).trim();
  const databaseUserKey = profile === "migration" ? "MIGRATION_DB_USER" : "DB_USER";
  const databaseUser = required(env, databaseUserKey).trim();
  assertDatabaseName(targetProfile, databaseName, databaseNameKey);
  assertIdentifier(databaseUser, databaseUserKey);
  const runtimeUser = profile === "migration"
    ? required(env, "MIGRATION_RUNTIME_USER").trim()
    : databaseUser;
  if (profile === "migration" && databaseUser === runtimeUser) {
    throw new ConfigurationError("migration and runtime database users must be different");
  }
  assertIdentifier(runtimeUser, profile === "migration" ? "MIGRATION_RUNTIME_USER" : "DB_USER");
  const databasePassword = readSecret(
    env,
    profile === "migration" ? "MIGRATION_DB_PASSWORD" : "DB_PASSWORD",
    profile === "migration" ? "MIGRATION_DB_PASSWORD_FILE" : "DB_PASSWORD_FILE",
    workingDirectory,
  );

  const redisHost = required(env, "REDIS_HOST").trim();
  const redisPort = parsePort(env, "REDIS_PORT");
  const redisPassword = readSecret(env, "REDIS_PASSWORD", "REDIS_PASSWORD_FILE", workingDirectory);

  if (target === "local-compose") {
    if (databaseHost !== LOCAL_HOST || redisHost !== LOCAL_HOST) {
      throw new ConfigurationError("local-compose databases must use 127.0.0.1");
    }
    if (databasePort !== LOCAL_DB_PORT || redisPort !== LOCAL_REDIS_PORT) {
      throw new ConfigurationError("local-compose ports are outside the zzsh boundary");
    }
  }

  const providerTestScope = env.PROVIDER_TEST_SCOPE?.trim();
  if (profile === "provider-test" && !providerTestScope) {
    throw new ConfigurationError("PROVIDER_TEST_SCOPE is required for provider-test");
  }
  if ((profile === "test" || profile === "migration") && provider !== "fake") {
    throw new ConfigurationError(`${profile} requires PROVIDER_MODE=fake`);
  }
  if (provider === "real" && profile !== "provider-test") {
    throw new ConfigurationError("PROVIDER_MODE=real is only allowed in provider-test");
  }
  const testOperationsValue = env.ENABLE_TEST_OPERATIONS?.trim() || "false";
  if (testOperationsValue !== "true" && testOperationsValue !== "false") {
    throw new ConfigurationError("ENABLE_TEST_OPERATIONS must be true or false");
  }
  const testOperationsEnabled = testOperationsValue === "true";
  if (testOperationsEnabled && (profile !== "test" || provider !== "fake")) {
    throw new ConfigurationError("ENABLE_TEST_OPERATIONS=true requires APP_PROFILE=test and PROVIDER_MODE=fake");
  }

  return {
    profile,
    provider,
    testOperationsEnabled,
    host,
    port,
    database: {
      target,
      targetProfile,
      host: databaseHost,
      port: databasePort,
      name: databaseName,
      user: databaseUser,
      password: databasePassword,
      runtimeUser,
    },
    redis: { host: redisHost, port: redisPort, password: redisPassword },
    providerTestScope,
  };
}
