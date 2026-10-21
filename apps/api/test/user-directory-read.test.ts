import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withDirectoryRead, withDirectoryReadTransaction } from "../src/auth/user-directory-read";
import { createBusinessPool } from "../src/database/business";

function fixture() {
  const client = new EventEmitter() as EventEmitter & { query: (sql: string) => Promise<unknown>; release: (destroy?: boolean) => void; getTransactionStatus: () => "I" | "T" | "E" | null };
  const queries: string[] = [], releases: (boolean | undefined)[] = [];
  let rollbackError: Error | undefined;
  client.query = async sql => { queries.push(sql); if (sql === "ROLLBACK" && rollbackError) throw rollbackError; return { rows: [] }; };
  client.release = destroy => { releases.push(destroy); };
  client.getTransactionStatus = () => "I";
  const pool = { connect: async () => client } as unknown as Pool;
  return { client, pool, queries, releases, failRollback: (error: Error) => { rollbackError = error; } };
}
const events = () => ({ request: new EventEmitter(), response: Object.assign(new EventEmitter(), { writableFinished: false }) });

test("directory admission rejects a third request before auth/connection work, without blocking other pool users", async () => {
  const f = fixture(), e = events(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const one = withDirectoryRead(f.pool, e.request as never, e.response as never, async () => pending);
  const two = withDirectoryRead(f.pool, e.request as never, e.response as never, async () => pending);
  let entered = false;
  await assert.rejects(withDirectoryRead(f.pool, e.request as never, e.response as never, async () => { entered = true; }), { status: 503 });
  assert.equal(entered, false);
  assert.equal((await f.pool.connect()), f.client);
  release(); await Promise.all([one, two]);
  await withDirectoryRead(f.pool, e.request as never, e.response as never, async () => undefined);
  assert.equal(e.response.listenerCount("close"), 0);
});

test("read transaction sets database budgets before work, rolls back before reuse, never COMMITs", async () => {
  const f = fixture();
  assert.equal(await withDirectoryReadTransaction(f.pool, new AbortController().signal, async c => { await c.query("SELECT safe"); return 7; }), 7);
  assert.deepEqual(f.queries, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','500',true)", "SELECT safe", "ROLLBACK"]);
  assert.deepEqual(f.releases, [false]); assert.equal(f.client.listenerCount("error"), 0);
});

test("explicit retirement closes only its completed read lease and preserves callback failures", async () => {
  const normal=fixture();
  assert.equal(await withDirectoryReadTransaction(normal.pool,new AbortController().signal,async()=>7,true),7);
  assert.equal(normal.queries.at(-1),"ROLLBACK");assert.deepEqual(normal.releases,[true]);
  const failed=fixture(),original=new Error("read failure");
  await assert.rejects(withDirectoryReadTransaction(failed.pool,new AbortController().signal,async()=>{throw original;},true),error=>error===original);
  assert.equal(failed.queries.at(-1),"ROLLBACK");assert.deepEqual(failed.releases,[true]);
});

test("request close retains the lease until executing SELECT ends and rollback is acknowledged; no later SQL", async () => {
  const f = fixture(), e = events(); let started!: () => void, complete!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; }), finish = new Promise<void>(resolve => { complete = resolve; });
  const base = f.client.query; f.client.query = async sql => { if (sql === "SELECT slow") { started(); await finish; } return base(sql); };
  const reading = withDirectoryRead(f.pool, e.request as never, e.response as never, async signal => {
    await withDirectoryReadTransaction(f.pool, signal, async c => { await c.query("SELECT slow"); await c.query("SELECT must_not_run"); });
    assert.fail("closed request must not send a response");
  });
  await active; e.response.emit("close"); assert.equal(f.releases.length, 0);
  complete(); await reading;
  assert.equal(f.queries.includes("SELECT must_not_run"), false); assert.equal(f.queries.at(-1), "ROLLBACK"); assert.deepEqual(f.releases, [false]);
});

test("normal finished response close does not abort or poison the read slot", async () => {
  const f = fixture(), e = events(); e.response.writableFinished = true;
  await withDirectoryRead(f.pool, e.request as never, e.response as never, async signal => { e.response.emit("close"); assert.equal(signal.aborted, false); });
});

test("rollback uncertainty destroys only this read lease and preserves the primary error", async () => {
  const f = fixture(), original = new Error("primary"); f.failRollback(new Error("rollback lost"));
  await assert.rejects(withDirectoryReadTransaction(f.pool, new AbortController().signal, async () => { throw original; }), e => e === original);
  assert.deepEqual(f.releases, [true]); assert.equal(f.queries.filter(q => q === "ROLLBACK").length, 1);
});

test("successful work with failed rollback is never retried or returned to the pool", async () => {
  const f = fixture(), lost = new Error("rollback acknowledgement missing"); f.failRollback(lost);
  await assert.rejects(withDirectoryReadTransaction(f.pool, new AbortController().signal, async () => 1), e => e === lost);
  assert.deepEqual(f.releases, [true]); assert.equal(f.queries.filter(q => q === "ROLLBACK").length, 1);
});

test("server statement cancellation becomes a safe 504 only after confirmed rollback", async () => {
  const f = fixture();
  await assert.rejects(withDirectoryReadTransaction(f.pool, new AbortController().signal, async () => { throw Object.assign(new Error("private SQL"), { code: "57014" }); }), { status: 504, message: "User directory SQL budget exceeded" });
  assert.deepEqual(f.releases, [false]);
});

test("connection error prevents subsequent SQL and destroys the failed lease", async () => {
  const f = fixture(), error = new Error("socket lost");
  await assert.rejects(withDirectoryReadTransaction(f.pool, new AbortController().signal, async c => { f.client.emit("error", error); await c.query("SELECT must_not_run"); }), e => e === error);
  assert.equal(f.queries.includes("SELECT must_not_run"), false); assert.deepEqual(f.releases, [true]);
});

test("an abort during acquisition disposes the late lease without BEGIN", async () => {
  const f = fixture(), controller = new AbortController(); let deliver!: (c: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { deliver = resolve; }) } as unknown as Pool;
  const waiting = withDirectoryReadTransaction(pool, controller.signal, async () => undefined);
  controller.abort(new Error("closed before lease")); deliver(f.client as unknown as PoolClient);
  await assert.rejects(waiting, /closed before lease/); assert.deepEqual(f.queries, []); assert.deepEqual(f.releases, [true]);
});

test("authentication failure releases admission and disconnect during auth never starts a transaction", async () => {
  const f = fixture(), e = events();
  await assert.rejects(withDirectoryRead(f.pool, e.request as never, e.response as never, async () => { throw new Error("auth failure"); }), /auth failure/);
  await withDirectoryRead(f.pool, e.request as never, e.response as never, async signal => { e.request.emit("aborted"); await withDirectoryReadTransaction(f.pool, signal, async () => undefined); });
  assert.deepEqual(f.queries, []); assert.equal(e.request.listenerCount("aborted"), 0);
});

test("acquisition failure returns safe availability error while preserving its internal cause", async () => {
  const error = new Error("private connection failure");
  const pool = { connect: async () => { throw error; } } as unknown as Pool;
  await assert.rejects(withDirectoryReadTransaction(pool, new AbortController().signal, async () => undefined), e => {
    assert.equal((e as any).status, 503); assert.equal((e as any).message, "User directory connection unavailable");
    assert.equal((e as any).cause, error); return true;
  });
});

test("a dirty or unknown lease is disposed without BEGIN, ROLLBACK or touching the prior transaction", async () => {
  for (const state of ["T", "E", null] as const) {
    const f = fixture(); f.client.getTransactionStatus = () => state;
    await assert.rejects(withDirectoryReadTransaction(f.pool, new AbortController().signal, async () => assert.fail("dirty lease used")), { status: 503 });
    assert.deepEqual(f.queries, []); assert.deepEqual(f.releases, [true]);
  }
});

test("abort while waiting for a lease rejects the waiter at once and retires the late lease unused", async () => {
  const f = fixture(), controller = new AbortController(); let deliver!: (c: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { deliver = resolve; }) } as unknown as Pool;
  const waiting = withDirectoryReadTransaction(pool, controller.signal, async () => assert.fail("late lease must not run the action"));
  controller.abort(new Error("closed while queued"));
  await assert.rejects(waiting, /closed while queued/);
  deliver(f.client as unknown as PoolClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.queries, []); assert.deepEqual(f.releases, [true]);
});

test("abort during an in-flight statement keeps the 499 reason and rolls back once", async () => {
  const f = fixture(), controller = new AbortController(); let slow!: () => void;
  const base = f.client.query;
  f.client.query = async sql => { if (sql === "SELECT slow") await new Promise<void>(resolve => { slow = resolve; }); return base(sql); };
  const reading = withDirectoryReadTransaction(f.pool, controller.signal, async c => { await c.query("SELECT slow"); await c.query("SELECT must_not_run"); });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("closed mid-statement"));
  slow!();
  await assert.rejects(reading, /closed mid-statement/);
  assert.equal(f.queries.includes("SELECT must_not_run"), false);
  assert.equal(f.queries.filter(q => q === "ROLLBACK").length, 1);
  assert.deepEqual(f.releases, [false]);
});

test("cancelling one request mid-flight never disturbs a concurrent request on the same pool", async () => {
  const f = fixture();
  const f2 = fixture();
  let i = 0;
  const pool = { connect: async () => (i++ === 0 ? f.client : f2.client) } as unknown as Pool;
  const controllerA = new AbortController(); let releaseSlow!: () => void;
  const slowPromise = new Promise<void>(resolve => { releaseSlow = resolve; });
  f.client.query = async sql => { if (sql === "SELECT slow") await slowPromise; return { rows: [] }; };
  const a = withDirectoryReadTransaction(pool, controllerA.signal, async c => { await c.query("SELECT slow"); });
  await new Promise(resolve => setImmediate(resolve));
  const b = withDirectoryReadTransaction(pool, new AbortController().signal, async c => { await c.query("SELECT fast"); return 9; });
  controllerA.abort(new Error("A closed"));
  releaseSlow();
  await assert.rejects(a, /A closed/);
  assert.equal(await b, 9);
  assert(f2.queries.includes("SELECT fast"));
});

test("an idle backend error is recorded in the API log stream and never crashes the process", async () => {
  const pool = createBusinessPool({ database: { host: "127.0.0.1", port: 1, name: "none", user: "none", password: "none" } });
  const errors: string[] = [];
  const original = console.error;
  console.error = (value: unknown) => { errors.push(String(value)); };
  try {
    (pool as unknown as { emit: (event: string, error: Error, client: unknown) => boolean }).emit("error", Object.assign(new Error("idle socket died"), { code: "57P01" }), { processID: 12345 });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  const parsed = JSON.parse(errors[0]!);
  assert.equal(parsed.event, "business_pool_idle_client_error");
  assert.equal(parsed.code, "57P01");
  assert.equal(parsed.backendPid, 12345);
});

test("the 8s request deadline aborts a stuck read and frees its slot", { timeout: 12_000 }, async () => {
  const f = fixture(), e = events();
  const stuck = withDirectoryRead(f.pool, e.request as never, e.response as never, async signal => {
    await withDirectoryReadTransaction(f.pool, signal, async c => {
      await new Promise<never>((_, reject) => {
        const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("aborted")); };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
  });
  const deadline = Date.now() + 10_000;
  await assert.rejects(stuck, (error: unknown) => (error as { status?: number }).status === 504);
  assert(Date.now() < deadline, "deadline fired at its contract time");
  await withDirectoryRead(f.pool, e.request as never, e.response as never, async () => undefined);
});
