// ADM-USER-DIRECTORY-READ-1: tab-model wiring for the user directory routes.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canOpenKind,
  parseWorkspacePath,
  sanitizeTabQuery,
  tabFromLocation,
  upsertTab,
} from "../src/workspace/tab-model.ts";

const navWithDirectory = { isBoss: false, permissions: ["user.directory.read"] };
const navWithoutDirectory = { isBoss: false, permissions: ["order.read"] };

test("users routes parse into list and object tabs", () => {
  assert.deepEqual(parseWorkspacePath("/users"), { kind: "users", tabId: "users", path: "/users", title: "用户管理" });
  const object = parseWorkspacePath("/users/user_abc123");
  assert.equal(object.kind, "user-object");
  assert.equal(object.objectId, "user_abc123");
  assert.equal(object.tabId, "user:user_abc123");
  // The pre-existing restore route keeps its own tab, never swallowed by the object route.
  assert.equal(parseWorkspacePath("/users/restore").kind, "user-restore");
  assert.equal(parseWorkspacePath("/users/restore").tabId, "user-restore");
});

test("users list replaces complete filters; object tabs stay per user", () => {
  const first = tabFromLocation("/users", "source=MIGRATED");
  assert.equal(first.id, "users");
  assert.equal(first.kind, "users");
  const merged = upsertTab([first], tabFromLocation("/users", "accountStatus=ACTIVE"));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].query, { accountStatus: "ACTIVE" });
  const objectTab = tabFromLocation("/users/user_abc123");
  assert.equal(objectTab.kind, "user-object");
  const withObject = upsertTab(merged, objectTab);
  assert.equal(withObject.length, 2);
});

test("directory kinds require user.directory.read", () => {
  assert.equal(canOpenKind("users", navWithDirectory), true);
  assert.equal(canOpenKind("user-object", navWithDirectory), true);
  assert.equal(canOpenKind("users", navWithoutDirectory), false);
  assert.equal(canOpenKind("user-object", navWithoutDirectory), false);
});

test("phone-shaped query values never persist into tab query or URL", () => {
  assert.deepEqual(sanitizeTabQuery({ phone: "13812345678", source: "LOCAL" }), { source: "LOCAL" });
  assert.deepEqual(sanitizeTabQuery({ cellphone: "13812345678" }), {}, "key containing phone is stripped");
  const tab = tabFromLocation("/users", "phone=13812345678&source=LOCAL");
  assert.deepEqual(tab.query, { source: "LOCAL" }, "URL-entered phone values are dropped at the tab boundary");
});
