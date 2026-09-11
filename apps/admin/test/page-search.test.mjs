import assert from "node:assert/strict";
import { test } from "node:test";

import { filterSearchablePages, searchableWorkspacePages } from "../src/workspace/nav-config.ts";

test("page search only lists implemented pages in the current permission set", () => {
  const boss = searchableWorkspacePages({
    isBoss: true,
    permissions: ["admin.account.read", "admin.role.read", "approval.request.read", "admin.audit.read", "user.account.restore"],
  });
  assert.deepEqual(boss.map((page) => page.path), [
    "/workbench",
    "/admins",
    "/roles",
    "/users/restore",
    "/approvals",
    "/audit",
    "/account",
  ]);

  const limited = searchableWorkspacePages({ isBoss: false, permissions: [] });
  assert.deepEqual(limited.map((page) => page.path), ["/workbench", "/account"]);
  assert.equal(limited.some((page) => page.path === "/admins"), false);
});

test("page search matches label, group and path, and stays empty for unknown business queries", () => {
  const pages = searchableWorkspacePages({
    isBoss: true,
    permissions: ["admin.account.read", "admin.audit.read"],
  });
  assert.deepEqual(filterSearchablePages(pages, "审计").map((page) => page.path), ["/audit"]);
  assert.deepEqual(filterSearchablePages(pages, "/admins").map((page) => page.path), ["/admins"]);
  assert.deepEqual(filterSearchablePages(pages, "系统").map((page) => page.path), ["/admins"]);
  assert.equal(filterSearchablePages(pages, "订单号").length, 0);
  assert.equal(filterSearchablePages(pages, "用户手机").length, 0);
});
