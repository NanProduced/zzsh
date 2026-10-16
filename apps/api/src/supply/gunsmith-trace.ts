import { invalid } from "./supply-util";

// CH-1 traceability reconciliation between the restored legacy tables
// (la_gun / la_gun_code) and the maintained zzsh_supply tables
// (firearm / gunsmith_code). The recorded evidence (rehearsal 2026-10-13) is
// 68 legacy guns -> 63 migrated + 5 soft-delete isolated, and 154 legacy
// codes -> 152 migrated + 2 duplicate isolated. This pure function reports
// every deviation from that contract; it never writes and never opens a
// database connection. Live migration runs remain NOT_RUN (owner window).
export const LEGACY_GUN_NAMESPACE = "legacy:la_gun";
export const LEGACY_GUN_CODE_NAMESPACE = "legacy:la_gun_code";
const SOURCE_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{1,31}:[a-z][a-z0-9_.-]{1,63}$/;

export type LegacyGunsmithGunRow = {
  id: number;
  name: string;
  isDelete: number | boolean;
};

export type LegacyGunsmithCodeRow = {
  id: number;
  gunId: number;
  code: string;
  isDelete: number | boolean;
};

export type TracedFirearmRow = {
  id: string;
  name: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
};

export type TracedGunsmithCodeRow = {
  id: string;
  firearmId: string;
  code: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
};

export type GunsmithTraceIssue = {
  kind:
    | "SOFT_DELETED_GUN_MIGRATED"
    | "SOFT_DELETED_CODE_MIGRATED"
    | "DUPLICATE_CODE_MIGRATED"
    | "LIVE_GUN_NOT_MIGRATED"
    | "LIVE_CODE_NOT_MIGRATED"
    | "SOURCE_TRACING_MISSING"
    | "UNRESOLVED_SOURCE_TOKEN"
    | "MIGRATED_NAME_MISMATCH"
    | "MIGRATED_CODE_MISMATCH"
    | "CODE_TARGET_FIREARM_UNTRACED"
    | "GUN_COUNT_MISMATCH"
    | "CODE_COUNT_MISMATCH";
  legacyId?: number;
  targetId?: string;
  detail: string;
};

export type GunsmithTraceSummary = {
  legacyGunTotal: number;
  legacyGunSoftDeleted: number;
  legacyGunExpectedMigrated: number;
  legacyCodeTotal: number;
  legacyCodeSoftDeleted: number;
  legacyCodeDuplicateIsolated: number;
  legacyCodeExpectedMigrated: number;
  targetGunTracedCount: number;
  targetCodeTracedCount: number;
  migratedGunCount: number;
  migratedCodeCount: number;
};

function isLiveRow(isDelete: number | boolean): boolean {
  return isDelete === 0 || isDelete === false;
}

function indexTracedRows<T extends { id: string; sourceNamespace: string | null; sourceToken: string | null }>(
  rows: readonly T[],
  expectedNamespace: string,
  tableLabel: string,
  issues: GunsmithTraceIssue[],
): Map<string, T> {
  const byToken = new Map<string, T>();
  for (const row of rows) {
    if (row.sourceNamespace === null && row.sourceToken === null) continue;
    if (row.sourceNamespace === null || row.sourceToken === null) {
      issues.push({ kind: "SOURCE_TRACING_MISSING", targetId: row.id, detail: `${tableLabel} ${row.id} records source namespace and token only together` });
      continue;
    }
    if (row.sourceNamespace !== expectedNamespace) continue;
    if (byToken.has(row.sourceToken)) {
      issues.push({ kind: "UNRESOLVED_SOURCE_TOKEN", targetId: row.id, detail: `${tableLabel} source token ${row.sourceToken} is recorded twice` });
      continue;
    }
    byToken.set(row.sourceToken, row);
  }
  return byToken;
}

export function reconcileGunsmithTrace(input: {
  legacyGuns: readonly LegacyGunsmithGunRow[];
  legacyCodes: readonly LegacyGunsmithCodeRow[];
  firearms: readonly TracedFirearmRow[];
  codes: readonly TracedGunsmithCodeRow[];
  gunNamespace?: string;
  codeNamespace?: string;
}): { issues: GunsmithTraceIssue[]; summary: GunsmithTraceSummary } {
  const gunNamespace = input.gunNamespace ?? LEGACY_GUN_NAMESPACE;
  const codeNamespace = input.codeNamespace ?? LEGACY_GUN_CODE_NAMESPACE;
  for (const [label, namespace] of [["gunNamespace", gunNamespace], ["codeNamespace", codeNamespace]] as const) {
    if (!SOURCE_NAMESPACE_PATTERN.test(namespace)) throw invalid("Source namespace must identify its source system and entity", label);
  }

  const issues: GunsmithTraceIssue[] = [];
  const firearmsByToken = indexTracedRows(input.firearms, gunNamespace, "firearm", issues);
  const codesByToken = indexTracedRows(input.codes, codeNamespace, "gunsmith_code", issues);

  const legacyGunIds = new Set(input.legacyGuns.map((gun) => String(gun.id)));
  for (const [token, row] of firearmsByToken) {
    if (!legacyGunIds.has(token)) issues.push({ kind: "UNRESOLVED_SOURCE_TOKEN", targetId: row.id, detail: `firearm source token ${token} matches no la_gun row` });
  }
  const legacyCodeIds = new Set(input.legacyCodes.map((code) => String(code.id)));
  for (const [token, row] of codesByToken) {
    if (!legacyCodeIds.has(token)) issues.push({ kind: "UNRESOLVED_SOURCE_TOKEN", targetId: row.id, detail: `gunsmith_code source token ${token} matches no la_gun_code row` });
  }

  let migratedGunCount = 0;
  let legacyGunSoftDeleted = 0;
  for (const gun of input.legacyGuns) {
    const target = firearmsByToken.get(String(gun.id));
    if (!isLiveRow(gun.isDelete)) {
      legacyGunSoftDeleted++;
      if (target) issues.push({ kind: "SOFT_DELETED_GUN_MIGRATED", legacyId: gun.id, targetId: target.id, detail: `soft-deleted la_gun row ${gun.id} must stay isolated and was migrated` });
      continue;
    }
    if (!target) {
      issues.push({ kind: "LIVE_GUN_NOT_MIGRATED", legacyId: gun.id, detail: `live la_gun row ${gun.id} has no firearm carrying its source token` });
      continue;
    }
    migratedGunCount++;
    if (target.name !== gun.name) {
      issues.push({ kind: "MIGRATED_NAME_MISMATCH", legacyId: gun.id, targetId: target.id, detail: `la_gun name "${gun.name}" became "${target.name}"` });
    }
  }

  // Duplicate isolation: among live codes, identical (gunId, code) tuples keep
  // the lowest legacy id as the canonical row; the rest stay isolated.
  const liveCodes = input.legacyCodes.filter((code) => isLiveRow(code.isDelete));
  const groups = new Map<string, LegacyGunsmithCodeRow[]>();
  for (const code of liveCodes) {
    const groupKey = `${code.gunId}\n${code.code}`;
    const group = groups.get(groupKey) ?? [];
    group.push(code);
    groups.set(groupKey, group);
  }
  const canonicalCodeIds = new Set<number>();
  const duplicateIsolatedIds = new Set<number>();
  for (const group of groups.values()) {
    group.sort((left, right) => left.id - right.id);
    group.forEach((code, index) => (index === 0 ? canonicalCodeIds : duplicateIsolatedIds).add(code.id));
  }

  let migratedCodeCount = 0;
  let legacyCodeSoftDeleted = 0;
  for (const code of input.legacyCodes) {
    const target = codesByToken.get(String(code.id));
    if (!isLiveRow(code.isDelete)) {
      legacyCodeSoftDeleted++;
      if (target) issues.push({ kind: "SOFT_DELETED_CODE_MIGRATED", legacyId: code.id, targetId: target.id, detail: `soft-deleted la_gun_code row ${code.id} must stay isolated and was migrated` });
      continue;
    }
    if (duplicateIsolatedIds.has(code.id)) {
      if (target) issues.push({ kind: "DUPLICATE_CODE_MIGRATED", legacyId: code.id, targetId: target.id, detail: `duplicate la_gun_code row ${code.id} must stay isolated and was migrated` });
      continue;
    }
    if (!canonicalCodeIds.has(code.id)) continue;
    if (!target) {
      issues.push({ kind: "LIVE_CODE_NOT_MIGRATED", legacyId: code.id, detail: `canonical la_gun_code row ${code.id} has no gunsmith_code carrying its source token` });
      continue;
    }
    migratedCodeCount++;
    if (target.code !== code.code) {
      issues.push({ kind: "MIGRATED_CODE_MISMATCH", legacyId: code.id, targetId: target.id, detail: `la_gun_code value "${code.code}" became "${target.code}"` });
    }
    const parent = firearmsByToken.get(String(code.gunId));
    if (!parent || parent.id !== target.firearmId) {
      issues.push({ kind: "CODE_TARGET_FIREARM_UNTRACED", legacyId: code.id, targetId: target.id, detail: `code must stay bound to the firearm migrated from la_gun ${code.gunId}` });
    }
  }

  // Row-count conservation: migrated traces must account for every traced
  // target row, so legacy total = migrated + soft-deleted + duplicate-isolated
  // and target total = migrated, both directions checked.
  const targetGunTracedCount = firearmsByToken.size;
  const targetCodeTracedCount = codesByToken.size;
  if (migratedGunCount !== targetGunTracedCount) {
    issues.push({ kind: "GUN_COUNT_MISMATCH", detail: `${input.legacyGuns.length} la_gun rows expect ${migratedGunCount} migrated firearms but ${targetGunTracedCount} are traced` });
  }
  if (migratedCodeCount !== targetCodeTracedCount) {
    issues.push({ kind: "CODE_COUNT_MISMATCH", detail: `${input.legacyCodes.length} la_gun_code rows expect ${migratedCodeCount} migrated codes but ${targetCodeTracedCount} are traced` });
  }

  return {
    issues,
    summary: {
      legacyGunTotal: input.legacyGuns.length,
      legacyGunSoftDeleted,
      legacyGunExpectedMigrated: input.legacyGuns.length - legacyGunSoftDeleted,
      legacyCodeTotal: input.legacyCodes.length,
      legacyCodeSoftDeleted,
      legacyCodeDuplicateIsolated: duplicateIsolatedIds.size,
      legacyCodeExpectedMigrated: canonicalCodeIds.size,
      targetGunTracedCount,
      targetCodeTracedCount,
      migratedGunCount,
      migratedCodeCount,
    },
  };
}
