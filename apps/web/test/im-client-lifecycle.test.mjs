import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ImClientLifecycle,
  ImLifecycleSupersededError,
} from "../src/lib/im-client-lifecycle.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("reuses one client per identity and disposes it on close", async () => {
  const contexts = [];
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    contexts.push(context);
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  const [first, second] = await Promise.all([lifecycle.open(" customer-a "), lifecycle.open("customer-a")]);
  assert.strictEqual(first, second);
  assert.equal(contexts.length, 1);
  assert.deepEqual(lifecycle.getSnapshot().state, "ready");

  const events = [];
  const guarded = contexts[0].onCurrent((event) => events.push(event));
  guarded("connected");
  assert.deepEqual(events, ["connected"]);

  await lifecycle.close();
  guarded("stale");
  assert.deepEqual(events, ["connected"]);
  assert.deepEqual(disposed, ["customer-a"]);
  assert.equal(lifecycle.getSnapshot().state, "idle");
});

test("isolates callbacks and cleanup when switching identities", async () => {
  const contexts = [];
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    contexts.push(context);
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  await lifecycle.open("admin-a");
  const events = [];
  const oldCallback = contexts[0].onCurrent(() => events.push("old"));
  await lifecycle.open("admin-b");
  const newCallback = contexts[1].onCurrent(() => events.push("new"));

  oldCallback();
  newCallback();
  assert.deepEqual(events, ["new"]);
  assert.deepEqual(disposed, ["admin-a"]);

  await lifecycle.close();
  newCallback();
  assert.deepEqual(events, ["new"]);
  assert.deepEqual(disposed, ["admin-a", "admin-b"]);
});

test("disposes a late client when its opening generation is superseded", async () => {
  const gate = deferred();
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    if (context.identity === "late-client") {
      return gate.promise.then(() => ({
        client: { identity: context.identity },
        dispose: () => disposed.push(context.identity),
      }));
    }
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  const opening = lifecycle.open("late-client");
  await new Promise((resolve) => setImmediate(resolve));
  const current = await lifecycle.open("current-client");
  gate.resolve();

  await assert.rejects(opening, (error) => error instanceof ImLifecycleSupersededError);
  assert.deepEqual(disposed, ["late-client"]);
  assert.equal(current.identity, "current-client");
  assert.equal(lifecycle.getSnapshot().identity, "current-client");
  await lifecycle.close();
  assert.deepEqual(disposed, ["late-client", "current-client"]);
});

test("leaves no active client after factory failure and permits a clean retry", async () => {
  let attempts = 0;
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    attempts += 1;
    if (attempts === 1) throw new Error("sdk init failed");
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  await assert.rejects(lifecycle.open("retry-client"), /sdk init failed/);
  assert.equal(lifecycle.getSnapshot().state, "idle");
  await lifecycle.open("retry-client");
  assert.equal(lifecycle.getSnapshot().state, "ready");
  await lifecycle.close();
  assert.deepEqual(disposed, ["retry-client"]);
});
