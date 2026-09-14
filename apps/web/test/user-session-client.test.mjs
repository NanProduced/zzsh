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
    return jsonResponse({ user: { id: "user-a", username: "alpha" } });
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
