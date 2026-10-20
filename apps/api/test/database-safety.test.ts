import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../src/auth/security-core";
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
