import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool } from "pg";

import { assertBusinessMigrationPrefix } from "../src/database/business-migrations";

const folder = resolve("migrations/business");
const migrations = readMigrationFiles({ migrationsFolder: folder });
const history = migrations.map((migration) => ({ hash: migration.hash, createdAt: String(migration.folderMillis) }));
const tags = (JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> })
  .entries.map((entry) => entry.tag);
const handover = tags.indexOf("0181_complaint_active_handover");
const repair = tags.indexOf("0182_complaint_handover_role_status");

function fixture(rows: Array<{ hash: string; createdAt: string }>): Pool {
  return { query: async (sql: string) => ({
    rows: sql.includes("to_regclass") ? [{ present: true }] : rows,
  }) } as unknown as Pool;
}

test("0181 and 0182 are adjacent and may both be pending", async () => {
  assert.ok(handover >= 0 && repair === handover + 1, "the repair stays immediately after the snapshot migration");
  await assertBusinessMigrationPrefix(fixture(history.slice(0, handover)));
});

test("a split 0181/0182 upgrade is refused before DDL", async () => {
  await assert.rejects(
    assertBusinessMigrationPrefix(fixture(history.slice(0, repair))),
    (error: { reason?: string; index?: number }) => error.reason === "SPLIT_COMPLAINT_HANDOVER" && error.index === repair,
  );
});

test("both applied together remain an accepted prefix", async () => {
  await assertBusinessMigrationPrefix(fixture(history.slice(0, repair + 1)));
});
