import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { applyRuntimePrivileges } from "../src/database/business-migrations";

// Offline: no PostgreSQL. 0105 creates the table while ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_iam"
// (owner zzsh) hands the runtime role SELECT, INSERT. The post-migration ACL path (run by migrate:business
// after drizzle migrate) must converge that table to SELECT only, without editing 0105 bytes.
const TABLE = "zzsh_iam.user_identity_display_source";

test("0105 stays byte-identical and does not grant INSERT itself", () => {
  const sql = readFileSync(resolve("migrations/business/0105_identity_display_source.sql"), "utf8");
  assert.equal(createHash("sha256").update(sql).digest("hex"), "79e87fb9ec32eb80d6dc29bdef9b348edd87dab495d018d865c9eace16cb609e");
  assert.doesNotMatch(sql, /GRANT[^;]*INSERT[^;]*user_identity_display_source/i);
  assert.match(sql, /GRANT SELECT ON zzsh_iam\.user_identity_display_source TO/);
});

test("applyRuntimePrivileges leaves the runtime role with only SELECT on user_identity_display_source, idempotently", async () => {
  const rights = new Set(["SELECT", "INSERT"]); // state after replaying migrations on a fresh DB (default ACL ar)
  const touched: string[] = [];
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT name,to_regprocedure(name)")) return { rows: (args[0] as string[]).map(name => ({ name, present: false })) };
    if (sql.startsWith("SELECT name,to_regclass")) return { rows: (args[0] as string[]).map(name => ({ name, present: false })) };
    if (sql.includes("count(*)")) return { rows: [{ count: 0, ready: false }] };
    for (const raw of sql.split(";")) {
      const s = raw.replace(/\s+/g, " ").trim();
      const broad = /^GRANT (.+) ON ALL TABLES IN SCHEMA (.+) TO /.exec(s);
      if (broad && broad[2]!.includes('"zzsh_iam"')) { for (const op of broad[1]!.split(",")) rights.add(op.trim()); touched.push(s); continue; }
      const m = /^(GRANT|REVOKE) (.+?) ON TABLE ([\w."]+) (?:TO|FROM) /.exec(s);
      if (!m || m[3]!.replaceAll('"', "") !== TABLE) continue;
      touched.push(s);
      const ops = m[2] === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] : m[2]!.split(",").map(x => x.trim());
      for (const op of ops) m[1] === "GRANT" ? rights.add(op) : rights.delete(op);
    }
    return { rows: [{ relation: null, present: false, proof: false, initializer: false, allocator: null, ready: false }] };
  } } as unknown as Pick<Pool, "query">;
  await applyRuntimePrivileges(pool, "runtime_role");
  assert.deepEqual([...rights].sort(), ["SELECT"]);
  assert.ok(touched.some(s => s.startsWith("REVOKE ALL ON TABLE")));
  await applyRuntimePrivileges(pool, "runtime_role");
  assert.deepEqual([...rights].sort(), ["SELECT"]);
});
