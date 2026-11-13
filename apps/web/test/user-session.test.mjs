import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserUserSessionStore, performSignOut, requestSignOut } from "../src/lib/user-session-client.ts";
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test("only the contract null is a guest; broken reads are errors", async () => {
  const cases = [
    [() => new Response("{not-json", { status: 200 }), "error"],
    [() => new Response("", { status: 200 }), "error"],
    [() => jsonResponse({}), "error"],
    [() => jsonResponse({ user: {} }), "error"],
    [() => jsonResponse({ user: { id: "" } }), "error"],
    [() => jsonResponse({ user: { id: 7 } }), "error"],
    [() => new Response(JSON.stringify(null), { status: 500 }), "error"],
    [() => jsonResponse(null, 401), "error"],
    [() => jsonResponse({ error: { code: "FORBIDDEN" } }, 403), "error"],
    [() => jsonResponse({ error: { code: "UPSTREAM_UNAVAILABLE" } }, 503), "error"],
    [() => jsonResponse(null), "guest"],
    [() => jsonResponse({ user: { id: "user-a", name: "用户甲" } }), "authenticated"],
  ];
  for (const [responseFactory, expected] of cases) {
    const store = createBrowserUserSessionStore(async () => responseFactory());
    await store.confirm();
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.status, expected, `expected ${expected} for ${JSON.stringify(await responseFactory().text().catch(() => null))}`);
    if (expected === "authenticated") {
      assert.equal(snapshot.userId, "user-a");
      assert.equal(snapshot.displayName, "用户甲");
    } else {
      assert.equal(snapshot.userId, null);
      assert.equal(snapshot.displayName, null);
    }
    store.dispose();
  }
});

test("a broken read after a confirmed user does not become a guest and can be retried", async () => {
  let broken = true;
  const store = createBrowserUserSessionStore(async () => {
    if (broken) return new Response("{oops", { status: 200 });
    return jsonResponse({ user: { id: "user-a", name: "alpha", username: "legacy-alias" } });
  });
  await store.confirm();
  assert.equal(store.getSnapshot().status, "error");
  broken = false;
  await store.confirm();
  assert.equal(store.getSnapshot().status, "authenticated");
  assert.equal(store.getSnapshot().userId, "user-a");
  assert.equal(store.getSnapshot().displayName, "alpha");
  store.dispose();
});

test("a historical username is never used as the user's display name", async () => {
  const store = createBrowserUserSessionStore(async () => jsonResponse({ user: { id: "user-a", username: "historical-phone-alias" } }));
  await store.confirm(); assert.equal(store.getSnapshot().displayName, null); store.dispose();
});

test("sign-out reports the server outcome instead of assuming success", async () => {
  const calls = [];
  const failing = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(null, { status: 500 });
  };
  assert.equal(await requestSignOut(failing), false);
  assert.deepEqual(calls[0], { url: "/api/auth/user/sign-out", method: "POST" });
  assert.equal(await requestSignOut(async () => { throw new Error("network down"); }), false);
  assert.equal(await requestSignOut(async () => new Response(null, { status: 200 })), true);
});

test("sign-out convergence follows the server session, not the broadcast", async () => {
  let signedOut = false;
  const fetchImpl = async (url) => {
    if (url === "/api/auth/user/sign-out") {
      signedOut = true;
      return new Response(null, { status: 200 });
    }
    return signedOut ? jsonResponse(null) : jsonResponse({ user: { id: "user-a", name: "用户甲" } });
  };
  const store = createBrowserUserSessionStore(fetchImpl);
  await store.confirm();
  assert.equal(store.getSnapshot().status, "authenticated");
  assert.equal(await requestSignOut(fetchImpl), true);
  await store.confirm();
  assert.equal(store.getSnapshot().status, "guest");
  assert.equal(store.getSnapshot().userId, null);
  store.dispose();
});

test("a failed sign-out leaves the confirmed session intact for a retry", async () => {
  let failSignOut = true;
  const fetchImpl = async (url) => {
    if (url === "/api/auth/user/sign-out") {
      return new Response(null, { status: failSignOut ? 500 : 200 });
    }
    return jsonResponse({ user: { id: "user-a", name: "用户甲" } });
  };
  const store = createBrowserUserSessionStore(fetchImpl);
  await store.confirm();
  assert.equal(await requestSignOut(fetchImpl), false);
  await store.confirm();
  assert.equal(store.getSnapshot().status, "authenticated");
  assert.equal(store.getSnapshot().userId, "user-a");
  failSignOut = false;
  assert.equal(await requestSignOut(fetchImpl), true);
  store.dispose();
});

test("performSignOut only resolves when the confirmation settles as guest", async () => {
  const authenticatedFetch = async (url) => url === "/api/auth/user/sign-out"
    ? new Response(null, { status: 200 })
    : jsonResponse({ user: { id: "user-a", name: "用户甲" } });
  const brokenReadFetch = async (url) => url === "/api/auth/user/sign-out"
    ? new Response(null, { status: 200 })
    : new Response("{broken", { status: 200 });

  // POST accepted but the confirmation still shows a signed-in session: unconfirmed.
  const stillSignedIn = createBrowserUserSessionStore(authenticatedFetch);
  await stillSignedIn.confirm();
  await assert.rejects(() => performSignOut(stillSignedIn, authenticatedFetch), /sign-out-unconfirmed:authenticated/);
  assert.equal(stillSignedIn.getSnapshot().status, "authenticated");
  stillSignedIn.dispose();

  // POST accepted but the confirmation failed: unconfirmed, not a completed sign-out.
  const brokenRead = createBrowserUserSessionStore(brokenReadFetch);
  await assert.rejects(() => performSignOut(brokenRead, brokenReadFetch), /sign-out-unconfirmed:error/);
  brokenRead.dispose();

  // A concurrent confirmation supersedes this one: unconfirmed.
  const firstRead = deferred();
  let sessionReads = 0;
  const racingFetch = async (url) => {
    if (url === "/api/auth/user/sign-out") return new Response(null, { status: 200 });
    sessionReads += 1;
    if (sessionReads === 1) return firstRead.promise;
    return jsonResponse(null);
  };
  const racing = createBrowserUserSessionStore(racingFetch);
  const signingOut = performSignOut(racing, racingFetch);
  while (sessionReads < 1) await new Promise((resolve) => setImmediate(resolve));
  const superseding = racing.confirm();
  firstRead.resolve(jsonResponse({ user: { id: "user-a" } }));
  await superseding;
  await assert.rejects(() => signingOut, /sign-out-unconfirmed:superseded/);
  racing.dispose();
});

test("performSignOut resolves when the server confirmation is guest, even if the POST failed", async () => {
  // POST transport failure, but the session is really gone: guest is the server truth.
  const lostPostFetch = async (url) => {
    if (url === "/api/auth/user/sign-out") throw new Error("network dropped after the server applied it");
    return jsonResponse(null);
  };
  const lostPost = createBrowserUserSessionStore(lostPostFetch);
  await performSignOut(lostPost, lostPostFetch);
  assert.equal(lostPost.getSnapshot().status, "guest");
  lostPost.dispose();

  // Normal path: accepted POST, confirmation guest.
  const normalFetch = async (url) => url === "/api/auth/user/sign-out"
    ? new Response(null, { status: 200 })
    : jsonResponse(null);
  const normal = createBrowserUserSessionStore(normalFetch);
  await performSignOut(normal, normalFetch);
  assert.equal(normal.getSnapshot().status, "guest");
  normal.dispose();
});


/* --- UserSessionStore State Machine Tests --- */

import { UserSessionStore } from "../src/lib/user-session-store.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));


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
