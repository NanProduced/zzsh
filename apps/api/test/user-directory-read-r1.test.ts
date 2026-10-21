import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withDirectoryReadTransaction } from "../src/auth/user-directory-read";

/* H-R1 repairs, positive expectations: each schedule asserts the CORRECT outcome, not the former defect. */
function fixture() {
  const client = new EventEmitter() as EventEmitter & { query: (sql: string) => Promise<unknown>; release: (destroy?: boolean) => void; getTransactionStatus: () => "I" | "T" | "E" | null };
  const queries: string[] = [], releases: (boolean | undefined)[] = [];
  client.query = async sql => { queries.push(sql); return { rows: [] }; };
  client.release = destroy => { releases.push(destroy); };
  client.getTransactionStatus = () => "I";
  const pool = { connect: async () => client } as unknown as Pool;
  return { client, pool, queries, releases };
}
const settle = <T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; message?: string; status?: number | null }> => p.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, message: String((error as Error)?.message ?? error), status: (error as { status?: number })?.status ?? null }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("lease resolved and abort in the same turn: exactly one release, action never runs, abort reason preserved", async () => {
  const f = fixture(); let deliver!: (c: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { deliver = resolve; }) } as unknown as Pool;
  const controller = new AbortController(); let actionCalls = 0;
  const reading = settle(withDirectoryReadTransaction(pool, controller.signal, async () => { actionCalls++; }));
  deliver(f.client as unknown as PoolClient); controller.abort(Object.assign(new Error("abort at lease-resolution boundary"), { status: 499 }));
  const outcome = await reading;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.releases.length, 1, "exactly one release");
  assert.equal(actionCalls, 0);
  assert.equal(outcome.ok, false); assert.equal(outcome.status, 499);
  assert.equal(f.queries.length, 0, "no BEGIN/SET on an aborted-at-boundary lease");
});

test("abort during wait then late lease: single retirement by the side branch, no double release", async () => {
  const f = fixture(); let deliver!: (c: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { deliver = resolve; }) } as unknown as Pool;
  const controller = new AbortController();
  const waiting = settle(withDirectoryReadTransaction(pool, controller.signal, async () => assert.fail("late lease must not run")));
  controller.abort(Object.assign(new Error("closed while queued"), { status: 499 }));
  const outcome = await waiting;
  deliver(f.client as unknown as PoolClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0], true);
  assert.equal(outcome.status, 499);
  assert.equal(f.queries.length, 0);
});

test("in-flight abort completes within the statement budget on the same lease; no cancellation sidecar is created", async () => {
  const f = fixture(); const slow = deferred(); const controller = new AbortController();
  const base = f.client.query;
  let cancelSeen = false;
  f.client.query = async sql => { if (/pg_cancel_backend/.test(sql)) cancelSeen = true; if (sql === "SELECT slow") await slow.promise; return base(sql); };
  const reading = settle(withDirectoryReadTransaction(f.pool, controller.signal, async c => { await c.query("SELECT slow"); }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(Object.assign(new Error("closed mid-statement"), { status: 499 }));
  slow.resolve();
  const outcome = await reading;
  assert.equal(outcome.ok, false); assert.equal(outcome.status, 499);
  assert.equal(cancelSeen, false, "no pg_cancel_backend path may exist");
  assert.equal(f.queries.filter(q => q === "ROLLBACK").length, 1);
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0], false);
});

test("an aborted read with a failing rollback keeps the abort reason and retires the lease once", async () => {
  const f = fixture(); const controller = new AbortController();
  f.client.query = async sql => { if (sql === "ROLLBACK") throw new Error("rollback lost"); return { rows: [] }; };
  const reading = settle(withDirectoryReadTransaction(f.pool, controller.signal, async c => { await c.query("SELECT any"); controller.abort(Object.assign(new Error("closed"), { status: 499 })); await c.query("SELECT next"); }));
  const outcome = await reading;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 499, "abort reason wins over the 57014/rollback failure");
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0], true);
});

test("a completed read followed by a second borrow on the same lease is never cancelled by the first", async () => {
  const f = fixture(); let first = true;
  const pool = { connect: async () => f.client } as unknown as Pool;
  const controllerA = new AbortController();
  const a = await settle(withDirectoryReadTransaction(pool, controllerA.signal, async c => { await c.query("SELECT A"); controllerA.abort(Object.assign(new Error("A closed"), { status: 499 })); await c.query("SELECT A2"); }));
  assert.equal(a.ok, false); assert.equal(a.status, 499);
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0], false, "clean lease returns to the pool");
  const b = await settle(withDirectoryReadTransaction(pool, new AbortController().signal, async c => { await c.query("SELECT B"); return "B succeeded"; }));
  assert(b.ok && b.value === "B succeeded");
  assert.equal(f.releases.length, 2); assert.equal(f.releases[1], false);
  assert(f.queries.includes("SELECT B"));
});
