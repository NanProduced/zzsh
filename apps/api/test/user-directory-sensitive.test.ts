import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import type { EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { readUserSensitiveProfile } from "../src/auth/user-directory-sensitive";

const actor = { adminId: "ops", sessionId: "session-ops", requestId: "req-sensitive" };
const access = (...permissions: string[]): EffectiveAdminAccess => ({ status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(permissions) });
const allowed = () => access("user.directory.read", "user.identity.sensitive.read");
const denied = (status: number) => (error: unknown) => (error as { status?: number }).status === status;
function fixture(phoneNumber: string | null = "+8613800000000") {
  const calls: { sql: string; values: unknown[] }[] = [];
  const state = { exists: true, failAudit: false };
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: state.exists ? [{ phoneNumber }] : [], rowCount: state.exists ? 1 : 0 };
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (state.failAudit) throw new Error("audit failed"); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected query: ${sql}`);
  } } as unknown as PoolClient;
  return { client, calls, state };
}

test("phone disclosure requires both directory and narrow sensitive permission, before any read", async () => {
  const f = fixture();
  for (const permissions of [[], ["user.directory.read"], ["user.identity.sensitive.read"], ["finance.read", "user.directory.read"]]) {
    await assert.rejects(readUserSensitiveProfile(f.client, actor, access(...permissions), "user-a"), denied(403));
  }
  await assert.rejects(readUserSensitiveProfile(f.client, actor, { ...allowed(), status: "FROZEN" }, "user-a"), denied(403));
  assert.equal(f.calls.length, 0);
});

test("local phone is disclosed after successful audit; identity flags are never invented into names/documents", async () => {
  const f = fixture();
  const result = await readUserSensitiveProfile(f.client, actor, allowed(), "user-a");
  assert.equal(result.phoneNumber, "+8613800000000");
  assert.equal(result.realName, null); assert.equal(result.identityNumber, null);
  assert.deepEqual(result.availability, { phoneNumber: "AVAILABLE", realName: "NOT_RECORDED", identityNumber: "NOT_RECORDED" });
  assert.match(f.calls[0]!.sql, /WHERE id=\$1 FOR SHARE/);
  assert.doesNotMatch(f.calls[0]!.sql, /nickname|provider_reference|identity_status/i);
  assert.deepEqual(f.calls[0]!.values, ["user-a"]);
  const audit = f.calls[1]!;
  assert.equal(audit.values[1], "admin"); assert.equal(audit.values[2], actor.adminId); assert.equal(audit.values[3], actor.sessionId);
  assert.equal(audit.values[4], "user.identity.sensitive.read"); assert.equal(audit.values[6], "user-a");
  assert.doesNotMatch(JSON.stringify(audit.values), /13800000000/);
  assert.deepEqual(JSON.parse(audit.values[10] as string), { fields: ["phoneNumber"] });
});

test("missing phone remains unavailable and audited without a placeholder value", async () => {
  for (const value of [null, ""]) {
    const f = fixture(value);
    const result = await readUserSensitiveProfile(f.client, actor, allowed(), "user-a");
    assert.equal(result.phoneNumber, null); assert.equal(result.availability.phoneNumber, "NOT_RECORDED");
    assert.deepEqual(JSON.parse(f.calls[1]!.values[10] as string), { fields: [] });
  }
});

test("missing users and invalid subjects are rejected without auditing success", async () => {
  const f = fixture(); f.state.exists = false;
  await assert.rejects(readUserSensitiveProfile(f.client, actor, allowed(), "user-a"), denied(404));
  assert.equal(f.calls.length, 1);
  await assert.rejects(readUserSensitiveProfile(f.client, actor, allowed(), "user/a"), denied(400));
  assert.equal(f.calls.length, 1);
});

test("an audit failure prevents disclosure from returning a successful profile", async () => {
  const f = fixture(); f.state.failAudit = true;
  await assert.rejects(readUserSensitiveProfile(f.client, actor, allowed(), "user-a"), /audit failed/);
});
