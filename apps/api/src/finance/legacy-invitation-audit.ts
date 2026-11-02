import { createHash } from "node:crypto";
import { canonicalize } from "../supply/content-hash";
import type { DistributionPolicyConfig } from "./distribution-policy";
import { prepareLegacyInvitationImport, type LegacyInvitationInput } from "./legacy-invitation-maintenance";

export type LegacyInvitationAudit = {
  schema: "legacy-invitation.audit.v1";
  sourceDigest: string;
  subjects: number;
  nonzeroParents: number;
  zeroParents: number;
  codeCaseCollisions: number;
  missingParentSources: number;
  selfEdges: number;
  childCountMismatches: number | null;
  frozenSubjects: number;
  ineligibleSubjects: number;
  v1Compatible: boolean;
  v2GapCodes: string[];
  preparedRelations: number | null;
  reasonCodes: string[];
};

/** Read-only source audit. It never imports, writes, or resolves current policy implicitly. */
export function auditLegacyInvitationPacket(input: LegacyInvitationInput, policy: Pick<DistributionPolicyConfig, "schema">): LegacyInvitationAudit {
  const sourceDigest = createHash("sha256").update(canonicalize(input)).digest("hex");
  const bySource = new Map<string, LegacyInvitationInput["subjects"][number]>();
  const codeOwners = new Map<string, number>();
  const missingParentSources = new Set<string>();
  let zeroParents = 0, selfEdges = 0, frozenSubjects = 0, ineligibleSubjects = 0;
  for (const subject of input.subjects) {
    bySource.set(String(subject.legacyId), subject);
    const code = String(subject.userSource.code ?? "").toUpperCase();
    codeOwners.set(code, (codeOwners.get(code) ?? 0) + 1);
    if (subject.qualificationSource.is_freeze === 1 || subject.qualificationSource.is_freeze === "1") frozenSubjects++;
    if (subject.qualificationSource.is_distribution !== 1 && subject.qualificationSource.is_distribution !== "1") ineligibleSubjects++;
    for (const field of ["inviter_id", "first_leader"] as const) {
      const value = subject.userSource[field];
      if (value === 0 || value === "0" || value == null || value === "") { zeroParents++; continue; }
      if (String(value) === String(subject.legacyId)) selfEdges++;
      if (!input.subjects.some(candidate => String(candidate.legacyId) === String(value))) missingParentSources.add(String(value));
    }
  }
  const codeCaseCollisions = [...codeOwners.values()].filter(count => count > 1).length;
  let preparedRelations: number | null = null;
  const reasonCodes: string[] = [];
  try {
    const plan = prepareLegacyInvitationImport(input, sourceDigest);
    preparedRelations = plan.relations.length;
  } catch (error) {
    reasonCodes.push(error instanceof Error ? error.message : "LEGACY_INVITATION_SOURCE_INVALID");
  }
  const v2GapCodes = policy.schema === "distribution-policy.v2" ? ["V2_POLICY_LEVEL_MAPPING_NOT_ADMITTED"] : [];
  const childCountMismatches = preparedRelations === null ? null : 0;
  return {
    schema: "legacy-invitation.audit.v1",
    sourceDigest,
    subjects: input.subjects.length,
    nonzeroParents: 2 * input.subjects.length - zeroParents,
    zeroParents,
    codeCaseCollisions,
    missingParentSources: missingParentSources.size,
    selfEdges,
    childCountMismatches,
    frozenSubjects,
    ineligibleSubjects,
    v1Compatible: policy.schema === "distribution-policy.v1" && reasonCodes.length === 0,
    v2GapCodes,
    preparedRelations,
    reasonCodes: [...new Set([...reasonCodes, ...v2GapCodes])],
  };
}
