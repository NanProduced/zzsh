import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { runBusinessMigrations } = require("../../apps/api/dist/src/database/business-migrations.js");
const canonical = fileURLToPath(new URL("../../apps/api/migrations/business/", import.meta.url));
const journal = JSON.parse(readFileSync(new URL("../../apps/api/migrations/business/meta/_journal.json", import.meta.url)));
const baseline = JSON.parse(readFileSync(new URL("../../apps/api/migrations/initial/release_production_0174/manifest.json", import.meta.url)));

test("production initial plus tail matches canonical identity schema and selected seeds on isolated PostgreSQL", { skip: !process.env.ZZSH_SYNTH_INITIAL_PORT }, async () => {
  const port = process.env.ZZSH_SYNTH_INITIAL_PORT, system = process.env.ZZSH_SYNTH_INITIAL_SYSTEM;
  assert.match(port ?? "", /^[1-9][0-9]{3,4}$/); assert.match(system ?? "", /^[0-9]+$/);
  const connection = database => new Pool({ host: "127.0.0.1", port: Number(port), database, user: "postgres", max: 1, connectionTimeoutMillis: 3000 });
  const admin = connection("postgres"), initial = connection("zzsh_synth_init"), chain = connection("zzsh_synth_chain");
  const targets = [[initial, "zzsh_synth_init", "zzsh:synthetic:initial-chain-v1"], [chain, "zzsh_synth_chain", "zzsh:synthetic:canonical-chain-v1"]];
  try {
    for (const [pool, database, marker] of targets) {
      const row = (await pool.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
        shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
        (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
      assert.deepEqual(row, { database, system, marker, schemas: 0 });
    }
    const roles = (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_synth_runtime') AS runtime,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_order_milestone_real_1_r') AS historical`)).rows[0];
    assert.deepEqual(roles, { runtime: true, historical: false });

    const initialOptions = { runtimeUser: "zzsh_synth_runtime", initialInstall: true, initialBaseline: "release_production_0174" };
    await runBusinessMigrations(initial, initialOptions);
    await runBusinessMigrations(initial, initialOptions);
    // The sealed historical 0105 references this local test role; production initial must not need it.
    await admin.query("CREATE ROLE zzsh_order_milestone_real_1_r NOLOGIN");
    const canonicalOptions = { runtimeUser: "zzsh_synth_runtime", migrationsFolder: canonical };
    await runBusinessMigrations(chain, canonicalOptions);
    await runBusinessMigrations(chain, canonicalOptions);
    await runBusinessMigrations(initial, initialOptions);

    async function snapshot(pool) {
      const columns = (await pool.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid) AS default_value,col_description(a.attrelid,a.attnum) AS comment
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='zzsh_iam.user_legacy_identity_profile'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
      const constraints = (await pool.query(`SELECT conname,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
        WHERE conrelid='zzsh_iam.user_legacy_identity_profile'::regclass ORDER BY conname`)).rows;
      const meta = (await pool.query(`SELECT obj_description('zzsh_iam.user_legacy_identity_profile'::regclass) AS comment,
        has_table_privilege('zzsh_synth_runtime','zzsh_iam.user_legacy_identity_profile','SELECT') AS can_read,
        has_table_privilege('zzsh_synth_runtime','zzsh_iam.user_legacy_identity_profile','INSERT') AS can_insert,
        has_table_privilege('zzsh_synth_runtime','zzsh_iam.user_legacy_identity_profile','UPDATE') AS can_update,
        has_table_privilege('zzsh_synth_runtime','zzsh_iam.user_legacy_identity_profile','DELETE') AS can_delete,
        (SELECT count(*)::int FROM zzsh_business_meta.migrations) AS migrations`)).rows[0];
      const seeds = (await pool.query(`SELECT (SELECT count(*)::int FROM zzsh_iam.admin_permission) AS permissions,
        (SELECT count(*)::int FROM zzsh_iam.admin_role) AS roles,(SELECT count(*)::int FROM zzsh_iam.approval_template) AS approval_templates,
        (SELECT jsonb_agg(jsonb_build_object('normal',normal_days,'early',early_days) ORDER BY singleton) FROM zzsh_order.settlement_refund_policy) AS refund_policy`)).rows[0];
      const listedGuard = (await pool.query(`SELECT pg_get_functiondef('zzsh_supply.guard_legacy_listed_evidence()'::regprocedure) AS definition,
        obj_description('zzsh_supply.guard_legacy_listed_evidence()'::regprocedure,'pg_proc') AS comment`)).rows[0];
      assert.match(listedGuard.definition,/legacy-listed-policy-frozen-v2/);assert.ok(listedGuard.comment);
      assert.equal(columns.length, 11); assert.ok(columns.every(row => typeof row.comment === "string" && row.comment.length > 0));
      assert.ok(meta.comment && meta.can_read && !meta.can_insert && !meta.can_update && !meta.can_delete);
      assert.deepEqual(seeds.refund_policy, [{ normal: 0, early: 7 }]);
      const migrations = meta.migrations; delete meta.migrations;
      return { columns, constraints, meta, seeds, listedGuard, migrations };
    }
    const fromInitial = await snapshot(initial), fromChain = await snapshot(chain);
    assert.equal(fromInitial.migrations, journal.entries.length - baseline.sourceCount + 1);
    assert.equal(fromChain.migrations, journal.entries.length);
    delete fromInitial.migrations; delete fromChain.migrations;
    assert.deepEqual(fromInitial, fromChain);
    const missing = (await initial.query(`SELECT n.nspname AS schema,c.relname AS relation,NULL::text AS column_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND obj_description(c.oid,'pg_class') IS NULL
      UNION ALL SELECT n.nspname,c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND col_description(c.oid,a.attnum) IS NULL
      ORDER BY 1,2,3`, [["zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_order", "zzsh_credit", "zzsh_business_meta"]])).rows;
    assert.deepEqual(missing, [], "production initial plus tail must document every business table and column");
  } finally { await Promise.all([admin.end(), initial.end(), chain.end()]); }
});
