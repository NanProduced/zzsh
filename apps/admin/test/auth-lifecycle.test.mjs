import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { createSessionRefreshCoordinator } from "../src/session-refresh.ts";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const apiSource = source("api.ts");
const mainSource = source("main.tsx");
const supportSource = source("views/im-support-view.tsx");
const receiveStart = mainSource.indexOf("    const receive = (event: SignalEvent) => {");
const receiveEnd = mainSource.indexOf("    const readSignal =", receiveStart);
const receiveCode = ts.transpileModule(mainSource.slice(receiveStart, receiveEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const readSignalStart = mainSource.indexOf("    const readSignal =", receiveEnd);
const readSignalEnd = mainSource.indexOf("    let channel", readSignalStart);
const readSignalCode = ts.transpileModule(mainSource.slice(readSignalStart, readSignalEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const authFailureStart = mainSource.indexOf("    const onAuthFailure = (event: Event) => {");
const authFailureEnd = mainSource.indexOf("    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT", authFailureStart);
const authFailureCode = ts.transpileModule(mainSource.slice(authFailureStart, authFailureEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function refreshHarness() {
  const responses = [];
  const applied = [];
  let loads = 0;
  const coordinator = createSessionRefreshCoordinator(() => {
    loads += 1;
    const pending = deferred();
    responses.push(pending);
    return pending.promise;
  }, (snapshot, redirect) => applied.push({ snapshot, redirect }));
  return { coordinator, responses, applied, get loads() { return loads; } };
}

function receiveFor(harness, sessionId = "session-a") {
  return new Function(
    "sessionIdRef", "invalidateSessionRefresh", "refreshSession", "clearTabs", "setSnapshot", "setView", "setPassword", "window",
    `${receiveCode}; return receive;`,
  )(
    { current: sessionId },
    (...args) => harness.coordinator.invalidate(...args),
    (redirect) => harness.coordinator.refresh(redirect),
    () => {}, () => {}, () => {}, () => {}, {},
  );
}

function readSignalFor(harness, sessionId = "session-a") {
  const receive = receiveFor(harness, sessionId);
  return new Function("receive", "lastSignalKeyRef", "sessionIdRef", `${readSignalCode}; return readSignal;`)(receive, { current: undefined }, { current: sessionId });
}

function authFailureFor(harness, snapshot = { authenticated: true }) {
  return new Function(
    "snapshot", "invalidateSessionRefresh", "refreshSession", "window",
    `${authFailureCode}; return onAuthFailure;`,
  )(
    snapshot,
    (...args) => harness.coordinator.invalidate(...args),
    (redirect) => harness.coordinator.refresh(redirect),
    {},
  );
}

test("admin protected auth failures refresh the session without turning 403 into logout", () => {
  assert.match(apiSource, /ADMIN_AUTH_FAILURE_EVENT/);
  assert.match(apiSource, /response\.status === 401 \|\| response\.status === 423/);
  assert.match(apiSource, /path !== "\/session" && !path\.startsWith\("\/auth\/"\)/);
  assert.match(mainSource, /window\.addEventListener\(ADMIN_AUTH_FAILURE_EVENT/);
  assert.match(mainSource, /refreshSession\(status === 401\)/);
  assert.match(supportSource, /snapshot\.session\.locked/);
  assert.match(supportSource, /blockedConsultations/);
});

test("cross-tab lock signals force a fresh session read and filter other sessions", async () => {
  for (const type of ["locked", "unlocked"]) {
    const harness = refreshHarness();
    const receive = receiveFor(harness);
    const old = harness.coordinator.refresh(false);
    receive({ type, sessionId: "session-a", at: 1 });
    const fresh = harness.coordinator.refresh(false);
    assert.equal(harness.loads, 2);

    harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
    harness.responses[1].resolve({ authenticated: true, session: { locked: type === "locked" } });
    await Promise.all([old, fresh]);
    assert.deepEqual(harness.applied, [{ snapshot: { authenticated: true, session: { locked: type === "locked" } }, redirect: true }]);
  }

  const harness = refreshHarness();
  const receive = receiveFor(harness);
  const old = harness.coordinator.refresh(false);
  receive({ type: "locked", sessionId: "session-b", at: 1 });
  assert.equal(harness.loads, 1);
  harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
  await old;
  assert.equal(harness.applied.length, 1);
});

test("ordered external auth signals discard earlier fresh states and trail one confirmation", async () => {
  for (const [first, second, firstLocked, finalLocked] of [
    ["unlocked", "locked", false, true],
    ["locked", "unlocked", true, false],
  ]) {
    const harness = refreshHarness();
    const receive = receiveFor(harness);
    const old = harness.coordinator.refresh(false);
    receive({ type: first, sessionId: "session-a", at: 1 });
    const firstFresh = harness.coordinator.refresh(false);
    receive({ type: second, sessionId: "session-a", at: 2 });
    const tail = harness.coordinator.refresh(false);
    assert.equal(harness.loads, 2);

    harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
    harness.responses[1].resolve({ authenticated: true, session: { locked: firstLocked } });
    await Promise.all([old, firstFresh]);
    assert.equal(harness.responses.length, 3);
    harness.responses[2].resolve({ authenticated: true, session: { locked: finalLocked } });
    await tail;
    assert.deepEqual(harness.applied, [{ snapshot: { authenticated: true, session: { locked: finalLocked } }, redirect: true }]);
  }
});

test("duplicate broadcast and storage notifications do not create another refresh", async () => {
  const harness = refreshHarness();
  const readSignal = readSignalFor(harness);
  const old = harness.coordinator.refresh(false);
  const event = { type: "locked", sessionId: "session-a", at: 9 };
  readSignal(event);
  readSignal(event);
  const fresh = harness.coordinator.refresh(false);
  assert.equal(harness.loads, 2);
  harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
  harness.responses[1].resolve({ authenticated: true, session: { locked: true } });
  await Promise.all([old, fresh]);
  assert.deepEqual(harness.applied, [{ snapshot: { authenticated: true, session: { locked: true } }, redirect: true }]);
});

test("logout invalidates an active fresh read without applying its authenticated response", async () => {
  const harness = refreshHarness();
  const receive = receiveFor(harness);
  const old = harness.coordinator.refresh(false);
  receive({ type: "locked", sessionId: "session-a", at: 1 });
  const fresh = harness.coordinator.refresh(false);
  receive({ type: "logout", sessionId: "session-a", at: 2 });

  harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
  harness.responses[1].resolve({ authenticated: true, session: { locked: true } });
  await Promise.all([old, fresh]);
  assert.deepEqual(harness.applied, []);
});

test("423 followed by 401 trails a fresh read and keeps the later redirect policy", async () => {
  const harness = refreshHarness();
  const onAuthFailure = authFailureFor(harness);
  const old = harness.coordinator.refresh(false);
  onAuthFailure({ detail: { status: 423 } });
  const firstFresh = harness.coordinator.refresh(false);
  onAuthFailure({ detail: { status: 401 } });
  const tail = harness.coordinator.refresh(false);
  assert.equal(harness.loads, 2);

  harness.responses[0].resolve({ authenticated: true, session: { locked: false } });
  harness.responses[1].resolve({ authenticated: true, session: { locked: true } });
  await Promise.all([old, firstFresh]);
  assert.equal(harness.responses.length, 3);
  harness.responses[2].resolve({ authenticated: false });
  await tail;
  assert.deepEqual(harness.applied, [{ snapshot: { authenticated: false }, redirect: true }]);
});
