import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool, PoolClient } from "pg";

export const FORMAL_MIGRATIONS_FOLDER = resolve(__dirname, "../../../migrations");
export const FORMAL_MIGRATION_CONFIG = {
  migrationsFolder: FORMAL_MIGRATIONS_FOLDER,
  migrationsSchema: "zzsh_meta",
  migrationsTable: "migrations",
} as const;

export async function runFormalMigrations(pool: Pool | PoolClient): Promise<void> {
  await migrate(drizzle(pool), FORMAL_MIGRATION_CONFIG);
}
