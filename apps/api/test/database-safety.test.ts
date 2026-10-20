import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../src/auth/security-core";
import { assertBusinessRuntimeIdentity } from "../src/database/business";
import { closeResource, finishDatabaseTest } from "./database-test-support";

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

type ScriptedClient = PoolClient & { queries: string[]; releases: (boolean | undefined)[] };

function scriptedClient(failures: { begin?: Error; commit?: Error; rollback?: Error } = {}): ScriptedClient {
  const queries: string[] = [];
  const releases: (boolean | undefined)[] = [];
  return {
    queries,
    releases,
    async query(text: string) {
      queries.push(text);
      if (text === "BEGIN" && failures.begin) throw failures.begin;
      if (text === "COMMIT" && failures.commit) throw failures.commit;
      if (text === "ROLLBACK" && failures.rollback) throw failures.rollback;
      return { rows: [] };
    },
    release(destroy?: boolean) {
      releases.push(destroy);
    },
  } as unknown as ScriptedClient;
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

test("withTransaction commits the callback result and returns the client to the pool", async () => {
  const client = scriptedClient();
  const result = await withTransaction(poolFor(client), async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction rethrows the callback error and reuses the client after a confirmed ROLLBACK", async () => {
  const client = scriptedClient();
  const failure = new Error("callback failure");
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => { throw failure; }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction retires the client exactly once when ROLLBACK is not confirmed", async () => {
  const failure = new Error("callback failure");
  const client = scriptedClient({ rollback: new Error("rollback not acknowledged") });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => { throw failure; }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [true]);
});

test("withTransaction keeps the COMMIT error even when ROLLBACK is acknowledged", async () => {
  const commitFailure = new Error("commit outcome unknown");
  const client = scriptedClient({ commit: commitFailure });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === commitFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction retires the client when neither COMMIT nor ROLLBACK is confirmed", async () => {
  const commitFailure = new Error("commit outcome unknown");
  const client = scriptedClient({ commit: commitFailure, rollback: new Error("rollback not acknowledged") });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === commitFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.deepEqual(client.releases, [true]);
});

test("withTransaction rolls back and releases normally when BEGIN fails", async () => {
  const beginFailure = new Error("begin rejected");
  const client = scriptedClient({ begin: beginFailure });
  await assert.rejects(
    () => withTransaction(poolFor(client), async () => "unreachable"),
    (error: unknown) => error === beginFailure,
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.releases, [undefined]);
});

test("withTransaction propagates a pool connect failure without releasing a client", async () => {
  const connectFailure = new Error("pool unavailable");
  let connects = 0;
  const pool = {
    connect: async () => {
      connects += 1;
      throw connectFailure;
    },
  } as unknown as Pool;
  await assert.rejects(
    () => withTransaction(pool, async () => "unreachable"),
    (error: unknown) => error === connectFailure,
  );
  assert.equal(connects, 1);
});

type CapturedQuery = { sql: string; args: unknown[] };

function runtimeIdentityPool(options: {
  identity?: Record<string, unknown> | null;
  ownership?: Record<string, unknown> | null;
}): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const pool = {
    async query(sql: string, args?: unknown[]) {
      queries.push({ sql, args: args ?? [] });
      if (sql.includes("ownsBusinessSchema")) {
        return { rows: options.ownership === null ? [] : [options.ownership ?? { ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false }] };
      }
      return { rows: options.identity === null ? [] : [options.identity] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function leastPrivilegeIdentityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseName: "zzsh_business",
    currentUser: "zzsh_runtime",
    owner: "zzsh_owner",
    isSuperuser: false,
    canCreateRole: false,
    canCreateDb: false,
    canReplicate: false,
    canBypassRls: false,
    canCreateDatabase: false,
    canCreateIamSchema: false,
    canCreateUserSchema: false,
    canCreateAdminSchema: false,
    canCreateSupplySchema: false,
    canCreateOrderSchema: false,
    canCreateContentSchema: false,
    canUpdateAudit: false,
    canDeleteAudit: false,
    canTruncateAudit: false,
    ...overrides,
  };
}

const RUNTIME_IDENTITY_CONFIG = { database: { name: "zzsh_business", user: "zzsh_migration", runtimeUser: "zzsh_runtime" } };

test("runtime identity probes content schema ownership and CREATE while accepting a least-privilege role", async () => {
  const { pool, queries } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow() });
  await assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG);
  const identityQuery = queries.find((entry) => entry.sql.includes('"databaseName"'));
  const ownershipQuery = queries.find((entry) => entry.sql.includes("ownsBusinessSchema"));
  assert.ok(identityQuery && ownershipQuery);
  assert.match(identityQuery.sql, /COALESCE\(has_schema_privilege\(current_user, to_regnamespace\('zzsh_content'\)::oid, 'CREATE'\), false\)/,
    "content CREATE probe must resolve the optional schema by OID so a missing schema yields false instead of throwing 3F000");
  assert.doesNotMatch(identityQuery.sql, /has_schema_privilege\(current_user, 'zzsh_content', 'CREATE'\)/,
    "the name overload throws undefined_schema when the optional content schema is absent");
  const schemas = ownershipQuery.args[0] as string[];
  assert.ok(schemas.includes("zzsh_content"), "ownership probe must cover the content schema");
  assert.equal(schemas.length, 8);
});

test("runtime identity rejects a role owning the content schema", async () => {
  const { pool } = runtimeIdentityPool({
    identity: leastPrivilegeIdentityRow(),
    ownership: { ownsBusinessSchema: true, ownsBusinessRelation: false, hasPrivilegedMembership: false },
  });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity rejects a role owning a content relation", async () => {
  const { pool } = runtimeIdentityPool({
    identity: leastPrivilegeIdentityRow(),
    ownership: { ownsBusinessSchema: false, ownsBusinessRelation: true, hasPrivilegedMembership: false },
  });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity rejects a role holding CREATE on the content schema", async () => {
  const { pool } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow({ canCreateContentSchema: true }) });
  await assert.rejects(() => assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG), /least privilege/);
});

test("runtime identity treats a NULL content CREATE projection (absent schema) as no privilege, not a violation", async () => {
  const { pool } = runtimeIdentityPool({ identity: leastPrivilegeIdentityRow({ canCreateContentSchema: null }) });
  await assertBusinessRuntimeIdentity(pool, RUNTIME_IDENTITY_CONFIG);
});
