import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReturnTo } from "../src/lib/safe-return.ts";
import { consumeAccountReturnSnapshot, readAccountListingState, rememberAccountListingState, rememberAccountReturn } from "../src/lib/account-return.ts";

test("only same-site absolute paths survive as post-login return targets", () => {
  for (const value of [
    "https://evil.invalid/account",
    "http://evil.invalid",
    "//evil.invalid/account",
    "/\\evil.invalid",
    "javascript:alert(1)",
    "/account\u0000",
    "/account\nx",
    `/${"a".repeat(600)}`,
    "account",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeReturnTo(value), undefined, `must reject ${JSON.stringify(value)}`);
  }
  for (const value of ["/", "/accounts/42", "/publish?mode=fast", "/account?view=favorites#list"]) {
    assert.equal(safeReturnTo(value), value);
  }
  assert.equal(safeReturnTo("  /accounts/42  "), "/accounts/42");
});

test("account list state is versioned by game and falls back to memory when storage is unavailable", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } });
  try {
    const state = { filters: { regions: [{ province: "甲省", city: "甲市" }] }, q: null, sort: "latest", direction: "DESC", coreItemId: null, limit: 20, viewMode: "grid" };
    rememberAccountListingState("game_state_a", state);
    assert.deepEqual(readAccountListingState("game_state_a"), state);
    assert.equal(JSON.parse(storage.get("zzsh:account-list-state:v1:game_state_a")).version, 1);
    assert.equal(readAccountListingState("game_state_b"), null);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } });
    rememberAccountListingState("game_memory_a", state);
    assert.deepEqual(readAccountListingState("game_memory_a"), state);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("detail return snapshot restores only for its exact filter digest", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } });
  try {
    const location = { pathname: "/accounts", search: "?game=game_delta" };
    const snapshot = { scrollY: 480, pageCursors: [null, "cursor_1"], filterKey: "filter-digest-a", viewMode: "grid" };
    rememberAccountReturn("return_filter_mismatch", location, snapshot);
    assert.equal(consumeAccountReturnSnapshot("/accounts?game=game_delta", "filter-digest-b"), null);
    rememberAccountReturn("return_filter_match", location, snapshot);
    assert.deepEqual(consumeAccountReturnSnapshot("/accounts?game=game_delta", "filter-digest-a"), snapshot);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});
