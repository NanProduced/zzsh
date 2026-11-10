import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import type { EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { readUserSensitiveProfile } from "../src/auth/user-directory-sensitive";
import { identitySubjectDigest } from "../src/auth/identity-subject";
import { sealLegacyIdentityProfile } from "../src/auth/legacy-identity-profile";

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
    if (sql.includes("to_regclass('zzsh_iam.user_legacy_identity_profile')")) return { rows: [{ ready: false }] };
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
  const audit = f.calls.at(-1)!;
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
    assert.deepEqual(JSON.parse(f.calls.at(-1)!.values[10] as string), { fields: [] });
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

test("legacy identity disclosure needs permission, valid keys and a successful audit", async () => {
  const profileKey = Buffer.alloc(32, 11), subjectKey = Buffer.alloc(32, 19);
  const details = { realName: "合成姓名", idCardNo: "99000019900101123X" };
  const binding = { userId: "user-a", sourceRef: "la_user:12", sourceDigest: "a".repeat(64), subjectDigest: identitySubjectDigest(details.idCardNo, subjectKey) };
  const sealed = sealLegacyIdentityProfile(binding, details, profileKey, subjectKey);
  const sqls: { sql: string; values: unknown[] }[] = [];
  let failAudit = false;
  const client = { async query(sql: string, values: unknown[] = []) {
    sqls.push({ sql, values });
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: [{ phoneNumber: null }], rowCount: 1 };
    if (sql.includes("to_regclass('zzsh_iam.user_legacy_identity_profile')")) return { rows: [{ ready: true }] };
    if (sql.includes("FROM zzsh_iam.user_legacy_identity_profile p")) return { rows: [{ user_id: binding.userId,
      source_ref: binding.sourceRef, source_digest: binding.sourceDigest, subject_digest: binding.subjectDigest,
      key_version: sealed.keyVersion, name_mask: sealed.nameMask, document_mask: sealed.documentMask,
      nonce: sealed.nonce, authentication_tag: sealed.tag, ciphertext: sealed.ciphertext }] };
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (failAudit) throw new Error("audit failed"); return { rows: [], rowCount: 1 }; }
    throw new Error("unexpected query");
  } } as unknown as PoolClient;
  await assert.rejects(readUserSensitiveProfile(client, actor, access("user.directory.read"), "user-a", { profileKey, subjectKey }), denied(403));
  assert.equal(sqls.length, 0);
  await assert.rejects(readUserSensitiveProfile(client, actor, allowed(), "user-a", { subjectKey }), denied(503));
  assert.equal(sqls.some(call => call.sql.includes('INSERT INTO "zzsh_iam"."audit_event"')), false);
  const result = await readUserSensitiveProfile(client, actor, allowed(), "user-a", { profileKey, subjectKey });
  assert.equal(result.realName, details.realName); assert.equal(result.identityNumber, details.idCardNo);
  const audit = sqls.at(-1)!;
  assert.deepEqual(JSON.parse(audit.values[10] as string), { fields: ["realName", "identityNumber"] });
  assert.doesNotMatch(JSON.stringify(audit.values), /合成姓名|99000019900101123X/);
  const read = sqls.find(call => call.sql.includes("FROM zzsh_iam.user_legacy_identity_profile p"))!;
  assert.match(read.sql, /b\.source='LEGACY_IMPORT'/); assert.match(read.sql, /s\.provider_reference=p\.source_ref/);
  failAudit = true;
  await assert.rejects(readUserSensitiveProfile(client, actor, allowed(), "user-a", { profileKey, subjectKey }), /audit failed/);
});
