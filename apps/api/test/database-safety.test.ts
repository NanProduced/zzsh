import { strict as assert } from "node:assert";
import { test } from "node:test";

import { closeResource, finishDatabaseTest } from "./database-test-support";
import { applyRuntimePrivileges, configureSkinIdentityPrivileges } from "../src/database/business-migrations";

test("identity failure closes the resource without DROP or CREATE", async () => {
  const events: string[] = [];
  let authorized = true;
  try {
    events.push("IDENTITY");
    throw new Error("wrong database identity");
  } catch {
    authorized = false;
  }
  await closeResource(
    authorized,
    { release: (destroy) => events.push(destroy ? "release:destroy" : "release") },
    async () => {
      events.push("DROP/CREATE");
    },
  );
  assert.deepEqual(events, ["IDENTITY", "release:destroy"]);
});

test("cleanup failure still closes both pools and preserves the primary error", async () => {
  const events: string[] = [];
  const primaryError = new Error("primary failure");
  await assert.rejects(
    () =>
      finishDatabaseTest(
        primaryError,
        async () => {
          events.push("reset");
          throw new Error("reset cleanup failure");
        },
        async () => {
          events.push("test:end");
        },
        async () => {
          events.push("admin:end");
        },
      ),
    (error: unknown) => error === primaryError,
  );
  assert.deepEqual(events, ["reset", "test:end", "admin:end"]);
});

const skinMetadataColumns = ["rarity_evidence", "is_collectible", "default_state", "media_source"];

function skinAclFixture(metadata: readonly string[]) {
  const writes: string[] = [];
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.includes("count(*)")) {
      const names = args[0] as string[];
      return { rows: [{ count: names.includes("owner_kind") ? 7 : names.filter(name => metadata.includes(name)).length }] };
    }
    if (sql.includes("AS present")) return { rows: [{ present: true }] };
    writes.push(sql); return { rows: [] };
  } } as unknown as Parameters<typeof configureSkinIdentityPrivileges>[0];
  return { pool, writes };
}

test("skin ACL grants new metadata only for the complete schema and keeps derived and stable fields denied", async () => {
  for (const metadata of [[], skinMetadataColumns]) {
    const f = skinAclFixture(metadata);
    await configureSkinIdentityPrivileges(f.pool, "fixture_runtime");
    assert.equal(f.writes.length, 1);
    const sql = f.writes[0]!;
    assert.match(sql, /REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply\.skin FROM/);
    assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|ALL)(?:\s*,[^()]*)?\s+ON (?:TABLE\s+)?zzsh_supply\.skin\s+TO/i);
    const insert = /GRANT INSERT \(([^)]+)\) ON zzsh_supply\.skin TO/.exec(sql)![1]!.split(",");
    const update = /GRANT UPDATE \(([^)]+)\) ON zzsh_supply\.skin TO/.exec(sql)![1]!.split(",");
    for (const field of skinMetadataColumns) {
      assert.equal(insert.includes(field), metadata.length === 4, `INSERT ${field}`);
      assert.equal(update.includes(field), metadata.length === 4, `UPDATE ${field}`);
    }
    for (const field of ["naming_state", "created_at", "updated_at"]) {
      assert.equal(insert.includes(field), false, `INSERT ${field} stays denied`);
      assert.equal(update.includes(field), false, `UPDATE ${field} stays denied`);
    }
    for (const field of ["id", "game_id", "code"]) assert.equal(update.includes(field), false, `UPDATE ${field} stays denied`);
    for (const field of ["owner_kind", "owner_id", "firearm_id", "base_name"]) assert.equal(insert.includes(field), false, `INSERT ${field} stays denied`);
    assert.ok(update.includes("owner_kind"));
    assert.ok(insert.includes("aliases"));
  }
});

test("skin ACL refuses every partial metadata schema before issuing an ACL write", async () => {
  for (const metadata of [skinMetadataColumns.slice(0, 1), skinMetadataColumns.slice(0, 2), skinMetadataColumns.slice(0, 3), ["media_source"]]) {
    const f = skinAclFixture(metadata);
    await assert.rejects(configureSkinIdentityPrivileges(f.pool, "fixture_runtime"), /Skin metadata schema is incomplete/);
    assert.deepEqual(f.writes, [], `partial schema ${metadata.join(",")} sends no grant`);
  }
});

function fundingAclFixture(present: readonly unknown[], incompleteInventory = false) {
  const seen: string[] = [];
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    seen.push(sql);
    if (sql.startsWith("SELECT name,to_regprocedure(name)")) return { rows: (args[0] as string[]).slice(0, incompleteInventory ? 1 : 2).map((name, index) => ({ name, present: present[index] })) };
    if (sql.startsWith("SELECT name,to_regclass")) return { rows: (args[0] as string[]).map(name => ({ name, present: false })) };
    if (sql.includes("count(*)")) return { rows: [{ count: 0, ready: false }] };
    return { rows: [{ relation: null, present: false, proof: false, initializer: false, allocator: null, ready: false }] };
  } } as unknown as Parameters<typeof applyRuntimePrivileges>[0];
  return { pool, seen, grants: () => seen.filter(sql => sql.includes("GRANT EXECUTE ON FUNCTION zzsh_supply.valid_funding_policy_legacy_v1")) };
}

test("funding validator ACL leaves the old prefix alone and explicitly grants only the complete v2 function set", async () => {
  const old = fundingAclFixture([false, false]);
  await applyRuntimePrivileges(old.pool, "fixture_runtime");
  assert.deepEqual(old.grants(), []);
  const current = fundingAclFixture([true, true]);
  await applyRuntimePrivileges(current.pool, "fixture_runtime");
  const first = [...current.seen];
  assert.equal(current.grants().length, 1);
  const sql = current.grants()[0]!;
  assert.match(sql, /valid_funding_policy_legacy_v1\(jsonb\)/);
  assert.match(sql, /valid_funding_policy_draft\(jsonb\)/);
  assert.match(sql, /zzsh_supply\.valid_funding_policy\(jsonb\) TO "fixture_runtime"/);
  assert.doesNotMatch(sql, /ALL FUNCTIONS|PUBLIC|SECURITY DEFINER/);
  current.seen.length = 0;
  await applyRuntimePrivileges(current.pool, "fixture_runtime");
  assert.deepEqual(current.seen, first, "the same common ACL entry converges on repeated invocation");
});

test("funding validator ACL refuses either partial deployment and incomplete or unknown inventory", async () => {
  for (const present of [[true, false], [false, true]]) {
    const f = fundingAclFixture(present);
    await assert.rejects(applyRuntimePrivileges(f.pool, "fixture_runtime"), /Funding validator schema is incomplete/);
    assert.deepEqual(f.grants(), []);
  }
  for (const f of [fundingAclFixture([true, true], true), fundingAclFixture([undefined, false]), fundingAclFixture(["false", false])]) {
    await assert.rejects(applyRuntimePrivileges(f.pool, "fixture_runtime"), /Funding validator inventory is incomplete/);
    assert.deepEqual(f.grants(), []);
  }
});
