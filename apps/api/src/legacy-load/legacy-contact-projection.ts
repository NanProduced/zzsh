import { normalizeMainlandPhone } from "../auth/phone-number";
import { canonicalize } from "../supply/content-hash";
import { invalid, sha256Hex } from "../supply/supply-util";

export type LegacyContactSourceMember = {
  legacyId: string; sourceDigest: string; sourceSn: string;
  deleted: boolean; disabled: boolean;
};
export type LegacyContactProjection = {
  schema: "legacy-contact-projection-v1";
  sourceSn: string;
  authenticationPhone: string | null;
  decision: "UNIQUE_NON_CANCELLED" | "CANCELLED" | "AMBIGUOUS_NON_CANCELLED" | "NO_SOURCE_PHONE";
  sourceContactRef: string;
  sourceContactDigest: string;
  groupDigest: string;
  members: LegacyContactSourceMember[];
};
export type LegacyContactPlanningSource = LegacyContactSourceMember & {
  mobile: string | null;
  sourceContactRef: string;
  sourceContactDigest: string;
};
const hex = /^[a-f0-9]{64}$/;
const id = /^[1-9]\d{0,23}$/;
const sn = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const ordered = (members: readonly LegacyContactSourceMember[]) => [...members].sort((a, b) => BigInt(a.legacyId) < BigInt(b.legacyId) ? -1 : BigInt(a.legacyId) > BigInt(b.legacyId) ? 1 : 0);

/** Source contact and a current authentication binding are different facts. */
export function parseLegacyContactProjection(value: unknown, subject: {
  legacyId: string; sourceDigest: string; mobile: string | null; deleted: boolean; disabled: boolean;
}): LegacyContactProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Reviewed legacy contact projection required");
  const p = value as LegacyContactProjection;
  if (!exactKeys(p, ["schema", "sourceSn", "authenticationPhone", "decision", "sourceContactRef", "sourceContactDigest", "groupDigest", "members"])
    || p.schema !== "legacy-contact-projection-v1" || !sn(p.sourceSn) || !hex.test(p.sourceContactDigest) || !hex.test(p.groupDigest)
    || typeof p.sourceContactRef !== "string" || !p.sourceContactRef || p.sourceContactRef.length > 512
    || !Array.isArray(p.members) || p.members.length < 1 || p.members.length > 1000) throw invalid("Legacy contact source context is incomplete");
  for (const member of p.members) {
    if (!member || typeof member !== "object" || !exactKeys(member, ["legacyId", "sourceDigest", "sourceSn", "deleted", "disabled"])
      || !id.test(member.legacyId) || !hex.test(member.sourceDigest) || !sn(member.sourceSn)
      || typeof member.deleted !== "boolean" || typeof member.disabled !== "boolean") throw invalid("Legacy contact group is invalid");
  }
  const members = ordered(p.members);
  if (new Set(members.map(m => m.legacyId)).size !== members.length || canonicalize(members) !== canonicalize(p.members)
    || sha256Hex(canonicalize(members)) !== p.groupDigest) throw invalid("Legacy contact group digest changed");
  const own = members.find(m => m.legacyId === subject.legacyId);
  if (!own || own.sourceDigest !== subject.sourceDigest || own.sourceSn !== p.sourceSn || own.deleted !== subject.deleted || own.disabled !== subject.disabled) throw invalid("Legacy contact subject does not match its source");
  const normalized = subject.mobile === null ? null : normalizeMainlandPhone(subject.mobile);
  const live = members.filter(m => !m.deleted); // FROZEN still owns a slot; never hand its phone to ACTIVE.
  const decision = !normalized ? "NO_SOURCE_PHONE" : subject.deleted ? "CANCELLED" : live.length === 1 ? "UNIQUE_NON_CANCELLED" : "AMBIGUOUS_NON_CANCELLED";
  const phone = decision === "UNIQUE_NON_CANCELLED" ? normalized : null;
  if (p.decision !== decision || p.authenticationPhone !== phone || decision === "UNIQUE_NON_CANCELLED" && live[0]?.legacyId !== subject.legacyId
    || decision === "NO_SOURCE_PHONE" && members.length !== 1) throw invalid("Legacy authentication phone decision does not match the source group");
  return JSON.parse(canonicalize(p)) as LegacyContactProjection;
}

/** Whole-source group decisions; row order or account balance never chooses the phone owner. */
export function planLegacyContactProjections(rows: readonly LegacyContactPlanningSource[]) {
  const seen = new Set<string>(), sourceSns = new Set<string>(), groups = new Map<string, LegacyContactPlanningSource[]>();
  for (const row of rows) {
    if (!id.test(row.legacyId) || seen.has(row.legacyId) || !hex.test(row.sourceDigest) || !sn(row.sourceSn) || sourceSns.has(row.sourceSn)
      || typeof row.deleted !== "boolean" || typeof row.disabled !== "boolean") throw invalid("Exact unique legacy subjects and numbers required");
    seen.add(row.legacyId); sourceSns.add(row.sourceSn);
    const phone = row.mobile === null ? null : normalizeMainlandPhone(row.mobile);
    const key = phone ?? "no-phone:" + row.legacyId;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const result = new Map<string, LegacyContactProjection>();
  for (const group of groups.values()) {
    const members = ordered(group.map(({ legacyId, sourceDigest, sourceSn, deleted, disabled }) => ({ legacyId, sourceDigest, sourceSn, deleted, disabled })));
    const nonCancelled = members.filter(m => !m.deleted);
    for (const row of group) {
      const normalized = row.mobile === null ? null : normalizeMainlandPhone(row.mobile);
      const decision = !normalized ? "NO_SOURCE_PHONE" : row.deleted ? "CANCELLED" : nonCancelled.length === 1 ? "UNIQUE_NON_CANCELLED" : "AMBIGUOUS_NON_CANCELLED";
      const p: LegacyContactProjection = { schema: "legacy-contact-projection-v1", sourceSn: row.sourceSn,
        authenticationPhone: decision === "UNIQUE_NON_CANCELLED" ? normalized : null, decision,
        sourceContactRef: row.sourceContactRef, sourceContactDigest: row.sourceContactDigest, groupDigest: sha256Hex(canonicalize(members)), members };
      result.set(row.legacyId, parseLegacyContactProjection(p, row));
    }
  }
  return result;
}
