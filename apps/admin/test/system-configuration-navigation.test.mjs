import assert from "node:assert/strict";
import { test } from "node:test";
import { canOpenKind, filterTabsByPermission, tabFromLocation } from "../src/workspace/tab-model.ts";
import { filterSearchablePages, searchableWorkspacePages, titleForPath, workspaceMenuItems } from "../src/workspace/nav-config.ts";

test("system configuration has a distinct route and is discoverable for Boss", () => {
  const nav = { isBoss: true, permissions: [] };
  const tab = tabFromLocation("/system", "");
  assert.equal(tab.kind, "system-configuration");
  assert.equal(tab.title, "系统配置");
  assert.equal(canOpenKind(tab.kind, nav), true);
  assert.equal(titleForPath("/system"), "系统配置");
  assert.ok(workspaceMenuItems(nav).some(item => item.path === "/system"));
  for (const query of ["系统配置", "运维", "OSS"]) {
    assert.ok(filterSearchablePages(searchableWorkspacePages(nav), query).some(page => page.path === "/system"));
  }
});

test("content operators cannot open, restore or search the deployment configuration", () => {
  const nav = { isBoss: false, permissions: ["content.platform.read", "content.platform.edit"] };
  const tab = tabFromLocation("/system", "");
  assert.equal(canOpenKind(tab.kind, nav), false);
  assert.ok(!filterTabsByPermission([tab], nav).some(item => item.kind === "system-configuration"));
  assert.ok(!workspaceMenuItems(nav).some(item => item.path === "/system"));
  assert.ok(!searchableWorkspacePages(nav).some(item => item.path === "/system"));
  assert.equal(canOpenKind("content", nav), true, "existing operational content access remains available");
  assert.equal(tabFromLocation("/settings", "").kind, "settings", "personal settings retain their identity");
});
