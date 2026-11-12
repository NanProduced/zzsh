import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceMenuItems, titleForPath } from "../src/workspace/nav-config.ts";
import { canOpenKind, parseWorkspacePath, tabFromLocation } from "../src/workspace/tab-model.ts";

test("content route parses into its own workspace tab", () => {
  assert.deepEqual(parseWorkspacePath("/content"), { kind: "content", tabId: "content", path: "/content", title: "内容管理" });
  assert.equal(titleForPath("/content"), "内容管理");
  const tab = tabFromLocation("/content", "");
  assert.equal(tab.kind, "content");
  assert.equal(tab.closable, true);
});

test("content tab requires content permissions instead of an operations role name", () => {
  const platformOnly = { isBoss: false, permissions: ["content.platform.read"] };
  const gameOnly = { isBoss: false, permissions: ["content.read"] };
  const unrelated = { isBoss: false, permissions: ["supply.catalog.manage"] };
  const boss = { isBoss: true, permissions: [] };
  assert.equal(canOpenKind("content", platformOnly), true);
  assert.equal(canOpenKind("content", gameOnly), true);
  assert.equal(canOpenKind("content", unrelated), false);
  assert.equal(canOpenKind("content", boss), true);
});

test("navigation exposes split content workspaces only within their read permissions", () => {
  const labelsFor = (permissions) => workspaceMenuItems({ isBoss: false, permissions }).map((item) => item.label);
  assert.ok(labelsFor(["content.platform.read"]).includes("帮助中心"));
  assert.ok(labelsFor(["content.platform.read"]).includes("平台动态"));
  assert.ok(labelsFor(["content.read"]).includes("平台动态"));
  assert.ok(labelsFor(["content.read"]).includes("帮助中心"));
  assert.ok(labelsFor(["content.help.read"]).includes("帮助中心"));
  assert.ok(!labelsFor(["content.help.read"]).includes("平台动态"));
  assert.ok(!labelsFor(["supply.catalog.manage"]).includes("平台动态"));
  assert.ok(!labelsFor(["content.edit"]).includes("平台动态"));
});
