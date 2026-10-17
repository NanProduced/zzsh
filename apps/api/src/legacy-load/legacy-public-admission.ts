import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canonicalize } from "../supply/content-hash";

/**
 * Public display admission for frozen legacy account snapshots.
 *
 * Display is not trade. A row may be shown read-only while its `legacy_hold`
 * still blocks publishing, editing and ordering (publishing.ts keeps requiring
 * 'NONE'); this module only decides whether the frozen source facts may be
 * shown as safe public text. Unknown values are never folded into a default
 * class: missing facts fail closed and stay pending review instead of being
 * displayed as "ordinary".
 *
 * Runtime boundary: `evaluatePublicDisplayGuard` runs inside the shared legacy
 * projection (supply/legacy-listing-read.ts `readLegacyListing`, used by both
 * the list and the detail read), and the SQL admission binds display to the
 * exact reviewed record tuple via `legacyAdmissionSql`. A namespace alone
 * never authorizes a record; without a loaded capability UNRESOLVED stays hidden.
 *
 * Facts that do not exist in the target database cannot be enforced at runtime;
 * see admission-rules.md ("high risk owner") for the exact handling.
 */

/** `legacy_hold` states whose frozen facts may be shown read-only. */
export const LEGACY_DISPLAY_HOLD_STATES = ["NONE", "UNRESOLVED"] as const;
export type LegacyDisplayHoldState = (typeof LEGACY_DISPLAY_HOLD_STATES)[number];

export function legacyHoldDisplayable(hold: unknown): hold is LegacyDisplayHoldState {
  return typeof hold === "string" && (LEGACY_DISPLAY_HOLD_STATES as readonly string[]).includes(hold);
}

/** Core identity evidence pending outside ADULT is not publicly displayed. */
export function coreIdentityDisplayable(ageStatus: unknown): boolean {
  return ageStatus === "ADULT";
}

/**
 * Evidence reference syntax only. Authorization is the exact approved record
 * match in legacyAdmissionSql, not the text prefix.
 */

export function legacyEvidenceReferenceValid(evidenceRef: unknown): boolean {
  return typeof evidenceRef === "string"
    && /^legacy-migration-preflight-\d{8}:la_rental_accounts:[0-9]+$/.test(evidenceRef);
}

export type LegacyPublicRecord = {
  accountId: string; ownerUserId: string; gameId: string; observationVersionId: string;
  sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; evidenceRef: string; sourceUpdatedAt: string;
  snapshot: Record<string, unknown>; title: string; description: string | null; attributes: Record<string, unknown>;
  displayDigest?: string | null;
  sourceStatus?: 3 | 4 | 5 | 6;
};
export type LegacyPublicAdmission = {
  schema: "legacy-public-admission-v1" | "legacy-public-admission-v2" | "legacy-public-admission-v3"; sourceBatchSha256: string;
  resource: { database: string; oid: number; marker: string; runtimeRole: string };
  records: readonly LegacyPublicRecord[];
};

/** Exact reviewed facts, not a namespace or a mutable source-status allowlist. */
export function parseLegacyPublicAdmission(value: unknown): LegacyPublicAdmission {
  function fail(): never { throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID"); }
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!object(value) || !["legacy-public-admission-v1","legacy-public-admission-v2","legacy-public-admission-v3"].includes(String(value.schema)) || !/^[a-f0-9]{64}$/.test(String(value.sourceBatchSha256))) fail();
  const resource = value.resource;
  if (!object(resource) || !text(resource.database) || !Number.isSafeInteger(resource.oid) || Number(resource.oid) <= 0 || !text(resource.marker, 256) || !text(resource.runtimeRole)) fail();
  if (!Array.isArray(value.records) || value.records.length === 0 || value.records.length > 5000) fail();
  const ids = new Set<string>();
  for (const r of value.records) {
    if (!object(r) || ![r.accountId, r.ownerUserId, r.gameId, r.observationVersionId, r.sourceSystem, r.sourceEntity, r.legacyId].every(v => text(v)) || !/^[a-f0-9]{64}$/.test(String(r.sourceDigest)) || !legacyEvidenceReferenceValid(r.evidenceRef) || !object(r.snapshot) || !object(r.attributes) || !text(r.title, 2000) || !(r.description === null || typeof r.description === "string" && r.description.length <= 20000)) fail();
    if (r.sourceEntity !== "la_rental_accounts" || !String(r.evidenceRef).endsWith(`:${r.legacyId}`) || !text(r.sourceUpdatedAt, 40) || !Number.isFinite(Date.parse(r.sourceUpdatedAt)) || ids.has(r.accountId as string)) fail();
    if (!evaluatePublicDisplayGuard({ title: r.title, description: r.description, evidenceRef: r.evidenceRef }).ok) fail();
    if (value.schema !== "legacy-public-admission-v1" ? !(r.displayDigest===null||typeof r.displayDigest==="string"&&/^[a-f0-9]{64}$/.test(r.displayDigest)) : r.displayDigest!==undefined&&r.displayDigest!==null) fail();
    if (value.schema === "legacy-public-admission-v3" ? ![3,4,5,6].includes(r.sourceStatus as number) : r.sourceStatus !== undefined) fail();
    ids.add(r.accountId as string);
  }
  // Do not retain a mutable caller-owned object as an authorization capability.
  return JSON.parse(JSON.stringify(value)) as LegacyPublicAdmission;
}

export function loadLegacyPublicAdmission(env: NodeJS.ProcessEnv, workingDirectory: string): LegacyPublicAdmission | undefined {
  // shortcut: local reviewed-file capability; production rollout needs durable audited admission.
  const file = env.LEGACY_PUBLIC_ADMISSION_FILE;
  const digest = env.LEGACY_PUBLIC_ADMISSION_SHA256;
  if (!file && !digest) return undefined;
  if (env.APP_PROFILE !== "test" || env.NODE_ENV === "production" || !file || !/^[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("LEGACY_PUBLIC_ADMISSION_LOCAL_ONLY");
  const base = realpathSync(resolve(workingDirectory, ".secrets"));
  const target = realpathSync(resolve(workingDirectory, file));
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("LEGACY_PUBLIC_ADMISSION_PATH");
  if (statSync(target).size > 8 * 1024 * 1024) throw new Error("LEGACY_PUBLIC_ADMISSION_SIZE");
  const bytes = readFileSync(target);
  if (bytes.length > 8 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("LEGACY_PUBLIC_ADMISSION_DIGEST");
  return parseLegacyPublicAdmission(JSON.parse(bytes.toString("utf8")));
}

/** Runtime-only index of v3 shards for READ details. Never used by list reads. */
export type LegacyPublicAdmissionDetailIndex = ReadonlyMap<string, LegacyPublicAdmission>;
export type LegacyPublicAdmissionManifest = {
  schema: "legacy-public-admission-manifest-v1";
  shards: readonly LegacyPublicAdmission[];
  index: LegacyPublicAdmissionDetailIndex;
};

const MANIFEST_MAX_SHARD_BYTES = 8 * 1024 * 1024;

/**
 * Loads the explicit v3 detail manifest. This is a local reviewed-file
 * capability like the status-3 single file: only APP_PROFILE=test and a
 * non-production process may use it, and every shard must stay inside
 * `.secrets`. The loader does not raise the 5000-row/8-MiB parser limits.
 */
export function loadLegacyPublicAdmissionManifest(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
): LegacyPublicAdmissionManifest | undefined {
  const file = env.LEGACY_PUBLIC_ADMISSION_MANIFEST;
  if (!file) return undefined;
  if (env.APP_PROFILE !== "test" || env.NODE_ENV === "production") {
    throw new Error("LEGACY_PUBLIC_ADMISSION_LOCAL_ONLY");
  }
  const base = realpathSync(resolve(workingDirectory, ".secrets"));
  const manifestPath = realpathSync(resolve(workingDirectory, file));
  const manifestRel = relative(base, manifestPath);
  if (!manifestRel || manifestRel.startsWith("..") || isAbsolute(manifestRel)) {
    throw new Error("LEGACY_PUBLIC_ADMISSION_PATH");
  }
  if (statSync(manifestPath).size > MANIFEST_MAX_SHARD_BYTES) {
    throw new Error("LEGACY_PUBLIC_ADMISSION_SIZE");
  }
  const manifestBytes = readFileSync(manifestPath);
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID"); }
  const entry = manifest as { schema?: unknown; shards?: unknown };
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.schema !== "legacy-public-admission-manifest-v1"
    || !Array.isArray(entry.shards) || entry.shards.length === 0) {
    throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
  }
  const index = new Map<string, LegacyPublicAdmission>();
  const shards: LegacyPublicAdmission[] = [];
  let resourceKey: string | undefined;
  for (const raw of entry.shards) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
    const shard = raw as { path?: unknown; sha256?: unknown };
    if (typeof shard.path !== "string" || !/^[a-f0-9]{64}$/.test(String(shard.sha256))) {
      throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
    }
    // Shard paths are relative to the manifest (and therefore inside .secrets).
    const target = realpathSync(resolve(dirname(manifestPath), shard.path));
    const rel = relative(base, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("LEGACY_PUBLIC_ADMISSION_PATH");
    if (statSync(target).size > MANIFEST_MAX_SHARD_BYTES) throw new Error("LEGACY_PUBLIC_ADMISSION_SIZE");
    const bytes = readFileSync(target);
    if (bytes.length > MANIFEST_MAX_SHARD_BYTES) throw new Error("LEGACY_PUBLIC_ADMISSION_SIZE");
    if (createHash("sha256").update(bytes).digest("hex") !== shard.sha256) throw new Error("LEGACY_PUBLIC_ADMISSION_DIGEST");
    let parsed: LegacyPublicAdmission;
    try { parsed = parseLegacyPublicAdmission(JSON.parse(bytes.toString("utf8"))); } catch { throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID"); }
    if (parsed.schema !== "legacy-public-admission-v3") throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
    const currentResource = canonicalize(parsed.resource);
    if (resourceKey === undefined) resourceKey = currentResource;
    else if (resourceKey !== currentResource) throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
    for (const record of parsed.records) {
      if (record.sourceStatus === 3 || index.has(record.accountId)) throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
      index.set(record.accountId, parsed);
    }
    shards.push(parsed);
  }
  return { schema: "legacy-public-admission-manifest-v1", shards, index };
}

/** Resolve the one detail record/shard for an account; never used for list SQL. */
export function admissionForAccount(
  index: LegacyPublicAdmissionDetailIndex | undefined,
  accountId: string,
): LegacyPublicAdmission | undefined {
  const shard = index?.get(accountId);
  const record = shard?.records.find(item => item.accountId === accountId);
  if (!shard || !record) return undefined;
  return { ...shard, records: [record] };
}

export async function assertLegacyPublicAdmissionManifestTarget(
  pool: Pick<Pool, "query">,
  manifest: LegacyPublicAdmissionManifest,
): Promise<void> {
  const first = manifest.shards[0];
  if (!first) throw new Error("LEGACY_PUBLIC_ADMISSION_INVALID");
  await assertLegacyPublicAdmissionTarget(pool, first);
}

export async function assertLegacyPublicAdmissionTarget(pool: Pick<Pool, "query">, admission: LegacyPublicAdmission): Promise<void> {
  const row = (await pool.query(`SELECT current_database() AS database,d.oid::int AS oid,shobj_description(d.oid,'pg_database') AS marker,current_user AS "runtimeRole" FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if (!row || canonicalize(row) !== canonicalize(admission.resource)) throw new Error("LEGACY_PUBLIC_ADMISSION_TARGET_MISMATCH");
}

export function legacyAdmissionRevision(admission: LegacyPublicAdmission): string {
  return createHash("sha256").update(canonicalize(admission)).digest("hex");
}

export function legacyAdmissionSql(admission: LegacyPublicAdmission | undefined, param: (value: unknown) => string, includeBaseline = true): string {
  if (!admission) return includeBaseline ? "(a.legacy_hold='NONE' AND d.account_id IS NULL)" : "FALSE";
  const records = param(JSON.stringify(admission.records));
  return `(${includeBaseline ? "(a.legacy_hold='NONE' AND d.account_id IS NULL) OR " : ""}(a.legacy_hold IN ('NONE','UNRESOLVED') AND EXISTS (
    SELECT 1 FROM jsonb_to_recordset(${records}::jsonb) approved("accountId" text,"ownerUserId" text,"gameId" text,"observationVersionId" text,"sourceSystem" text,"sourceEntity" text,"legacyId" text,"sourceDigest" text,"evidenceRef" text,"sourceUpdatedAt" timestamptz,snapshot jsonb,title text,description text,attributes jsonb,"displayDigest" text,"sourceStatus" integer)
    WHERE approved."accountId"=a.id AND approved."ownerUserId"=a.owner_user_id AND approved."gameId"=a.game_id
      AND approved."observationVersionId"=h.observation_version_id AND v.id=h.observation_version_id
      AND approved."sourceSystem"=h.source_system AND approved."sourceEntity"=h.source_entity AND approved."legacyId"=h.legacy_id
      AND approved."sourceDigest"=h.source_digest AND approved."evidenceRef"=h.evidence_ref AND approved."sourceUpdatedAt"=h.source_updated_at AND approved.snapshot=h.snapshot
      AND approved.title IS NOT DISTINCT FROM v.title AND approved.description IS NOT DISTINCT FROM v.description AND approved.attributes=v.attributes
      ${admission.schema === "legacy-public-admission-v3" ? 'AND approved."sourceStatus"=h.source_status' : ""}
      AND ((d.account_id IS NULL AND approved."displayDigest" IS NULL) OR (d.display_digest=approved."displayDigest" AND d.observation_version_id=h.observation_version_id AND d.base_source_digest=h.source_digest))
  )))`;
}

export const PUBLIC_TEXT_PRIVACY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["MAINLAND_MOBILE", /(?:^|[^\d])1[3-9]\d{9}(?!\d)/],
  ["CN_ID_CARD", /(?:^|[^\d])\d{17}[\dXx](?![\dXx])/],
  ["CONTACT_KEYWORD", /(微信|wechat|weixin|qq号|qq[:：]|加\s*[v微]|联系电话|手机号|微信号)/i],
  ["CREDENTIAL_KEYWORD", /(密码|password|pwd|验证码|登录凭据|账号密码)/i],
];

/** Privacy hits in candidate public text; a hit blocks display pending review. */
export function publicTextPrivacyIssues(text: unknown): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  return PUBLIC_TEXT_PRIVACY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}

export type PublicDisplayGuardInput = {
  title: unknown;
  description: unknown;
  evidenceRef: unknown;
};
export type PublicDisplayGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Shared runtime guard for the legacy list/detail projection. Fails closed on
 * malformed evidence and privacy-bearing public text. This is a text/syntax
 * gate, not a claim that every privacy hazard is decidable by pattern.
 */
export function evaluatePublicDisplayGuard(input: PublicDisplayGuardInput): PublicDisplayGuardResult {
  if (!legacyEvidenceReferenceValid(input.evidenceRef)) return { ok: false, reason: "EVIDENCE_BATCH_UNBOUND" };
  const issues = [...publicTextPrivacyIssues(input.title), ...publicTextPrivacyIssues(input.description)];
  if (issues.length) return { ok: false, reason: "CORE_IDENTITY_PRIVACY_PENDING" };
  return { ok: true };
}

export type PublicDisplayBucket = "DISPLAY_CANDIDATE" | "NOT_PUBLIC" | "PENDING_REVIEW";
export type PublicDisplayVerdict = { bucket: PublicDisplayBucket; reason: string };

export type PublicDisplayCaseInput = {
  /** Import-layer facts from the frozen source plan (absent for imported rows). */
  source: {
    reason: string | null;
    sourceStatus: string | number | null;
    evidenceRef?: unknown;
  };
  account: {
    legacyHold: string;
    lifecycle: string;
    ownerPaused: boolean;
    staffRestricted: boolean;
    hasPublication: boolean;
    gameEnabled: boolean;
    serviceEnabled: boolean;
  };
  owner: {
    suspended: boolean;
    accountStatus: string;
    ageStatus?: string;
  };
  flags: {
    highRiskOwner: boolean;
    privacyCodes: readonly string[];
  };
};

const notPublic = (reason: string): PublicDisplayVerdict => ({ bucket: "NOT_PUBLIC", reason });
const pending = (reason: string): PublicDisplayVerdict => ({ bucket: "PENDING_REVIEW", reason });

/**
 * Mutually exclusive admission verdict, first match wins. The ordered reasons
 * are the closed accounting used by the public-market evidence scripts.
 * Missing facts never qualify as display candidates: they stay pending review.
 */
export function classifyPublicDisplay(input: PublicDisplayCaseInput): PublicDisplayVerdict {
  const { source, account, owner, flags } = input;
  // A. Source layer, decided before import.
  if (source.reason === "SOURCE_DELETED") return notPublic("SOURCE_SOFT_DELETED");
  if (source.reason === "STATUS_NOT_READ_SCOPE") return notPublic("SOURCE_STATUS_OUT_OF_SCOPE");
  if (source.reason === "OWNER_NOT_ACTIVE") return notPublic("OWNER_NOT_ACTIVE_AT_IMPORT");
  if (source.reason === "OWNER_MOBILE_DUPLICATE") return pending("OWNER_MOBILE_DUPLICATE_PENDING");
  if (source.reason === "SNAPSHOT_INCOMPLETE" || source.reason === "FIELD_INCOMPLETE") return pending("SOURCE_FIELD_INCOMPLETE");
  if (source.reason) return pending(`SOURCE_DEPENDENCY_PENDING_${source.reason}`);
  // Imported rows must carry adjudicated evidence and an explicit public status.
  if (!legacyEvidenceReferenceValid(source.evidenceRef)) return pending("EVIDENCE_BATCH_UNBOUND_PENDING");
  if (source.sourceStatus === null || source.sourceStatus === undefined || source.sourceStatus === "")
    return pending("SOURCE_STATUS_UNKNOWN_PENDING");
  if (Number(source.sourceStatus) !== 3) return notPublic(`SOURCE_STATUS_${Number(source.sourceStatus)}_NOT_PUBLIC`);
  // B. Runtime hard blocks.
  if (account.lifecycle !== "ACTIVE") return notPublic("ACCOUNT_LIFECYCLE_NOT_ACTIVE");
  if (account.ownerPaused) return notPublic("OWNER_PAUSED");
  if (account.staffRestricted) return notPublic("STAFF_RESTRICTED");
  if (owner.suspended) return notPublic("OWNER_SUSPENDED");
  if (owner.accountStatus !== "ACTIVE") return notPublic("OWNER_ACCOUNT_STATUS_NOT_ACTIVE");
  if (account.hasPublication) return notPublic("NATIVE_TAKEOVER");
  if (!account.gameEnabled || !account.serviceEnabled) return notPublic("GAME_OR_SERVICE_DISABLED");
  // C. Pending review: safe text is withheld until the fact is resolved.
  if (account.legacyHold === "ACTIVE_LEGACY") return pending("LEGACY_HOLD_ACTIVE_LEGACY");
  if (flags.privacyCodes.length) return pending("CORE_IDENTITY_PRIVACY_PENDING");
  if (!coreIdentityDisplayable(owner.ageStatus)) return pending("OWNER_AGE_IDENTITY_PENDING");
  if (flags.highRiskOwner) return pending("OWNER_HIGH_RISK_PENDING_DECISION");
  // D. Minimal hold compatibility: 'NONE' and 'UNRESOLVED' may be displayed;
  //    publish/edit/order keep their own 'NONE' requirement.
  if (!legacyHoldDisplayable(account.legacyHold)) return pending("LEGACY_HOLD_UNMAPPED");
  return { bucket: "DISPLAY_CANDIDATE", reason: "SOURCE_STATUS_3_SAFE_TEXT" };
}
