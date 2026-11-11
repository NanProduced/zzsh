import assert from "node:assert/strict";
import { test } from "node:test";
import { identitySubjectDigest } from "../src/auth/identity-subject";
import { legacyIdentityProfileKey, openLegacyIdentityProfile, sealLegacyIdentityProfile } from "../src/auth/legacy-identity-profile";

const profileKey = Buffer.alloc(32, 11), subjectKey = Buffer.alloc(32, 19);
const details = { realName: "合成姓名", idCardNo: "99000019900101123X" };
const binding = { userId: "synthetic_user", sourceRef: "la_user:12", sourceDigest: "a".repeat(64), subjectDigest: identitySubjectDigest(details.idCardNo, subjectKey) };
const unavailable = (error: unknown) => (error as { code?: string }).code === "IDENTITY_DEPENDENCY_UNAVAILABLE";

test("legacy identity encryption preserves the original data without exposing it in the stored envelope", () => {
  const sealed = sealLegacyIdentityProfile(binding, details, profileKey, subjectKey);
  assert.deepEqual(openLegacyIdentityProfile(binding, sealed, profileKey, subjectKey), details);
  assert.equal(sealed.nameMask, "合**名");
  assert.equal(sealed.documentMask, "990000********123X");
  const encoded = JSON.stringify(sealed);
  assert.equal(encoded.includes(details.realName), false);
  assert.equal(encoded.includes(details.idCardNo), false);
  assert.notEqual(sealed.nonce, sealLegacyIdentityProfile(binding, details, profileKey, subjectKey).nonce);
});

test("legacy identity decryption refuses wrong identity, key, subject, source, or modified envelope", () => {
  const sealed = sealLegacyIdentityProfile(binding, details, profileKey, subjectKey);
  for (const altered of [{ ...binding, userId: "other_user" }, { ...binding, sourceRef: "la_user:13" }, { ...binding, sourceDigest: "b".repeat(64) },
    { ...binding, subjectDigest: "c".repeat(64) }]) {
    assert.throws(() => openLegacyIdentityProfile(altered, sealed, profileKey, subjectKey), unavailable);
  }
  assert.throws(() => openLegacyIdentityProfile(binding, sealed, Buffer.alloc(32, 12), subjectKey), unavailable);
  assert.throws(() => openLegacyIdentityProfile(binding, sealed, profileKey, Buffer.alloc(32, 20)), unavailable);
  assert.throws(() => openLegacyIdentityProfile(binding, { ...sealed, nameMask: "错误" }, profileKey, subjectKey), unavailable);
  assert.throws(() => openLegacyIdentityProfile(binding, { ...sealed, tag: (sealed.tag[0] === "A" ? "B" : "A") + sealed.tag.slice(1) }, profileKey, subjectKey), unavailable);
  assert.throws(() => sealLegacyIdentityProfile(binding, details, undefined, subjectKey), unavailable);
  assert.throws(() => sealLegacyIdentityProfile(binding, { ...details, realName: "\n" }, profileKey, subjectKey), unavailable);
  assert.throws(() => sealLegacyIdentityProfile(binding, { ...details, idCardNo: "990000\n19900101123X" }, profileKey, subjectKey), unavailable);
});

test("legacy identity profile key accepts only canonical 32-byte key material", () => {
  const encoded = profileKey.toString("base64url");
  assert.deepEqual(legacyIdentityProfileKey(encoded), profileKey);
  for (const invalid of ["", "x".repeat(32), encoded + "=", "!".repeat(43)]) {
    assert.throws(() => legacyIdentityProfileKey(invalid), unavailable);
  }
});
