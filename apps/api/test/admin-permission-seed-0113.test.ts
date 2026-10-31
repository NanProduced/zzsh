import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { ADMIN_PERMISSION_CODES } from "../src/auth/admin-authorization";

const SEEDED_BEFORE_0113_MISSING = ["finance.read", "finance.document.read", "user.phone.lookup"];

test("0113 只补种 3 个已定义权限码，不授予任何人", () => {
  const sql = readFileSync(resolve("migrations/business/0113_admin_permission_finance_phone_seed.sql"), "utf8");
  const codes = [...sql.matchAll(/\('([a-z_.]+)',/g)].map((m) => m[1]);
  assert.deepEqual(codes.sort(), [...SEEDED_BEFORE_0113_MISSING].sort());
  for (const code of codes) assert.ok((ADMIN_PERMISSION_CODES as readonly string[]).includes(code ?? ""), code);
  assert.match(sql, /ON CONFLICT \(code\) DO NOTHING/);
  assert.doesNotMatch(sql, /admin_role_permission|admin_user_permission|\bDELETE\b|\bUPDATE\b|\bDROP\b|\bGRANT\b/i);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.equal(journal.entries[113].tag, "0113_admin_permission_finance_phone_seed");
});