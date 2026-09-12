import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceMenuItems, titleForPath } from "../src/workspace/nav-config.ts";
import { canOpenKind, parseWorkspacePath, tabFromLocation } from "../src/workspace/tab-model.ts";

test("supply routes parse into dedicated workspace tabs", () => {
  assert.deepEqual(parseWorkspacePath("/supply/catalog"), { kind: "catalog", tabId: "catalog", path: "/supply/catalog", title: "目录维护" });
  assert.deepEqual(parseWorkspacePath("/supply/rules"), { kind: "rules", tabId: "rules", path: "/supply/rules", title: "规则与价目" });
  assert.deepEqual(parseWorkspacePath("/supply/media"), { kind: "media-review", tabId: "media-review", path: "/supply/media", title: "平台素材审核" });
  assert.equal(titleForPath("/supply/catalog"), "目录维护");
  assert.equal(titleForPath("/supply/rules"), "规则与价目");
  assert.equal(titleForPath("/supply/media"), "平台素材审核");
  const tab = tabFromLocation("/supply/rules", "?state=SEALED");
  assert.equal(tab.kind, "rules");
  assert.equal(tab.query.state, "SEALED");
});

test("supply tabs require their own permissions instead of a generic admin role", () => {
  const catalogOnly = { isBoss: false, permissions: ["supply.catalog.manage"] };
  const reviewOnly = { isBoss: false, permissions: ["supply.review.read"] };
  const boss = { isBoss: true, permissions: [] };
  assert.equal(canOpenKind("catalog", catalogOnly), true);
  assert.equal(canOpenKind("rules", catalogOnly), false);
  assert.equal(canOpenKind("media-review", catalogOnly), false);
  assert.equal(canOpenKind("media-review", reviewOnly), true);
  assert.equal(canOpenKind("rules", reviewOnly), false);
  assert.equal(canOpenKind("catalog", boss), true);
  assert.equal(canOpenKind("rules", boss), true);
  assert.equal(canOpenKind("media-review", boss), true);
});

test("the workspace menu exposes supply entries only with matching permissions", () => {
  const limited = workspaceMenuItems({ isBoss: false, permissions: [] });
  assert.equal(limited.some((item) => item.label === "供给与目录"), false);
  assert.equal(limited.some((item) => item.path?.startsWith("/supply")), false);

  const reviewer = workspaceMenuItems({ isBoss: false, permissions: ["supply.review.read"] });
  assert.ok(reviewer.some((item) => item.label === "供给与目录"));
  assert.deepEqual(reviewer.filter((item) => item.path?.startsWith("/supply")).map((item) => item.path), ["/supply/media"]);

  const editor = workspaceMenuItems({ isBoss: false, permissions: ["supply.catalog.manage", "supply.rules.edit"] });
  assert.deepEqual(editor.filter((item) => item.path?.startsWith("/supply")).map((item) => item.path), ["/supply/catalog", "/supply/rules"]);
});
