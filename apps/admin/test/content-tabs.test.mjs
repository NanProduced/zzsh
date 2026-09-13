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

test("navigation exposes content management only with content permissions", () => {
  const labelsFor = (permissions) => workspaceMenuItems({ isBoss: false, permissions }).map((item) => item.label);
  assert.equal(labelsFor(["content.platform.read"]).includes("内容管理"), true);
  assert.equal(labelsFor(["content.read"]).includes("内容管理"), true);
  assert.equal(labelsFor(["supply.catalog.manage"]).includes("内容管理"), false);
  assert.equal(labelsFor(["content.edit"]).includes("内容管理"), false, "edit-only permission without read must not expose the entry");
});
