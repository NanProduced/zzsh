import assert from "node:assert/strict";
import test from "node:test";
import { planLegacyContactProjections } from "../src/legacy-load/legacy-contact-projection";
import { planLegacyUserContactBatch, type UserSourceRow } from "../src/legacy-load/user-order-offline-plan";
import { legacyOwnerEvidenceDigest, normalizeLegacyOwnerInput } from "../src/supply/legacy-user-migration";

const phone = "19900000001";
const row = (id: string, overrides: Partial<UserSourceRow & { sn: string }> = {}) => ({ id, sn: "OLD" + id, mobile: phone, nickname: "真实旧主体" + id,
  is_delete: "0", is_disable: "0", is_bind_id: "1", is_high_risk: "0", ageAdult: null, createTime: "1", updateTime: "2",
  sourceDigest: id.padStart(64, "a"), evidenceRef: "local-frozen-source:" + "f".repeat(64) + ":la_user:" + id, legacyPassword: null, ...overrides });

test("contact-aware prep retains both a cancelled predecessor and the unique non-cancelled successor", () => {
  const input = [row("1", { is_delete: "1" }), row("2")];
  const a = planLegacyUserContactBatch(input), b = planLegacyUserContactBatch([...input].reverse());
  assert.equal(a.parameterReady, 2); assert.equal(a.isolated, 0); assert.equal(a.writes, 0);
  assert.deepEqual(a.results, b.results);
  const first = a.results[0]!, second = a.results[1]!;
  assert.equal(first.disposition, "PARAMETER_READY"); assert.equal(second.disposition, "PARAMETER_READY");
  if (first.disposition === "PARAMETER_READY" && second.disposition === "PARAMETER_READY") {
    assert.equal(first.projected.accountStatus, "CANCELLED"); assert.equal(first.writerInput.evidence.contactProjection!.authenticationPhone, null);
    assert.equal(second.projected.accountStatus, "ACTIVE"); assert.equal(second.writerInput.evidence.contactProjection!.authenticationPhone, "+86" + phone);
    assert.notEqual(first.userId, second.userId); assert.equal(second.projected.ageStatus, "UNKNOWN");
    assert.equal(first.legacyPasswordPresent, false); assert.equal(second.passwordInvented, false);
  }
});

test("FROZEN is non-cancelled; an ACTIVE peer cannot inherit its contact", () => {
  const p = planLegacyUserContactBatch([row("3", { is_disable: "1" }), row("4")]);
  assert.equal(p.parameterReady, 2);
  for (const r of p.results) if (r.disposition === "PARAMETER_READY") assert.equal(r.writerInput.evidence.contactProjection!.authenticationPhone, null);
  assert.equal(p.results[0]!.disposition === "PARAMETER_READY" && p.results[0]!.projected.accountStatus, "FROZEN");
  const onlyFrozen = planLegacyUserContactBatch([row("3", { is_disable: "1" }), row("4", { is_delete: "1" })]);
  assert.equal(onlyFrozen.contacts.get("3")!.authenticationPhone, "+86" + phone);
});

test("empty source contact does not erase a real UID, number, password or inherited verification facts", () => {
  const p = planLegacyUserContactBatch([row("5", { mobile: null, legacyPassword: { version: "legacy-md5-v1", md5: "e".repeat(32), salt: "OldSalt" } })]);
  assert.equal(p.parameterReady, 1); const r = p.results[0]!;
  if (r.disposition === "PARAMETER_READY") {
    assert.equal(r.writerInput.evidence.mobile, null); assert.equal(r.writerInput.evidence.contactProjection!.sourceSn, "OLD5");
    assert.equal(r.writerInput.evidence.contactProjection!.authenticationPhone, null);
    assert.equal(r.writerInput.evidence.legacyPassword!.md5, "e".repeat(32)); assert.equal(r.projected.identityStatus, "VERIFIED");
    assert.equal(r.projected.ageStatus, "UNKNOWN");
    assert.throws(() => normalizeLegacyOwnerInput({ evidence: { ...r.writerInput.evidence, contactProjection: undefined }, evidenceDigest: r.writerInput.evidenceDigest }), /mobile/);
  }
});

test("multiple non-cancelled subjects keep distinct business identities with no arbitrary authentication winner", () => {
  const p = planLegacyUserContactBatch([row("6"), row("7")]);
  assert.equal(p.parameterReady, 2);
  assert.deepEqual([...p.contacts.values()].map(c => c.authenticationPhone), [null, null]);
  for (const c of p.contacts.values()) assert.equal(c.decision, "AMBIGUOUS_NON_CANCELLED");
});

test("a contact package cannot drop its frozen peer, change source flags, or inject an authentication number", () => {
  const p = planLegacyUserContactBatch([row("8", { is_disable: "1" }), row("9")]);
  const ready = p.results.find(r => r.disposition === "PARAMETER_READY")!;
  if (ready.disposition !== "PARAMETER_READY") throw Error("positive control");
  const base = ready.writerInput.evidence;
  for (const mutate of [
    (x: typeof base) => { x.contactProjection!.authenticationPhone = "+86" + phone; },
    (x: typeof base) => { x.contactProjection!.members.pop(); },
    (x: typeof base) => { x.contactProjection!.groupDigest = "0".repeat(64); },
    (x: typeof base) => { x.status.disabled = false; },
    (x: typeof base) => { x.contactProjection!.sourceSn = "ANOTHER"; },
  ]) { const changed = structuredClone(base); mutate(changed); assert.throws(() => legacyOwnerEvidenceDigest(changed), /contact|source|group|decision/i); }
});

test("all cancelled contacts stay unbound, and source ID/number collisions are explicit conflicts", () => {
  const p = planLegacyUserContactBatch([row("10", { is_delete: "1" }), row("11", { is_delete: "1" })]);
  assert.equal(p.parameterReady, 2); for (const c of p.contacts.values()) assert.equal(c.authenticationPhone, null);
  const s = { legacyId: "1", sourceDigest: "a".repeat(64), sourceSn: "OLD", deleted: false, disabled: false, mobile: phone, sourceContactRef: "x", sourceContactDigest: "b".repeat(64) };
  assert.throws(() => planLegacyContactProjections([s, { ...s, legacyId: "2" }]), /unique/);
});
