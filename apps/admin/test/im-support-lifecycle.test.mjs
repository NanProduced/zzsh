import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionRefreshCoordinator } from "../src/session-refresh.ts";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "../src/views/im-support-capabilities.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("session refresh coalesces concurrent callers and keeps the strongest redirect request", async () => {
  const response = deferred();
  let loads = 0;
  const applied = [];
  const coordinator = createSessionRefreshCoordinator(
    () => { loads += 1; return response.promise; },
    (snapshot, redirect) => applied.push({ snapshot, redirect }),
  );

  const first = coordinator.refresh(false);
  const second = coordinator.refresh(true);
  assert.strictEqual(first, second);
  assert.equal(loads, 1);

  response.resolve({ session: "current" });
  assert.deepEqual(await Promise.all([first, second]), [{ session: "current" }, { session: "current" }]);
  assert.deepEqual(applied, [{ snapshot: { session: "current" }, redirect: true }]);
});

test("session refresh stays behind an authentication mutation window", async () => {
  let resolveRequest;
  let loads = 0;
  const applied = [];
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const coordinator = createSessionRefreshCoordinator(
    () => { loads += 1; return response; },
    (snapshot) => applied.push(snapshot),
  );

  coordinator.beginMutation();
  const duringMutation = coordinator.refresh(false);
  assert.equal(loads, 0);
  coordinator.endMutation();
  const afterMutation = coordinator.refresh(false);
  assert.equal(loads, 1);
  assert.notStrictEqual(duringMutation, afterMutation);

  resolveRequest({ session: { locked: true } });
  assert.deepEqual(await duringMutation, { session: { locked: true } });
  assert.deepEqual(await afterMutation, { session: { locked: true } });
  assert.deepEqual(applied, [{ session: { locked: true } }]);
});

test("a queued auth refresh waits for a mutation window before starting its tail", async () => {
  const responses = [];
  const applied = [];
  let loads = 0;
  const coordinator = createSessionRefreshCoordinator(() => {
    loads += 1;
    const pending = deferred();
    responses.push(pending);
    return pending.promise;
  }, (snapshot) => applied.push(snapshot));

  const old = coordinator.refresh(false);
  coordinator.invalidate();
  const fresh = coordinator.refresh(false);
  coordinator.invalidate();
  const tail = coordinator.refresh(false);
  coordinator.beginMutation();
  assert.equal(loads, 2);

  responses[0].resolve({ session: { locked: false } });
  responses[1].resolve({ session: { locked: false } });
  await Promise.all([old, fresh]);
  assert.equal(loads, 2);
  assert.deepEqual(applied, []);

  coordinator.endMutation();
  assert.equal(loads, 3);
  responses[2].resolve({ session: { locked: true } });
  assert.deepEqual(await tail, { session: { locked: true } });
  assert.deepEqual(applied, [{ session: { locked: true } }]);
});

test("an invalidated response never applies while the fresh epoch proceeds independently", async () => {
  const oldResponse = deferred();
  const freshResponse = deferred();
  let loads = 0;
  const applied = [];
  const coordinator = createSessionRefreshCoordinator(
    () => { loads += 1; return loads === 1 ? oldResponse.promise : freshResponse.promise; },
    (snapshot) => applied.push(snapshot),
  );

  const old = coordinator.refresh(true);
  coordinator.invalidate();
  const fresh = coordinator.refresh(false);
  assert.equal(coordinator.getEpoch(), 1);
  assert.equal(loads, 2);

  oldResponse.resolve({ session: "old" });
  assert.deepEqual(await old, { session: "old" });
  assert.deepEqual(applied, []);

  freshResponse.resolve({ session: "new" });
  assert.deepEqual(await fresh, { session: "new" });
  assert.deepEqual(applied, [{ session: "new" }]);
});

test("read client identity is stable for send-only changes while type send capability is not", () => {
  const base = { adminUserId: "admin-a", sessionId: "session-a", locked: false, canRead: true };
  assert.equal(createReadClientKey(base), createReadClientKey(base));
  assert.notEqual(createReadClientKey(base), createReadClientKey({ ...base, canRead: false }));

  const serviceOnly = createSendCapabilityKey({ canAccept: true, canComplaint: false });
  const all = createSendCapabilityKey({ canAccept: true, canComplaint: true });
  const none = createSendCapabilityKey({ canAccept: false, canComplaint: true });
  assert.notEqual(serviceOnly, all);
  assert.notEqual(all, none);
  assert.equal(canOperateSupportType("SERVICE", true, false), true);
  assert.equal(canOperateSupportType("COMPLAINT", true, false), false);
  assert.equal(canOperateSupportType("COMPLAINT", true, true), true);
  assert.equal(canOperateSupportType("SERVICE", false, true), false);
});
