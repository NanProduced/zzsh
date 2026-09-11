import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoleFormDirty, roleFormDirty, rolePageDirty, shouldApplyServerRole, snapshotRole } from "../src/workspace/role-draft.ts";
import { canClaimCompleteTimeRange, listWasTruncated, previewItems } from "../src/workspace/truncated-list.ts";

const saved = snapshotRole({
  code: "ops",
  name: "运营",
  description: "旧说明",
  status: "ACTIVE",
  permissionCodes: ["admin.role.read"],
});

test("refresh does not apply server role while the edit form is dirty", () => {
  const draft = { name: "运营改名", description: "旧说明", status: "ACTIVE", permissionCodes: ["admin.role.read"] };
  const incoming = snapshotRole({ ...saved, name: "运营", description: "服务端更新" });
  assert.equal(roleFormDirty(saved, draft), true);
  assert.equal(shouldApplyServerRole(saved, draft, incoming), false);
  assert.equal(shouldApplyServerRole(saved, { name: "运营", description: "旧说明", status: "ACTIVE", permissionCodes: ["admin.role.read"] }, incoming), true);
  const savedForm = { name: "运营改名", description: "旧说明", status: "ACTIVE", permissionCodes: ["admin.role.read"] };
  assert.equal(shouldApplyServerRole(saved, savedForm, snapshotRole({ ...saved, name: "运营改名" })), true);
});

test("switching to another role still loads the incoming snapshot", () => {
  const incoming = snapshotRole({ code: "support", name: "客服", description: "", status: "ACTIVE", permissionCodes: [] });
  assert.equal(shouldApplyServerRole(saved, { name: "运营改名", description: "旧说明", status: "ACTIVE", permissionCodes: ["admin.role.read"] }, incoming), true);
});

test("after save the accepted snapshot is no longer dirty", () => {
  const draft = { name: "运营改名", description: "旧说明", status: "ACTIVE", permissionCodes: ["admin.role.read"] };
  const accepted = snapshotRole({ ...saved, name: "运营改名" });
  assert.equal(roleFormDirty(saved, draft), true);
  assert.equal(rolePageDirty(saved, "ops", draft, { code: "", name: "", description: "", permissionCodes: [] }), true);
  assert.equal(rolePageDirty(accepted, "ops", draft, { code: "", name: "", description: "", permissionCodes: [] }), false);
});

test("create success must apply the created snapshot before treating the page as clean", () => {
  const created = snapshotRole({
    code: "qa_closeout",
    name: "收尾验收",
    description: "工作区验收用抛弃角色",
    status: "ACTIVE",
    permissionCodes: ["admin.role.read"],
  });
  const unapplied = { name: "", description: "", status: "ACTIVE", permissionCodes: [] };
  assert.equal(shouldApplyServerRole(created, unapplied, created), false);
  assert.equal(rolePageDirty(created, "qa_closeout", unapplied, { code: "", name: "", description: "", permissionCodes: [] }), true);
  assert.equal(rolePageDirty(created, "qa_closeout", {
    name: created.name,
    description: created.description,
    status: created.status,
    permissionCodes: created.permissionCodes,
  }, { code: "", name: "", description: "", permissionCodes: [] }), false);
  assert.equal(shouldApplyServerRole(created, {
    name: created.name,
    description: created.description,
    status: created.status,
    permissionCodes: created.permissionCodes,
  }, created), true);
});

test("create-role fields mark the page dirty before submit", () => {
  assert.equal(createRoleFormDirty({ code: "", name: "", description: "", permissionCodes: [] }), false);
  assert.equal(createRoleFormDirty({ code: "finance_ops", name: "", description: "", permissionCodes: [] }), true);
  assert.equal(createRoleFormDirty({ code: "", name: "财务", description: "", permissionCodes: [] }), true);
  assert.equal(createRoleFormDirty({ code: "", name: "", description: "说明", permissionCodes: [] }), true);
  assert.equal(createRoleFormDirty({ code: "", name: "", description: "", permissionCodes: ["admin.role.read"] }), true);
});

test("truncated approval previews cannot claim a complete time-range result", () => {
  assert.equal(listWasTruncated(20, 20), true);
  assert.equal(canClaimCompleteTimeRange(20, 20), false);
  assert.equal(canClaimCompleteTimeRange(5, 20), true);
  assert.deepEqual(previewItems(["a", "b", "c", "d"], 2), ["a", "b"]);
});
