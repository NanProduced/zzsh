import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readUserPasswordState } from "../src/auth/legacy-login";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { verifyUserCredentialInTransaction } from "../src/auth/auth-security";

function db(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

test("recognized legacy and modern credentials are set without forcing a replacement", async () => {
  const fake = db([{ modern: false, legacy: true }]);
  assert.equal(await readUserPasswordState(fake, "user-1"), "set");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.values, ["user-1"]);
});

test("absent passwords and unavailable credentials are distinct, and reads fail closed", async () => {
  assert.equal(await readUserPasswordState(db([{ modern: true, legacy: false }]), "user-1"), "set");
  assert.equal(await readUserPasswordState(db([{ modern: false, legacy: false }]), "user-1"), "unavailable");
  assert.equal(await readUserPasswordState(db([]), "user-1"), "not-set");
  await assert.rejects(readUserPasswordState({ query: async () => { throw new Error("read failed"); } }, "user-1"));
});

function credentialClient(overrides: Record<string, unknown> = {}) {
  const row = { id: "account-test", userId: "user-test", password: "CURRENT_HASH", legacyPasswordMd5: null,
    legacyPasswordVersion: null, legacyPasswordSalt: null, suspended: true, accountStatus: "FROZEN", ...overrides };
  const calls: string[] = [];
  let verified = 0, hashed = 0;
  const client = { query: async (text: string) => {
    calls.push(text);
    return { rows: text.includes('FROM "zzsh_auth_user"."account" a') ? [row] : [], rowCount: 1 };
  } } as unknown as PoolClient;
  return { client, calls, get verified() { return verified; }, get hashed() { return hashed; },
    verify: async (value: string, hash: string) => { verified++; return value === "correct" && hash === "CURRENT_HASH"; },
    hash: async () => { hashed++; return "UPGRADED_HASH"; } };
}

test("sign-in can identify a valid frozen credential without creating or changing it", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
  assert.equal(fake.verified, 1);
  assert.equal(fake.hashed, 0);
  assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
});

test("wrong frozen passwords remain generic rejections and never write", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "wrong", "test", "sign-in"), "none");
  assert.equal(fake.verified, 1);
  assert.equal(fake.hashed, 0);
  assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
});

test("non-login compatibility never admits a frozen account", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test"), "none");
  assert.equal(fake.verified, 0);
});

for (const version of ["legacy-md5-v0", "legacy-md5-v1"] as const) {
  test(`frozen ${version} can be rejected explicitly without upgrading its hash`, async () => {
    const salt = version === "legacy-md5-v1" ? "SYNTHETIC_SALT" : null;
    const fake = credentialClient({ password: null, legacyPasswordVersion: version, legacyPasswordSalt: salt,
      legacyPasswordMd5: createHash("md5").update("correct" + (salt ?? "")).digest("hex") });
    assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
    assert.equal(fake.hashed, 0);
    assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
    assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "wrong", "test", "sign-in"), "none");
  });
}

for (const mode of ["active-only", "sign-in"] as const) {
  for (const state of ["CANCELLED", "DEACTIVATED", "ACTIVE"] as const) {
    test(`${mode} never admits an otherwise suspended ${state} credential`, async () => {
      const fake = credentialClient({ accountStatus: state });
      assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", mode), "none");
      assert.equal(fake.verified, 0);
    });
  }
}

test("active credentials keep their existing verification and legacy upgrade behavior", async () => {
  const modern = credentialClient({ suspended: false, accountStatus: "ACTIVE" });
  assert.equal(await verifyUserCredentialInTransaction(modern.client, modern.verify, modern.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
  const legacy = credentialClient({ suspended: false, accountStatus: "ACTIVE", password: null,
    legacyPasswordMd5: createHash("md5").update("correct").digest("hex"), legacyPasswordVersion: "legacy-md5-v0" });
  assert.equal(await verifyUserCredentialInTransaction(legacy.client, legacy.verify, legacy.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
  assert.equal(legacy.hashed, 1);
  assert.ok(legacy.calls.some(q => q.includes('UPDATE "zzsh_auth_user"."account"')));
  assert.ok(legacy.calls.some(q => /INSERT[\s\S]*audit_event/.test(q)));
});
