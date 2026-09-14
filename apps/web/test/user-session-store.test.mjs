import { test } from "node:test";
import assert from "node:assert/strict";
import { UserSessionStore } from "../src/lib/user-session-store.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeTransport {
  constructor() {
    this.sessions = [];
    this.calls = 0;
  }
  session() {
    this.calls += 1;
    const next = this.sessions.shift();
    if (next === undefined) return Promise.resolve({ userId: null });
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "function") return next();
    return Promise.resolve(next);
  }
}

test("an unconfirmed session is loading, not a guest", () => {
  const store = new UserSessionStore(new FakeTransport());
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "loading");
  assert.equal(snapshot.userId, null);
  assert.equal(snapshot.displayName, null);
  store.dispose();
});

test("guest and authenticated states expose only confirmed identity", async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: "user-a", displayName: "用户甲" }, { userId: "user-a", displayName: "用户甲" });
  const store = new UserSessionStore(transport);
  await store.confirm();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "authenticated");
  assert.equal(snapshot.userId, "user-a");
  assert.equal(snapshot.displayName, "用户甲");
  assert.equal(snapshot.identityVersion, 1);
  await store.confirm();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.userId, "user-a");
  assert.equal(snapshot.identityVersion, 1, "same-user refresh is not an identity switch");
  assert.ok(snapshot.revision > 2, "re-confirmation still bumps the revision");
  store.dispose();
});

test("while re-confirming, private identity is hidden without losing identityVersion", async () => {
  const transport = new FakeTransport();
  const held = deferred();
  transport.sessions.push({ userId: "user-a" }, held.promise);
  const store = new UserSessionStore(transport);
  await store.confirm();
  const confirming = store.confirm();
  const pending = store.getSnapshot();
  assert.equal(pending.status, "loading");
  assert.equal(pending.userId, null, "unconfirmed private identity must not render");
  assert.equal(pending.displayName, null);
  held.resolve({ userId: "user-a", displayName: "用户甲" });
  await confirming;
  const settled = store.getSnapshot();
  assert.equal(settled.status, "authenticated");
  assert.equal(settled.userId, "user-a");
  assert.equal(settled.identityVersion, 1);
  store.dispose();
});

test("a session read failure is an error with hidden identity, not a guest", async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: "user-a" }, new Error("offline"), { userId: "user-a" });
  const store = new UserSessionStore(transport);
  await store.confirm();
  await store.confirm();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.userId, null);
  assert.equal(snapshot.identityVersion, 1);
  await store.confirm();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "authenticated");
  assert.equal(snapshot.identityVersion, 1, "same-user recovery keeps private caches valid");
  store.dispose();
});

test("a real identity switch bumps identityVersion and a late old response cannot restore it", async () => {
  const transport = new FakeTransport();
  const held = deferred();
  transport.sessions.push({ userId: "user-a" }, () => held.promise, { userId: "user-b" });
  const store = new UserSessionStore(transport);
  await store.confirm();
  assert.equal(store.getSnapshot().identityVersion, 1);
  const stale = store.confirm();
  await flush();
  await store.confirm();
  assert.equal(store.getSnapshot().userId, "user-b");
  assert.equal(store.getSnapshot().identityVersion, 2);
  held.resolve({ userId: "user-a" });
  await stale;
  await flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.userId, "user-b");
  assert.equal(snapshot.identityVersion, 2);
  store.dispose();
});

test("logout converges to guest while a slower earlier response is discarded", async () => {
  const transport = new FakeTransport();
  const held = deferred();
  transport.sessions.push(() => held.promise, { userId: null });
  const store = new UserSessionStore(transport);
  const stale = store.confirm();
  await flush();
  await store.confirm();
  assert.equal(store.getSnapshot().status, "guest");
  held.resolve({ userId: "user-a", displayName: "用户甲" });
  await stale;
  await flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, "guest");
  assert.equal(snapshot.userId, null);
  assert.equal(snapshot.displayName, null);
  store.dispose();
});

test("dispose discards a late confirmation", async () => {
  const transport = new FakeTransport();
  const held = deferred();
  transport.sessions.push(() => held.promise);
  const store = new UserSessionStore(transport);
  const confirming = store.confirm();
  store.dispose();
  held.resolve({ userId: "user-a" });
  await confirming;
  assert.equal(store.getSnapshot().status, "loading");
  store.dispose();
});

test("confirmations report what they settled on, including superseded races", async () => {
  const transport = new FakeTransport();
  transport.sessions.push({ userId: "user-a" }, new Error("offline"), { userId: null });
  const store = new UserSessionStore(transport);
  assert.equal(await store.confirm(), "authenticated");
  assert.equal(await store.confirm(), "error");
  assert.equal(await store.confirm(), "guest");
  const held = deferred();
  transport.sessions.push(() => held.promise, { userId: "user-b" });
  const first = store.confirm();
  const second = store.confirm();
  held.resolve({ userId: "user-a" });
  assert.equal(await first, "superseded");
  assert.equal(await second, "authenticated");
  store.dispose();
});
