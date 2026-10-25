import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";
import { ConfigurationError } from "../config/config";

export const BUSINESS_DATABASE = Symbol("BUSINESS_DATABASE");
const DIRECTORY_READ_DATABASE = Symbol("DIRECTORY_READ_DATABASE");

export type BusinessDatabaseOptions = {
  pool: Pool;
  directoryReadPool?: Pool;
};

@Injectable()
export class BusinessDatabaseService implements OnApplicationShutdown {
  constructor(
    @Inject(BUSINESS_DATABASE) private readonly pool: Pool,
    @Inject(DIRECTORY_READ_DATABASE) private readonly directoryReadPool: Pool | null = null,
  ) {}

  getPool(): Pool {
    return this.pool;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.directoryReadPool?.end()]);
  }
}

@Module({})
export class BusinessDatabaseModule {
  static register(options: BusinessDatabaseOptions): DynamicModule {
    return {
      module: BusinessDatabaseModule,
      providers: [
        { provide: BUSINESS_DATABASE, useValue: options.pool },
        { provide: DIRECTORY_READ_DATABASE, useValue: options.directoryReadPool ?? null },
        BusinessDatabaseService,
      ],
      exports: [BusinessDatabaseService],
    };
  }
}

export function createBusinessPool(config: {
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
}, limits: Pick<PoolConfig, "max" | "maxUses"> = {}): Pool {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    application_name: "zzsh-api-business",
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: limits.max ?? 10,
    maxUses: limits.maxUses,
  });
  // pg-pool借出连接时移除idle监听；Client监听让传输错误仍交回查询与事务处理。
  pool.on("connect", (client) => {
    client.on("error", (error: Error) => {
      console.error(JSON.stringify({
        event: "business_pool_client_error",
        code: (error as { code?: string }).code ?? error.name,
        backendPid: (client as unknown as { processID?: number })?.processID ?? null,
      }));
    });
  });
  /* An idle client whose backend died emits 'error' on the pool; without a listener the process
     would crash. The event is recorded in the API log stream; the driver removes the dead client. */
  pool.on("error", (error, client) => {
    console.error(JSON.stringify({
      event: "business_pool_idle_client_error",
      code: (error as { code?: string }).code ?? error.name,
      backendPid: (client as unknown as { processID?: number })?.processID ?? null,
    }));
  });
  return pool;
}

type DatabaseIdentityConfig = {
  database: {
    name: string;
    user: string;
    runtimeUser: string;
  };
};

const BUSINESS_SCHEMA_NAMES = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_order", "zzsh_credit"] as const;

export async function assertBusinessRuntimeIdentity(pool: Pool, config: DatabaseIdentityConfig): Promise<void> {
  const identity = await pool.query<{
    databaseName: string;
    currentUser: string;
    owner: string;
    isSuperuser: boolean;
    canCreateRole: boolean;
    canCreateDb: boolean;
    canReplicate: boolean;
    canBypassRls: boolean;
    canCreateDatabase: boolean;
    canCreateIamSchema: boolean;
    canCreateUserSchema: boolean;
    canCreateAdminSchema: boolean;
    canCreateSupplySchema: boolean;
    canCreateContentSchema: boolean;
    canCreateOrderSchema: boolean;
    canUpdateAudit: boolean;
    canDeleteAudit: boolean;
    canTruncateAudit: boolean;
  }>(`
    SELECT current_database() AS "databaseName", current_user AS "currentUser",
      pg_get_userbyid(d.datdba) AS owner,
      r.rolsuper AS "isSuperuser", r.rolcreaterole AS "canCreateRole",
      r.rolcreatedb AS "canCreateDb", r.rolreplication AS "canReplicate",
      r.rolbypassrls AS "canBypassRls",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabase",
      has_schema_privilege(current_user, 'zzsh_iam', 'CREATE') AS "canCreateIamSchema",
      has_schema_privilege(current_user, 'zzsh_auth_user', 'CREATE') AS "canCreateUserSchema",
      has_schema_privilege(current_user, 'zzsh_auth_admin', 'CREATE') AS "canCreateAdminSchema",
      has_schema_privilege(current_user, 'zzsh_supply', 'CREATE') AS "canCreateSupplySchema",
      COALESCE(has_schema_privilege(current_user, to_regnamespace('zzsh_content')::oid, 'CREATE'), false) AS "canCreateContentSchema",
      has_schema_privilege(current_user, 'zzsh_order', 'CREATE') AS "canCreateOrderSchema",
      has_table_privilege(current_user, 'zzsh_iam.audit_event', 'UPDATE') AS "canUpdateAudit",
      has_table_privilege(current_user, 'zzsh_iam.audit_event', 'DELETE') AS "canDeleteAudit",
      has_table_privilege(current_user, 'zzsh_iam.audit_event', 'TRUNCATE') AS "canTruncateAudit"
    FROM pg_database d
    JOIN pg_roles r ON r.rolname = current_user
    WHERE d.datname = current_database()
  `);
  const ownership = await pool.query<{
    ownsBusinessSchema: boolean;
    ownsBusinessRelation: boolean;
    hasPrivilegedMembership: boolean;
  }>(`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_namespace n
        WHERE n.nspname = ANY($1::text[])
          AND pg_get_userbyid(n.nspowner) = current_user
      ) AS "ownsBusinessSchema",
      EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1::text[])
          AND pg_get_userbyid(c.relowner) = current_user
      ) AS "ownsBusinessRelation",
      EXISTS (
        SELECT 1
        FROM pg_auth_members m
        JOIN pg_roles member ON member.oid = m.member
        WHERE member.rolname = current_user
      ) AS "hasPrivilegedMembership"
  `, [BUSINESS_SCHEMA_NAMES]);
  const row = identity.rows[0];
  const ownershipRow = ownership.rows[0];
  if (
    !row ||
    !ownershipRow ||
    row.databaseName !== config.database.name ||
    row.currentUser !== config.database.runtimeUser ||
    row.currentUser === row.owner ||
    row.isSuperuser ||
    row.canCreateRole ||
    row.canCreateDb ||
    row.canReplicate ||
    row.canBypassRls ||
    row.canCreateDatabase ||
    row.canCreateIamSchema ||
    row.canCreateUserSchema ||
    row.canCreateAdminSchema ||
    row.canCreateSupplySchema ||
    row.canCreateContentSchema ||
    row.canCreateOrderSchema ||
    row.canUpdateAudit ||
    row.canDeleteAudit ||
    row.canTruncateAudit ||
    ownershipRow.ownsBusinessSchema ||
    ownershipRow.ownsBusinessRelation ||
    ownershipRow.hasPrivilegedMembership
  ) {
    throw new ConfigurationError("business runtime identity is not a non-owner runtime role with least privilege");
  }
}

export async function assertBusinessMigrationIdentity(pool: Pool, config: DatabaseIdentityConfig): Promise<void> {
  const result = await pool.query<{ databaseName: string; currentUser: string; owner: string; canCreate: boolean }>(`
    SELECT current_database() AS "databaseName", current_user AS "currentUser",
      pg_get_userbyid(datdba) AS owner,
      has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreate"
    FROM pg_database
    WHERE datname = current_database()
  `);
  const row = result.rows[0];
  if (!row || row.databaseName !== config.database.name || row.currentUser !== config.database.user || row.currentUser === config.database.runtimeUser || row.currentUser === row.owner || !row.canCreate) {
    throw new ConfigurationError("business migration identity is not a separate DDL role");
  }
}
