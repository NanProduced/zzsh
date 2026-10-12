import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../src/auth/admin-authorization";

function executor(security: { status: "ACTIVE" | "FROZEN"; isBoss: boolean }, permissions: string[] = []) {
  let call = 0;
  return {
    query: async () => {
      call += 1;
      if (call === 1) return { rows: [{ ...security, passwordChangeRequired: false }] };
      return { rows: permissions.map((permissionCode) => ({ permissionCode })) };
    },
  } as never;
}

test("active administrators receive baseline order core read without a role grant", async () => {
  const access = await loadEffectiveAdminAccess(executor({ status: "ACTIVE", isBoss: false }), "admin-baseline");
  assert.ok(access);
  assert.equal(access.permissions.has(ADMIN_PERMISSION.orderRead), true);
});

test("baseline order core read does not activate for frozen administrators", async () => {
  const access = await loadEffectiveAdminAccess(executor({ status: "FROZEN", isBoss: false }), "admin-frozen");
  assert.ok(access);
  assert.equal(access.permissions.has(ADMIN_PERMISSION.orderRead), false);
});

test("personal deny cannot remove the baseline order core read", async () => {
  const access = await loadEffectiveAdminAccess(executor({ status: "ACTIVE", isBoss: false }), "admin-deny");
  assert.ok(access);
  assert.equal(access.permissions.has(ADMIN_PERMISSION.orderRead), true);
});
