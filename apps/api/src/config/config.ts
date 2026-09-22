import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const CONFIG_PROFILES = ["dev", "test", "provider-test", "migration", "ecs-test"] as const;
export type ConfigProfile = (typeof CONFIG_PROFILES)[number];
export const MIGRATION_TARGET_PROFILES = ["dev", "test", "provider-test"] as const;
export type MigrationTargetProfile = (typeof MIGRATION_TARGET_PROFILES)[number];

export const PROVIDER_MODES = ["fake", "real"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

type DatabaseTarget = "local-compose" | "ecs-test";

export type YunxinConfig = {
  enabled: boolean;
  appKey?: string;
  appSecret?: string;
};

export type OrderImSdkRouteConfig = {
  routeEnvironment: string;
  scopes: { appId: string; orderId: string; teamId: string; conversationId: string }[];
  approvedOrders?: { appId: string; orderId: string }[];
};

export type OrderImSdkRouteScope = { appId: string; orderId: string; teamId: string; conversationId: string };
export type OrderImSdkRoute = OrderImSdkRouteScope & { routeEnvironment: string };

export class OrderImSdkRouteError extends Error {
  constructor(readonly code: "ROUTE_NOT_READY" | "ROUTE_SCOPE_MISMATCH") { super(code); }
}

/** Per-process exact bindings for explicitly approved provider-test orders. */
export class OrderImSdkRouteBindings {
  private readonly orders = new Map<string, { appId: string; dynamic: boolean; scopes: Map<string, OrderImSdkRouteScope> }>();
  private readonly teams = new Map<string, { appId: string; teamId: string; accounts: Set<string> }>();
  private readonly restorable: string[] = [];
  private readonly routeEnvironment: string;

  constructor(config: OrderImSdkRouteConfig) {
    this.routeEnvironment = config.routeEnvironment;
    for (const scope of config.scopes) {
      let order = this.orders.get(scope.orderId);
      if (!order) { order = { appId: scope.appId, dynamic: false, scopes: new Map() }; this.orders.set(scope.orderId, order); }
      if (order.dynamic || order.appId !== scope.appId) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG has conflicting order scopes");
      order.scopes.set(scope.conversationId, scope);
    }
    for (const approved of config.approvedOrders ?? []) {
      if (this.orders.has(approved.orderId)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG has conflicting order approvals");
      this.orders.set(approved.orderId, { appId: approved.appId, dynamic: true, scopes: new Map() });
      this.restorable.push(approved.orderId);
    }
  }

  approvedOrderIdsForRestore(): string[] { return [...this.restorable]; }

  isEnrolled(orderId: string): boolean { return this.orders.has(orderId); }

  assertTeamReady(appId: string, orderId: string, teamId: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    if (order.appId !== appId) throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    const bound = this.teams.get(orderId);
    const ready = order.dynamic ? bound?.appId === appId && bound.teamId === teamId
      : [...order.scopes.values()].some(scope => scope.teamId === teamId);
    if (!ready) throw new OrderImSdkRouteError("ROUTE_NOT_READY");
  }

  /** Called only after the exact remote Team and all returned members have passed validation. */
  bindVerifiedTeam(appId: string, orderId: string, teamId: string, accountIds: readonly string[]): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    if (order.appId !== appId || !/^[0-9]{1,19}$/.test(teamId)
      || accountIds.length < 1 || accountIds.some(account => !/^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/.test(account))) {
      throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    }
    const accounts = new Set(accountIds);
    if (accounts.size !== accountIds.length) throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    if (!order.dynamic) {
      if ([...order.scopes.values()].some(scope => scope.teamId !== teamId
        || !accounts.has(scope.conversationId.slice(0, scope.conversationId.indexOf("|2|"))))) {
        throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
      }
      return;
    }
    const current = this.teams.get(orderId);
    if (current && (current.appId !== appId || current.teamId !== teamId)) throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    const merged = new Set(current?.accounts ?? []);
    for (const account of accounts) merged.add(account);
    this.teams.set(orderId, { appId, teamId, accounts: merged });
  }

  forScope(scope: OrderImSdkRouteScope): OrderImSdkRoute | undefined {
    const order = this.orders.get(scope.orderId);
    if (!order) return undefined;
    if (order.appId !== scope.appId) throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    if (order.dynamic) {
      const current = this.teams.get(scope.orderId);
      const conversation = /^([A-Za-z0-9][A-Za-z0-9_@.-]{0,31})\|2\|([0-9]{1,19})$/.exec(scope.conversationId);
      if (!current || current.appId !== scope.appId || current.teamId !== scope.teamId
        || conversation?.[2] !== scope.teamId || !current.accounts.has(conversation[1]!)) {
        throw new OrderImSdkRouteError(current ? "ROUTE_SCOPE_MISMATCH" : "ROUTE_NOT_READY");
      }
    } else {
      const exact = order.scopes.get(scope.conversationId);
      if (!exact || exact.appId !== scope.appId || exact.orderId !== scope.orderId
        || exact.teamId !== scope.teamId) throw new OrderImSdkRouteError("ROUTE_SCOPE_MISMATCH");
    }
    return { ...scope, routeEnvironment: this.routeEnvironment };
  }
}

export function orderImSdkRouteFor(config: OrderImSdkRouteConfig | undefined, scope: {
  appId: string; orderId: string; teamId: string; conversationId: string;
}): (OrderImSdkRouteConfig["scopes"][number] & { routeEnvironment: string }) | undefined {
  const exact = config?.scopes.find(item => item.appId === scope.appId && item.orderId === scope.orderId
    && item.teamId === scope.teamId && item.conversationId === scope.conversationId);
  return exact && config ? { ...exact, routeEnvironment: config.routeEnvironment } : undefined;
}

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
  yunxin: YunxinConfig;
  orderImSdkRouteConfig?: OrderImSdkRouteConfig;
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

function optionalSecret(
  env: NodeJS.ProcessEnv,
  valueKey: string,
  fileKey: string,
  workingDirectory: string,
): string | undefined {
  if (env[valueKey] === undefined && env[fileKey] === undefined) return undefined;
  return readSecret(env, valueKey, fileKey, workingDirectory);
}

function yunxinAppKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.YUNXIN_APP_KEY === undefined) return undefined;
  const value = env.YUNXIN_APP_KEY.trim();
  if (value === "") throw new ConfigurationError("YUNXIN_APP_KEY must not be blank");
  if (value.length > 128 || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new ConfigurationError("YUNXIN_APP_KEY must be a single-line value of at most 128 characters");
  }
  return value;
}

function loadYunxinConfig(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
  profile: ConfigProfile,
): YunxinConfig {
  const enabledValue = env.YUNXIN_ENABLED === undefined ? "false" : env.YUNXIN_ENABLED.trim();
  if (enabledValue !== "true" && enabledValue !== "false") {
    throw new ConfigurationError("YUNXIN_ENABLED must be true or false");
  }
  const enabled = enabledValue === "true";
  const hasCredentials =
    env.YUNXIN_APP_KEY !== undefined ||
    env.YUNXIN_APP_SECRET !== undefined ||
    env.YUNXIN_APP_SECRET_FILE !== undefined;

  if (!enabled) {
    if (hasCredentials) throw new ConfigurationError("YUNXIN credentials require YUNXIN_ENABLED=true");
    return { enabled: false };
  }
  if (profile !== "provider-test") {
    throw new ConfigurationError("YUNXIN_ENABLED=true is only allowed in APP_PROFILE=provider-test");
  }

  const appKey = yunxinAppKey(env);
  if (!appKey) throw new ConfigurationError("YUNXIN_APP_KEY is required when YUNXIN_ENABLED=true");
  const appSecret = optionalSecret(env, "YUNXIN_APP_SECRET", "YUNXIN_APP_SECRET_FILE", workingDirectory);
  if (!appSecret) throw new ConfigurationError("YUNXIN_APP_SECRET or YUNXIN_APP_SECRET_FILE is required");
  return { enabled: true, appKey, appSecret };
}

function loadOrderImSdkRouteConfig(env: NodeJS.ProcessEnv, profile: ConfigProfile, yunxin: YunxinConfig): OrderImSdkRouteConfig | undefined {
  const raw = env.YUNXIN_ORDER_TEST_ROUTE_CONFIG;
  if (raw === undefined) return undefined;
  if (profile !== "provider-test" || env.NODE_ENV === "production" || !yunxin.enabled || !yunxin.appKey || raw.length > 4096) {
    throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is only allowed for a non-production provider-test Yunxin App");
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (!(["routeEnvironment,scopes", "approvedOrders,routeEnvironment,scopes", "approvedOrders,routeEnvironment"].includes(keys))
    || typeof record.routeEnvironment !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(record.routeEnvironment)
    || (record.scopes !== undefined && (!Array.isArray(record.scopes) || record.scopes.length > 8))
    || (record.approvedOrders !== undefined && (!Array.isArray(record.approvedOrders) || record.approvedOrders.length > 8))) {
    throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
  }
  const scopes: OrderImSdkRouteConfig["scopes"] = [];
  const approvedOrders: NonNullable<OrderImSdkRouteConfig["approvedOrders"]> = [];
  const orderApps = new Map<string, string>();
  const seen = new Set<string>();
  for (const candidate of (record.scopes ?? []) as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    const scope = candidate as Record<string, unknown>;
    if (Object.keys(scope).sort().join(",") !== "appId,conversationId,orderId,teamId"
      || scope.appId !== yunxin.appKey
      || typeof scope.orderId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.orderId)
      || typeof scope.teamId !== "string" || !/^[0-9]{1,19}$/.test(scope.teamId)
      || typeof scope.conversationId !== "string") throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    const conversation = /^([A-Za-z0-9][A-Za-z0-9_@.-]{0,31})\|2\|([0-9]{1,19})$/.exec(scope.conversationId);
    if (!conversation || conversation[2] !== scope.teamId) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    const exact = `${scope.appId}|${scope.orderId}|${scope.teamId}|${scope.conversationId}`;
    if (seen.has(exact)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    const previousApp = orderApps.get(scope.orderId);
    if (previousApp && previousApp !== scope.appId) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    orderApps.set(scope.orderId, scope.appId as string);
    seen.add(exact);
    scopes.push({ appId: scope.appId as string, orderId: scope.orderId, teamId: scope.teamId, conversationId: scope.conversationId });
  }
  const approvedIds = new Set<string>();
  for (const candidate of (record.approvedOrders ?? []) as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    const approved = candidate as Record<string, unknown>;
    if (Object.keys(approved).sort().join(",") !== "appId,orderId" || approved.appId !== yunxin.appKey
      || typeof approved.orderId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approved.orderId)
      || approvedIds.has(approved.orderId) || orderApps.has(approved.orderId)) throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
    approvedIds.add(approved.orderId);
    approvedOrders.push({ appId: approved.appId as string, orderId: approved.orderId });
  }
  if (new Set([...orderApps.keys(), ...approvedIds]).size < 1 || new Set([...orderApps.keys(), ...approvedIds]).size > 8) {
    throw new ConfigurationError("YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid");
  }
  return { routeEnvironment: record.routeEnvironment, scopes,
    ...(record.approvedOrders !== undefined ? { approvedOrders } : {}) };
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
  const yunxin = loadYunxinConfig(env, workingDirectory, profile);
  const orderImSdkRouteConfig = loadOrderImSdkRouteConfig(env, profile, yunxin);

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
    yunxin,
    ...(orderImSdkRouteConfig ? { orderImSdkRouteConfig } : {}),
  };
}
