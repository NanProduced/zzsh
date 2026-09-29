import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError, recordAudit } from "../auth/security-core";
import {
  assertGameExists,
  ensureOnlyFields,
  parseExpectedRevision,
  assertGameScope,
  bumpCatalogRevision,
  conflict,
  invalid,
  newSupplyId,
  notFound,
  optionalBoolean,
  optionalInteger,
  optionalNullableString,
  optionalString,
  optionalTrimmedString,
  requiredString,
  sha256Hex,
} from "./supply-util";
import { canonicalize } from "./content-hash";
import { ensureGameServiceRows, isSupportedGameService, type GameServiceCode } from "./game-services";

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;
const UNITS = new Set(["HAFF_BASE", "ROUND", "PIECE", "DAY"]);
const LEGACY_CATALOG_NAMESPACE = "legacy_mysql_restore";

const ASCII_EDGE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const SKIN_FIELDS = ["name", "categoryId", "rarityCode", "sortOrder", "enabled", "formVisible", "aliases", "sourceNamespace", "sourceField", "sourceToken", "expectedCatalogRevision"];
type SkinOwnerRef = { kind: "AGENT" | "MELEE_TYPE" | "FIREARM"; id: string };

/** Frozen-research evidence for the migration catalog seams. The caller reads the
 * frozen artifact, records its digest and the digest of the exact identity record
 * it is asserting; the seam recomputes that record from its own inputs so the
 * evidence is bound to this request instead of a namespace prefix. */
export type LegacyCatalogEvidence = { artifact: string; artifactSha256: string; recordDigest: string };
export type LegacyCatalogAudit = { requestId: string; sessionId?: string };
export function legacyCatalogRecordDigest(record: Record<string, unknown>): string {
  return sha256Hex(canonicalize(record));
}
function checkedLegacyEvidence(evidence: LegacyCatalogEvidence | undefined): LegacyCatalogEvidence {
  if (!evidence || typeof evidence !== "object") throw invalid("Legacy evidence is required", "evidence");
  const artifact = skinText(evidence.artifact, "evidence.artifact", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/.test(artifact) || artifact.includes("..")) throw invalid("Invalid evidence artifact", "evidence.artifact");
  for (const field of ["artifactSha256", "recordDigest"] as const)
    if (typeof evidence[field] !== "string" || !/^[a-f0-9]{64}$/.test(evidence[field])) throw invalid("Invalid evidence digest", `evidence.${field === "artifactSha256" ? "artifactSha256" : "recordDigest"}`);
  return { artifact, artifactSha256: evidence.artifactSha256, recordDigest: evidence.recordDigest };
}
function checkedLegacyAudit(audit: LegacyCatalogAudit | undefined): LegacyCatalogAudit {
  if (!audit || typeof audit !== "object") throw invalid("Legacy audit context is required", "audit");
  const requestId = skinText(audit.requestId, "audit.requestId", 128);
  const sessionId = audit.sessionId === undefined ? undefined : skinText(audit.sessionId, "audit.sessionId", 128);
  return { requestId, ...(sessionId === undefined ? {} : { sessionId }) };
}

function skinText(value: unknown, field: string, max: number, canonical = true): string {
  if (typeof value !== "string") throw invalid("Text is required", field);
  const trimmed = value.replace(ASCII_EDGE, "");
  const result = canonical ? trimmed : value;
  if (!trimmed || [...result].length > max) throw invalid("Text length is invalid", field);
  return result;
}

function identityEvidence(body: Record<string, unknown>): void {
  body.reason = skinText(body.reason, "reason", 500);
  if (!Array.isArray(body.evidenceRefs) || body.evidenceRefs.length < 1 || body.evidenceRefs.length > 8) throw invalid("Identity evidence is required", "evidenceRefs");
  body.evidenceRefs = [...body.evidenceRefs].map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid evidence", "evidenceRefs");
    const entry = value as Record<string, unknown>;
    ensureOnlyFields(entry, ["url", "observedAt", "region", "note"]);
    const url = skinText(entry.url, "evidenceRefs.url", 2000);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw invalid("Invalid evidence URL", "evidenceRefs.url"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw invalid("Public HTTPS evidence required", "evidenceRefs.url");
    const observedAt = skinText(entry.observedAt, "evidenceRefs.observedAt", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString().slice(0, 10) !== observedAt) throw invalid("Invalid evidence date", "evidenceRefs.observedAt");
    return { url, observedAt, region: skinText(entry.region, "evidenceRefs.region", 64), note: skinText(entry.note, "evidenceRefs.note", 500) };
  });
}

export function catalogIdentityReview(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input }; identityEvidence(body);
  return { reason: body.reason, evidenceRefs: body.evidenceRefs };
}

/** Transport-independent validation, shared by the actual catalog writers. */
export function parseSkinWrite(input: Record<string, unknown>, editing: boolean): Record<string, unknown> {
  ensureOnlyFields(input, [...SKIN_FIELDS, ...(editing ? ["mediaId", "ownerRef", "baseName", "confirmIdentity", "reason", "evidenceRefs"] : ["code"])]);
  const body = { ...input };
  parseExpectedRevision({ expectedRevision: body.expectedCatalogRevision });
  for (const field of ["name", "baseName"] as const) if (field in body) body[field] = skinText(body[field], field, 120);
  for (const field of ["categoryId", "mediaId"] as const) if (field in body && !(field === "mediaId" && body[field] === null)) body[field] = skinText(body[field], field, 128);
  if ("rarityCode" in body && body.rarityCode !== null) body.rarityCode = skinText(body.rarityCode, "rarityCode", 64);
  optionalInteger(body, "sortOrder", -100000, 100000);
  for (const field of ["enabled", "formVisible", "confirmIdentity"]) optionalBoolean(body, field);
  if ("aliases" in body) {
    if (!Array.isArray(body.aliases) || body.aliases.length > 32) throw invalid("Invalid aliases", "aliases");
    const aliases = [...body.aliases].map(value => skinText(value, "aliases", 200));
    if (new Set(aliases).size !== aliases.length) throw invalid("Duplicate aliases", "aliases");
    body.aliases = aliases;
  }
  const sourceFields = ["sourceNamespace", "sourceField", "sourceToken"];
  if (sourceFields.some(field => field in body)) {
    if (!sourceFields.every(field => field in body)) throw invalid("Complete primary source required", "sourceNamespace");
    if (!sourceFields.every(field => body[field] === null)) {
      for (const field of sourceFields) body[field] = skinText(body[field], field, field === "sourceToken" ? 200 : 64, field !== "sourceToken");
    }
    if (editing) identityEvidence(body);
  }
  if ("ownerRef" in body) {
    if (!body.ownerRef || typeof body.ownerRef !== "object" || Array.isArray(body.ownerRef)) throw invalid("Invalid owner reference", "ownerRef");
    const ref = body.ownerRef as Record<string, unknown>;
    ensureOnlyFields(ref, ["kind", "id"]);
    if (typeof ref.kind !== "string" || !["AGENT", "MELEE_TYPE", "FIREARM"].includes(ref.kind)) throw invalid("Invalid owner kind", "ownerRef.kind");
    body.ownerRef = { kind: ref.kind, id: skinText(ref.id, "ownerRef.id", 128) };
  }
  if ("ownerRef" in body || "baseName" in body || body.confirmIdentity === true) {
    if (body.confirmIdentity !== true) throw invalid("Explicit identity confirmation required", "confirmIdentity");
    identityEvidence(body);
  }
  if ("reason" in body) body.reason = skinText(body.reason, "reason", 500);
  if ("evidenceRefs" in body) identityEvidence(body);
  if (!editing) {
    requireCode(body);
    if (!body.name || !body.categoryId) throw invalid("Name and category required");
    if (body.enabled === true || body.formVisible === true) throw invalid("Create a disabled draft first");
  } else if (![...SKIN_FIELDS.filter(field => field !== "expectedCatalogRevision"), "mediaId", "ownerRef", "baseName"].some(field => field in body) && body.confirmIdentity !== true) {
    throw invalid("No catalog change requested");
  }
  return body;
}

async function checkCatalogRevision(client: PoolClient, gameId: string, body: Record<string, unknown>): Promise<void> {
  const expected = parseExpectedRevision({ expectedRevision: body.expectedCatalogRevision });
  const row = (await client.query<{ revision: string }>(`SELECT catalog_revision::text AS revision FROM zzsh_supply.game WHERE id=$1`, [gameId])).rows[0];
  if (!row) throw notFound();
  if (row.revision !== expected) throw conflict("Catalog changed; refresh and retry");
}

async function finishCatalogWrite(client: PoolClient, gameId: string, body: Record<string, unknown>): Promise<string> {
  const result = await client.query<{ revision: string }>(`UPDATE zzsh_supply.game SET catalog_revision=catalog_revision+1,updated_at=clock_timestamp() WHERE id=$1 AND catalog_revision::text=$2 RETURNING catalog_revision::text AS revision`, [gameId, body.expectedCatalogRevision]);
  if (result.rowCount !== 1) throw conflict("Catalog changed; refresh and retry");
  return result.rows[0]!.revision;
}

async function assertSkinSource(client: PoolClient, gameId: string, id: string, namespace: unknown, field: unknown, token: unknown): Promise<void> {
  if (namespace === null) return;
  const result = await client.query(`SELECT id FROM zzsh_supply.skin WHERE game_id=$1 AND source_namespace COLLATE "C"=$2 AND source_field COLLATE "C"=$3 AND source_token COLLATE "C"=$4 AND id<>$5`, [gameId, namespace, field, token, id]);
  if (result.rowCount) throw conflict("Primary source is already attached to another skin");
}

/**
 * Controlled migration seam for skin owners imported from the frozen crosswalk.
 * Human catalog maintenance records public HTTPS evidence; migration rows carry
 * the frozen research artifact instead, recorded through the caller's audit.
 */
export async function importLegacySkinOwner(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  input: { kind: "AGENT" | "MELEE_TYPE"; code: string; name: string; evidence: LegacyCatalogEvidence; audit: LegacyCatalogAudit; reason: string },
): Promise<{ id: string; kind: string; code: string; name: string; enabled: boolean }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const kind = input.kind;
  if (kind !== "AGENT" && kind !== "MELEE_TYPE") throw invalid("Unsupported owner kind", "kind");
  const code = requireCode(input);
  const name = skinText(input.name, "name", 120);
  const reason = skinText(input.reason, "reason", 500);
  const evidence = checkedLegacyEvidence(input.evidence);
  const audit = checkedLegacyAudit(input.audit);
  const record = { namespace: LEGACY_CATALOG_NAMESPACE, kind, code, name };
  if (legacyCatalogRecordDigest(record) !== evidence.recordDigest) throw invalid("Legacy evidence does not match the owner request", "evidence.recordDigest");
  const existing = (await client.query<{ id: string; name: string }>(`SELECT id,name FROM zzsh_supply.skin_owner WHERE game_id=$1 AND kind=$2 AND code=$3 FOR UPDATE`, [gameId, kind, code])).rows[0];
  if (existing) {
    if (existing.name !== name) throw conflict("Legacy owner conflicts with the recorded identity");
    await recordAudit(client, {
      actorType: "admin", actorId: adminUserId, sessionId: audit.sessionId, action: "supply.catalog.legacy_owner_imported",
      objectType: "skin_owner", objectId: existing.id, outcome: "SUCCESS", requestId: audit.requestId, reason,
      details: { ...record, evidenceArtifact: evidence.artifact, evidenceArtifactSha256: evidence.artifactSha256, recordDigest: evidence.recordDigest, result: "REPLAY_VERIFIED" },
    });
    return { id: existing.id, kind, code, name, enabled: true };
  }
  const id = newSupplyId("skin_owner");
  await client.query(`INSERT INTO zzsh_supply.skin_owner (id,game_id,kind,code,name) VALUES ($1,$2,$3,$4,$5)`, [id, gameId, kind, code, name]);
  await bumpCatalogRevision(client, gameId);
  await recordAudit(client, {
    actorType: "admin", actorId: adminUserId, sessionId: audit.sessionId, action: "supply.catalog.legacy_owner_imported",
    objectType: "skin_owner", objectId: id, outcome: "SUCCESS", requestId: audit.requestId, reason,
    details: { ...record, evidenceArtifact: evidence.artifact, evidenceArtifactSha256: evidence.artifactSha256, recordDigest: evidence.recordDigest, result: "CREATED" },
  });
  return { id, kind, code, name, enabled: true };
}

/**
 * Controlled migration seam for imported legacy skin identity. Human review
 * confirms identity with public HTTPS evidence; migration rows cannot provide
 * that, so the frozen crosswalk (source field + dictionary id + raw token +
 * canonical match) is the recorded evidence instead. Creates the draft via the
 * normal catalog service first, then writes the reviewed owner/base tuple; the
 * schema trigger derives VERIFIED and enforces the display-name contract.
 */
export async function confirmLegacySkinIdentity(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  input: { code: string; ownerRef: SkinOwnerRef; baseName: string; aliases?: string[]; evidence: LegacyCatalogEvidence; audit: LegacyCatalogAudit; reason: string },
): Promise<{ id: string; code: string; namingState: string; catalogRevision: string }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const code = requireCode(input);
  const ownerRef = input.ownerRef;
  if (!ownerRef || !["AGENT", "MELEE_TYPE", "FIREARM"].includes(ownerRef.kind) || typeof ownerRef.id !== "string") throw invalid("Invalid owner reference", "ownerRef");
  const baseName = skinText(input.baseName, "baseName", 120);
  const reason = skinText(input.reason, "reason", 500);
  const evidence = checkedLegacyEvidence(input.evidence);
  const audit = checkedLegacyAudit(input.audit);
  const aliases = input.aliases === undefined ? [] : [...input.aliases].map((value) => skinText(value, "aliases", 200));
  if (aliases.length > 32 || new Set(aliases).size !== aliases.length) throw invalid("Invalid aliases", "aliases");
  const row = (await client.query(`SELECT id,naming_state AS "namingState",owner_kind AS "ownerKind",owner_id AS "ownerId",firearm_id AS "firearmId",base_name AS "baseName",source_namespace AS "sourceNamespace",source_field AS "sourceField",source_token AS "sourceToken" FROM zzsh_supply.skin WHERE game_id=$1 AND code=$2 FOR UPDATE`, [gameId, code])).rows[0];
  if (!row) throw notFound();
  if (row.sourceNamespace !== LEGACY_CATALOG_NAMESPACE || !row.sourceField || !row.sourceToken) throw conflict("Legacy identity requires the migration source tuple");
  const record = { namespace: LEGACY_CATALOG_NAMESPACE, code, sourceField: row.sourceField, sourceToken: row.sourceToken, ownerKind: ownerRef.kind, ownerId: ownerRef.id, baseName };
  if (legacyCatalogRecordDigest(record) !== evidence.recordDigest) throw invalid("Legacy evidence does not match the skin identity request", "evidence.recordDigest");
  const recordedId = row.ownerKind === "FIREARM" ? row.firearmId : row.ownerId;
  const details = { ...record, aliases, evidenceArtifact: evidence.artifact, evidenceArtifactSha256: evidence.artifactSha256, recordDigest: evidence.recordDigest };
  if (row.namingState === "VERIFIED") {
    if (row.ownerKind !== ownerRef.kind || recordedId !== ownerRef.id || row.baseName !== baseName) throw conflict("Legacy identity conflicts with the recorded skin");
    await recordAudit(client, {
      actorType: "admin", actorId: adminUserId, sessionId: audit.sessionId, action: "supply.catalog.legacy_identity_confirmed",
      objectType: "skin", objectId: row.id, outcome: "SUCCESS", requestId: audit.requestId, reason, details: { ...details, result: "REPLAY_VERIFIED" },
    });
    return { id: row.id, code, namingState: row.namingState, catalogRevision: (await client.query(`SELECT catalog_revision::text AS revision FROM zzsh_supply.game WHERE id=$1`, [gameId])).rows[0].revision };
  }
  if (row.namingState !== "PENDING") throw conflict("Only a pending draft can receive legacy identity");
  const ownerName = ownerRef.kind === "FIREARM"
    ? (await client.query<{ name: string; enabled: boolean }>(`SELECT name,enabled FROM zzsh_supply.firearm WHERE game_id=$1 AND id=$2`, [gameId, ownerRef.id])).rows[0]?.name
    : (await client.query<{ name: string; enabled: boolean }>(`SELECT name,enabled FROM zzsh_supply.skin_owner WHERE game_id=$1 AND kind=$2 AND id=$3`, [gameId, ownerRef.kind, ownerRef.id])).rows[0]?.name;
  if (!ownerName) throw invalid("Owner does not belong to this game", "ownerRef");
  await client.query(
    `UPDATE zzsh_supply.skin SET owner_kind=$2, owner_id=$3, firearm_id=$4, base_name=$5, aliases=$6, name=$7, enabled=true, form_visible=true WHERE id=$1`,
    [row.id, ownerRef.kind, ownerRef.kind === "FIREARM" ? null : ownerRef.id, ownerRef.kind === "FIREARM" ? ownerRef.id : null, baseName, aliases, `${ownerName}-${baseName}`],
  );
  const state = (await client.query<{ namingState: string }>(`SELECT naming_state AS "namingState" FROM zzsh_supply.skin WHERE id=$1`, [row.id])).rows[0]!.namingState;
  await bumpCatalogRevision(client, gameId);
  await recordAudit(client, {
    actorType: "admin", actorId: adminUserId, sessionId: audit.sessionId, action: "supply.catalog.legacy_identity_confirmed",
    objectType: "skin", objectId: row.id, outcome: "SUCCESS", requestId: audit.requestId, reason, details: { ...details, displayName: `${ownerName}-${baseName}`, result: "CREATED" },
  });
  const catalogRevision = (await client.query<{ revision: string }>(`SELECT catalog_revision::text AS revision FROM zzsh_supply.game WHERE id=$1`, [gameId])).rows[0]!.revision;
  return { id: row.id, code, namingState: state, catalogRevision };
}

async function createSkin(client: PoolClient, gameId: string, id: string, input: Record<string, unknown>): Promise<CatalogRow> {
  const body = parseSkinWrite(input, false);
  await checkCatalogRevision(client, gameId, body);
  await assertUnique(client, "skin", gameId, body.code as string);
  await assertCategoryParent(client, gameId, body.categoryId as string);
  if (body.rarityCode) await assertRarity(client, gameId, body.rarityCode as string);
  await assertSkinSource(client, gameId, id, body.sourceNamespace ?? null, body.sourceField ?? null, body.sourceToken ?? null);
  await client.query(`INSERT INTO zzsh_supply.skin (id,game_id,code,name,category_id,rarity_code,enabled,form_visible,sort_order,source_namespace,source_field,source_token,aliases)
    VALUES ($1,$2,$3,$4,$5,$6,false,false,$7,$8,$9,$10,$11)`, [id, gameId, body.code, body.name, body.categoryId, body.rarityCode ?? null, body.sortOrder ?? 0, body.sourceNamespace ?? null, body.sourceField ?? null, body.sourceToken ?? null, body.aliases ?? []]);
  return { id, code: body.code as string, namingState: "PENDING", catalogRevision: await finishCatalogWrite(client, gameId, body) };
}

async function updateSkin(client: PoolClient, gameId: string, row: Record<string, unknown>, input: Record<string, unknown>): Promise<{ gameId: string; code: string; namingState: string; catalogRevision: string }> {
  const body = parseSkinWrite(input, true);
  await checkCatalogRevision(client, gameId, body);
  let name = body.name ?? row.name;
  let ownerKind = row.owner_kind ?? null, ownerId = row.owner_id ?? null, firearmId = row.firearm_id ?? null, baseName = row.base_name ?? null;
  if (body.confirmIdentity === true) {
    const ref = body.ownerRef as SkinOwnerRef | undefined;
    ownerKind = ref?.kind ?? ownerKind;
    ownerId = ref ? (ref.kind === "FIREARM" ? null : ref.id) : ownerId;
    firearmId = ref ? (ref.kind === "FIREARM" ? ref.id : null) : firearmId;
    baseName = body.baseName ?? baseName;
    if (!ownerKind || !baseName) throw invalid("Complete owner and base name required");
    const owner = ownerKind === "FIREARM"
      ? (await client.query<{ name: string; enabled: boolean }>(`SELECT name,enabled FROM zzsh_supply.firearm WHERE game_id=$1 AND id=$2`, [gameId, firearmId])).rows[0]
      : (await client.query<{ name: string; enabled: boolean }>(`SELECT name,enabled FROM zzsh_supply.skin_owner WHERE game_id=$1 AND kind=$2 AND id=$3`, [gameId, ownerKind, ownerId])).rows[0];
    if (!owner) throw invalid("Owner does not belong to this game", "ownerRef");
    const newBinding = row.naming_state !== "VERIFIED" || ownerKind !== row.owner_kind || ownerId !== row.owner_id || firearmId !== row.firearm_id;
    if (newBinding && !owner.enabled) throw invalid("Owner is disabled", "ownerRef");
    name = skinText(`${owner.name}-${baseName}`, "name", 120);
    if (body.name !== undefined && body.name !== name) throw invalid("Display name must match owner and base name", "name");
  } else if (name !== row.name) {
    if (row.naming_state === "VERIFIED") throw invalid("Confirm structured identity to rename this skin", "name");
    if (!body.reason) throw invalid("Rename reason required", "reason");
  }
  const namingState = body.confirmIdentity === true ? "VERIFIED" : String(row.naming_state);
  const enabled = body.enabled ?? row.enabled, formVisible = body.formVisible ?? row.form_visible;
  if (namingState === "PENDING" && (enabled || formVisible)) throw invalid("Pending skins cannot be enabled");
  if (namingState === "LEGACY" && ((!row.enabled && enabled) || (!row.form_visible && formVisible))) throw invalid("Review legacy identity before re-enabling");
  const aliases = body.aliases === undefined ? [...(row.aliases as string[])] : [...body.aliases as string[]];
  if (name !== row.name && !aliases.includes(row.name as string)) aliases.push(row.name as string);
  if (aliases.length > 32) throw invalid("Preserving the old name would exceed the alias limit", "aliases");
  const source = "sourceNamespace" in body
    ? [body.sourceNamespace, body.sourceField, body.sourceToken]
    : [row.source_namespace, row.source_field, row.source_token];
  if (row.source_namespace !== null && source.some((v, i) => v !== [row.source_namespace, row.source_field, row.source_token][i])) throw conflict("Primary source cannot be overwritten");
  if (row.source_namespace === null && row.source_field !== null && (source[1] !== row.source_field || source[2] !== row.source_token)) throw conflict("Legacy source token must be preserved");
  if (namingState !== "LEGACY" && source[0] === null && (source[1] !== null || source[2] !== null)) throw invalid("Review legacy source namespace before confirming identity");
  await assertSkinSource(client, gameId, String(row.id), source[0], source[1], source[2]);
  const categoryId = body.categoryId ?? row.category_id;
  await assertCategoryParent(client, gameId, categoryId as string);
  const rarityCode = "rarityCode" in body ? body.rarityCode : row.rarity_code;
  if (rarityCode) await assertRarity(client, gameId, rarityCode as string);
  const mediaId = "mediaId" in body ? body.mediaId : row.media_id;
  if (body.mediaId) await assertPlatformMediaBinding(client, gameId, body.mediaId as string, "SKIN_MEDIA");
  const result = await client.query<{ namingState: string }>(`UPDATE zzsh_supply.skin SET name=$1,enabled=$2,form_visible=$3,sort_order=$4,category_id=$5,rarity_code=$6,media_id=$7,aliases=$8,source_namespace=$9,source_field=$10,source_token=$11,owner_kind=$12,owner_id=$13,firearm_id=$14,base_name=$15 WHERE id=$16 RETURNING naming_state AS "namingState"`,
    [name, enabled, formVisible, body.sortOrder ?? row.sort_order, categoryId, rarityCode, mediaId, aliases, ...source, ownerKind, ownerId, firearmId, baseName, row.id]);
  if (result.rowCount !== 1) throw notFound();
  return { gameId, code: String(row.code), namingState: result.rows[0]!.namingState, catalogRevision: await finishCatalogWrite(client, gameId, body) };
}

export async function createSkinOwner(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  ensureOnlyFields(input, ["expectedCatalogRevision", "kind", "code", "name", "reason", "evidenceRefs"]);
  const body = { ...input }; identityEvidence(body);
  if (body.kind !== "AGENT" && body.kind !== "MELEE_TYPE") throw invalid("Unsupported owner kind");
  const code = requireCode(body), name = skinText(body.name, "name", 120);
  await checkCatalogRevision(client, gameId, body);
  const id = newSupplyId("skin_owner");
  await client.query(`INSERT INTO zzsh_supply.skin_owner (id,game_id,kind,code,name) VALUES ($1,$2,$3,$4,$5)`, [id, gameId, body.kind, code, name]);
  return { id, kind: body.kind, code, enabled: true, catalogRevision: await finishCatalogWrite(client, gameId, body) };
}

export async function updateSkinOwner(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  ensureOnlyFields(input, ["expectedCatalogRevision", "enabled", "reason"]);
  skinText(input.reason, "reason", 500);
  const enabled = optionalBoolean(input, "enabled");
  if (enabled === undefined) throw invalid("Enabled is required");
  const row = (await client.query<{ gameId: string; kind: string; code: string }>(`SELECT game_id AS "gameId",kind,code FROM zzsh_supply.skin_owner WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, row.gameId);
  await checkCatalogRevision(client, row.gameId, input);
  await client.query(`UPDATE zzsh_supply.skin_owner SET enabled=$1,updated_at=clock_timestamp() WHERE id=$2`, [enabled, id]);
  return { id, kind: row.kind, code: row.code, enabled, catalogRevision: await finishCatalogWrite(client, row.gameId, input) };
}

function requireCode(body: Record<string, unknown>, field = "code"): string {
  const value = requiredString(body, field, 64);
  if (!CODE_PATTERN.test(value)) throw invalid("Stable code is invalid");
  return value;
}

type GameRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  catalogRevision: string;
  currentReleaseId: string | null;
  coverMediaId: string | null;
  createdAt: string;
  updatedAt: string;
  services: Array<{ id: string; serviceCode: GameServiceCode; enabled: boolean; revision: string; supported: boolean }>;
};

export async function listGames(client: PoolClient, adminUserId: string, isBoss: boolean): Promise<{ games: GameRow[] }> {
  const scoped = isBoss
    ? ""
    : ` AND EXISTS (SELECT 1 FROM "zzsh_supply"."admin_supply_scope" s WHERE s."game_id" = g."id" AND s."admin_user_id" = $1)`;
  const result = await client.query<GameRow>(
    `SELECT g."id", g."code", g."name", g."description", g."enabled",
            g."catalog_revision"::text AS "catalogRevision", g."current_release_id" AS "currentReleaseId",
            g."cover_media_id" AS "coverMediaId", g."created_at" AS "createdAt", g."updated_at" AS "updatedAt"
       FROM "zzsh_supply"."game" g
      WHERE true${scoped}
      ORDER BY g."code"`,
    isBoss ? [] : [adminUserId],
  );
  const serviceRows = await client.query<{
    id: string;
    gameId: string;
    gameCode: string;
    serviceCode: GameServiceCode;
    enabled: boolean;
    revision: string;
  }>(
    `SELECT s."id", s."game_id" AS "gameId", g."code" AS "gameCode",
            s."service_code" AS "serviceCode", s."enabled", s."revision"::text AS "revision"
       FROM "zzsh_supply"."game_service_operation" s
       JOIN "zzsh_supply"."game" g ON g."id" = s."game_id"
      WHERE s."game_id" = ANY($1::text[])
      ORDER BY s."game_id", s."service_code"`,
    [result.rows.map((game) => game.id)],
  );
  const byGame = new Map<string, GameRow["services"]>();
  for (const row of serviceRows.rows) {
    const services = byGame.get(row.gameId) ?? [];
    services.push({ id: row.id, serviceCode: row.serviceCode, enabled: row.enabled, revision: row.revision, supported: isSupportedGameService(row.gameCode, row.serviceCode) });
    byGame.set(row.gameId, services);
  }
  return { games: result.rows.map((game) => ({ ...game, services: byGame.get(game.id) ?? [] })) };
}

export async function createGame(
  client: PoolClient,
  isBoss: boolean,
  body: Record<string, unknown>,
): Promise<GameRow> {
  if (!isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only a boss can create a game");
  const code = requireCode(body);
  const name = requiredString(body, "name", 120);
  const description = optionalTrimmedString(body, "description", 1000) ?? null;
  const existing = await client.query(`SELECT 1 FROM "zzsh_supply"."game" WHERE "code" = $1`, [code]);
  if (existing.rows.length > 0) throw conflict("Game code already exists");
  const id = newSupplyId("game");
  const result = await client.query<GameRow>(
    `INSERT INTO "zzsh_supply"."game" ("id", "code", "name", "description")
     VALUES ($1, $2, $3, $4)
     RETURNING "id", "code", "name", "description", "enabled",
       "catalog_revision"::text AS "catalogRevision", "current_release_id" AS "currentReleaseId",
       "cover_media_id" AS "coverMediaId", "created_at" AS "createdAt", "updated_at" AS "updatedAt"`,
    [id, code, name, description],
  );
  await ensureGameServiceRows(client, id);
  const serviceRows = await client.query<{ id: string; serviceCode: GameServiceCode; enabled: boolean; revision: string }>(
    `SELECT "id", "service_code" AS "serviceCode", "enabled", "revision"::text AS "revision"
       FROM "zzsh_supply"."game_service_operation" WHERE "game_id" = $1 ORDER BY "service_code"`,
    [id],
  );
  return {
    ...result.rows[0]!,
    services: serviceRows.rows.map((service) => ({ ...service, supported: isSupportedGameService(code, service.serviceCode) })),
  };
}

export async function updateGame(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "string" || !/^[1-9]\d*$/.test(expectedRevision)) throw invalid();
  const name = optionalString(body, "name", 120);
  const description = optionalNullableString(body, "description", 1000);
  const enabled = optionalBoolean(body, "enabled");
  if (name === undefined && description === undefined && enabled === undefined) throw invalid();
  const result = await client.query(
    `UPDATE "zzsh_supply"."game"
        SET "name" = COALESCE($1, "name"),
            "description" = CASE WHEN $2::boolean THEN $3::text ELSE "description" END,
            "enabled" = COALESCE($4, "enabled"),
            "catalog_revision" = "catalog_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $5 AND "catalog_revision"::text = $6`,
    [name ?? null, description !== undefined, description ?? null, enabled ?? null, gameId, expectedRevision],
  );
  if (result.rowCount !== 1) throw conflict("Catalog changed; refresh and retry");
}

type CatalogRow = { id: string; code?: string; namingState?: string; catalogRevision?: string };

export async function createCatalogEntry(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  kind: "items" | "rarities" | "categories" | "skins" | "entitlements",
  gameId: string,
  body: Record<string, unknown>,
): Promise<CatalogRow> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const id = newSupplyId(kind.slice(0, -1));
  if (kind === "items") {
    const unit = requiredString(body, "unit", 16);
    if (!UNITS.has(unit)) throw invalid("Unit is invalid");
    const code = requireCode(body);
    await assertUnique(client, "billable_item", gameId, code);
    await client.query(
      `INSERT INTO "zzsh_supply"."billable_item" ("id", "game_id", "code", "name", "unit", "quantity_scale", "required", "enabled", "sort_order", "source_field", "source_token", "source_note")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        unit,
        optionalInteger(body, "quantityScale", 0, 6) ?? 0,
        optionalBoolean(body, "required") ?? false,
        optionalBoolean(body, "enabled") ?? true,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalString(body, "sourceField", 64) ?? null,
        optionalString(body, "sourceToken", 200) ?? null,
        optionalTrimmedString(body, "sourceNote", 500) ?? null,
      ],
    );
  } else if (kind === "rarities") {
    const code = requireCode(body);
    await assertUnique(client, "skin_rarity", gameId, code);
    await client.query(
      `INSERT INTO "zzsh_supply"."skin_rarity" ("id", "game_id", "code", "name", "sort_order", "enabled")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, gameId, code, requiredString(body, "name", 120), optionalInteger(body, "sortOrder", -100000, 100000) ?? 0, optionalBoolean(body, "enabled") ?? true],
    );
  } else if (kind === "categories") {
    const code = requireCode(body);
    await assertUnique(client, "skin_category", gameId, code);
    const parentId = optionalNullableString(body, "parentId", 128);
    if (parentId !== undefined && parentId !== null) await assertCategoryParent(client, gameId, parentId);
    await client.query(
      `INSERT INTO "zzsh_supply"."skin_category" ("id", "game_id", "code", "name", "parent_id", "sort_order", "enabled", "form_visible")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        parentId ?? null,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalBoolean(body, "enabled") ?? true,
        optionalBoolean(body, "formVisible") ?? true,
      ],
    );
  } else if (kind === "skins") {
    return createSkin(client, gameId, id, body);
  } else {
    const code = requireCode(body);
    await assertUnique(client, "entitlement", gameId, code);
    const valueKind = requiredString(body, "valueKind", 16);
    if (!["FLAG", "LEVEL", "CAPACITY"].includes(valueKind)) throw invalid("Value kind is invalid");
    const expiryKind = requiredString(body, "expiryKind", 16);
    if (!["PERMANENT", "TIMED"].includes(expiryKind)) throw invalid("Expiry kind is invalid");
    await client.query(
      `INSERT INTO "zzsh_supply"."entitlement" ("id", "game_id", "code", "name", "value_kind", "expiry_kind", "enabled", "sort_order", "source_field", "source_token")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        gameId,
        code,
        requiredString(body, "name", 120),
        valueKind,
        expiryKind,
        optionalBoolean(body, "enabled") ?? true,
        optionalInteger(body, "sortOrder", -100000, 100000) ?? 0,
        optionalString(body, "sourceField", 64) ?? null,
        optionalString(body, "sourceToken", 200) ?? null,
      ],
    );
  }
  await bumpCatalogRevision(client, gameId);
  return { id };
}

export async function updateCatalogEntry(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  kind: "items" | "rarities" | "categories" | "skins" | "entitlements",
  entryId: string,
  body: Record<string, unknown>,
): Promise<{ gameId: string; code?: string; namingState?: string; catalogRevision?: string }> {
  const table = TABLE_BY_KIND[kind];
  const current = await client.query<Record<string, unknown>>(
    `SELECT * FROM "zzsh_supply"."${table}" WHERE "id" = $1${kind === "skins" ? " FOR UPDATE" : ""}`,
    [entryId],
  );
  const row = current.rows[0];
  if (!row) throw notFound();
  const gameId = String(row.game_id);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (kind === "items") {
    const name = optionalString(body, "name", 120);
    const unit = optionalString(body, "unit", 16);
    if (unit !== undefined && !UNITS.has(unit)) throw invalid("Unit is invalid");
    const required = optionalBoolean(body, "required");
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    const quantityScale = optionalInteger(body, "quantityScale", 0, 6);
    const mediaId = optionalNullableString(body, "mediaId", 128);
    if ([name, unit, required, enabled, sortOrder, quantityScale, mediaId].every((value) => value === undefined)) throw invalid();
    if (mediaId !== undefined && mediaId !== null) await assertPlatformMediaBinding(client, gameId, mediaId, "ITEM_MEDIA");
    await client.query(
      `UPDATE "zzsh_supply"."billable_item"
          SET "name" = COALESCE($1, "name"), "unit" = COALESCE($2, "unit"),
              "required" = COALESCE($3, "required"), "enabled" = COALESCE($4, "enabled"),
              "sort_order" = COALESCE($5, "sort_order"), "quantity_scale" = COALESCE($6, "quantity_scale"),
              "media_id" = CASE WHEN $7::boolean THEN $8::text ELSE "media_id" END,
              "updated_at" = clock_timestamp()
        WHERE "id" = $9`,
      [name ?? null, unit ?? null, required ?? null, enabled ?? null, sortOrder ?? null, quantityScale ?? null, mediaId !== undefined, mediaId ?? null, entryId],
    );
  } else if (kind === "rarities") {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
    if (enabled === false) await assertRarityUnused(client, gameId, String(row.code));
    await client.query(
      `UPDATE "zzsh_supply"."skin_rarity" SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"), "sort_order" = COALESCE($3, "sort_order"), "updated_at" = clock_timestamp() WHERE "id" = $4`,
      [name ?? null, enabled ?? null, sortOrder ?? null, entryId],
    );
  } else if (kind === "categories") {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const formVisible = optionalBoolean(body, "formVisible");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    const parentId = optionalNullableString(body, "parentId", 128);
    if ([name, enabled, formVisible, sortOrder, parentId].every((value) => value === undefined)) throw invalid();
    if (parentId !== undefined && parentId !== null) await assertCategoryParent(client, gameId, parentId);
    await client.query(
      `UPDATE "zzsh_supply"."skin_category"
          SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"),
              "form_visible" = COALESCE($3, "form_visible"), "sort_order" = COALESCE($4, "sort_order"),
              "parent_id" = CASE WHEN $5::boolean THEN $6 ELSE "parent_id" END,
              "updated_at" = clock_timestamp()
        WHERE "id" = $7`,
      [name ?? null, enabled ?? null, formVisible ?? null, sortOrder ?? null, parentId !== undefined, parentId ?? null, entryId],
    );
  } else if (kind === "skins") {
    return updateSkin(client, gameId, row, body);
  } else {
    const name = optionalString(body, "name", 120);
    const enabled = optionalBoolean(body, "enabled");
    const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
    if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
    await client.query(
      `UPDATE "zzsh_supply"."entitlement" SET "name" = COALESCE($1, "name"), "enabled" = COALESCE($2, "enabled"), "sort_order" = COALESCE($3, "sort_order"), "updated_at" = clock_timestamp() WHERE "id" = $4`,
      [name ?? null, enabled ?? null, sortOrder ?? null, entryId],
    );
  }
  await bumpCatalogRevision(client, gameId);
  return { gameId };
}

const TABLE_BY_KIND = {
  items: "billable_item",
  rarities: "skin_rarity",
  categories: "skin_category",
  skins: "skin",
  entitlements: "entitlement",
} as const;

async function assertUnique(client: PoolClient, table: string, gameId: string, code: string): Promise<void> {
  const existing = await client.query(`SELECT 1 FROM "zzsh_supply"."${table}" WHERE "game_id" = $1 AND "code" = $2`, [gameId, code]);
  if (existing.rows.length > 0) throw conflict("Stable code already exists in this game");
}

async function assertCategoryParent(client: PoolClient, gameId: string, categoryId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin_category" WHERE "id" = $1 AND "game_id" = $2`, [categoryId, gameId]);
  if (result.rows.length === 0) throw invalid("Category does not belong to this game");
}

async function assertRarity(client: PoolClient, gameId: string, rarityCode: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin_rarity" WHERE "game_id" = $1 AND "code" = $2`, [gameId, rarityCode]);
  if (result.rows.length === 0) throw invalid("Rarity is not defined for this game");
}

async function assertRarityUnused(client: PoolClient, gameId: string, rarityCode: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "zzsh_supply"."skin" WHERE "game_id" = $1 AND "rarity_code" = $2 LIMIT 1`, [gameId, rarityCode]);
  if (result.rows.length > 0) throw conflict("Rarity is still referenced by skins");
}

export async function bindGameCover(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const mediaId = optionalNullableString(body, "mediaId", 128);
  if (mediaId === undefined) throw invalid();
  if (mediaId !== null) await assertPlatformMediaBinding(client, gameId, mediaId, "GAME_COVER");
  await client.query(
    `UPDATE "zzsh_supply"."game" SET "cover_media_id" = $1, "catalog_revision" = "catalog_revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $2`,
    [mediaId, gameId],
  );
}

export async function assertPlatformMediaBinding(
  client: PoolClient,
  gameId: string,
  mediaId: string,
  purpose: string,
): Promise<void> {
  const result = await client.query<{ ownershipKind: string; purpose: string; reviewState: string; accessClass: string; gameId: string }>(
    `SELECT "ownership_kind" AS "ownershipKind", "purpose", "review_state" AS "reviewState",
            "access_class" AS "accessClass", "game_id" AS "gameId"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1`,
    [mediaId],
  );
  const asset = result.rows[0];
  if (!asset || asset.gameId !== gameId) throw invalid("Media does not belong to this game");
  if (asset.ownershipKind !== "PLATFORM_CATALOG") throw invalid("Only reviewed platform catalog media can be bound");
  if (asset.purpose !== purpose) throw invalid("Media purpose does not match this binding");
  if (asset.reviewState !== "APPROVED" || asset.accessClass !== "PUBLIC_DISPLAY") throw invalid("Media is not approved for public display");
}

export type CatalogFilters = { q?: string; categoryId?: string; rarityCode?: string };

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function parseCursor(cursor: string, binding: { gameId: string; revision: string; filters: CatalogFilters }): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalid("Cursor is invalid");
  const record = decoded as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.gameId !== binding.gameId ||
    record.revision !== binding.revision ||
    (record.q ?? null) !== (binding.filters.q ?? null) ||
    (record.categoryId ?? null) !== (binding.filters.categoryId ?? null) ||
    (record.rarityCode ?? null) !== (binding.filters.rarityCode ?? null) ||
    typeof record.lastSkinId !== "string"
  ) {
    throw conflict("Catalog changed or cursor does not match the current filters; refresh and retry");
  }
  return record.lastSkinId;
}

export function encodeCursor(binding: { gameId: string; revision: string; filters: CatalogFilters }, lastSkinId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, gameId: binding.gameId, revision: binding.revision, q: binding.filters.q ?? null, categoryId: binding.filters.categoryId ?? null, rarityCode: binding.filters.rarityCode ?? null, lastSkinId })).toString("base64url");
}

export async function readPublicCatalog(
  client: Pool | PoolClient,
  gameId: string,
  filters: CatalogFilters,
  limit: number,
  cursor?: string,
  scope: "browse" | "publishing" = "browse",
): Promise<Record<string, unknown>> {
  const game = await client.query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    catalogRevision: string;
    currentReleaseId: string | null;
    coverMediaId: string | null;
  }>(
    `SELECT "id", "code", "name", "description", "catalog_revision"::text AS "catalogRevision",
            "current_release_id" AS "currentReleaseId", "cover_media_id" AS "coverMediaId"
       FROM "zzsh_supply"."game" WHERE "id" = $1 AND "enabled" = true`,
    [gameId],
  );
  const gameRow = game.rows[0];
  if (!gameRow) throw notFound();
  let lastSkinId: string | undefined;
  if (cursor !== undefined) lastSkinId = parseCursor(cursor, { gameId, revision: gameRow.catalogRevision, filters });

  const itemSearch = scope === "browse" ? filters.q : undefined;
  const items = await client.query(
    `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "sort_order" AS "sortOrder",
            CASE WHEN EXISTS (SELECT 1 FROM zzsh_supply.media_asset a WHERE a.id=i.media_id AND a.game_id=i.game_id AND a.ownership_kind='PLATFORM_CATALOG' AND a.purpose='ITEM_MEDIA' AND a.review_state='APPROVED' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL) THEN i."media_id" ELSE NULL END AS "mediaId"
       FROM "zzsh_supply"."billable_item" i
      WHERE "game_id" = $1 AND "enabled" = true${scope === "publishing" ? ` AND EXISTS (SELECT 1 FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_line p ON p.price_version_id=r.price_version_id WHERE g.id=$1 AND p.item_id=i.id AND p.customer_tier='STANDARD')` : ""}${itemSearch ? ` AND "name" ILIKE $2 ESCAPE '\\'` : ""}
      ORDER BY "sort_order", "code", "id"`,
    itemSearch ? [gameId, `%${escapeLike(itemSearch)}%`] : [gameId],
  );

  const categories = await client.query(
    `WITH RECURSIVE visible AS (
       SELECT c."id", c."code", c."name", c."parent_id" AS "parentId", c."sort_order" AS "sortOrder"
         FROM "zzsh_supply"."skin_category" c
        WHERE c."game_id" = $1 AND c."enabled" = true AND c."form_visible" = true AND c."parent_id" IS NULL
       UNION ALL
       SELECT c."id", c."code", c."name", c."parent_id" AS "parentId", c."sort_order" AS "sortOrder"
         FROM "zzsh_supply"."skin_category" c
         JOIN visible p ON c."parent_id" = p."id"
        WHERE c."game_id" = $1 AND c."enabled" = true AND c."form_visible" = true
     )
     SELECT * FROM visible ORDER BY "sortOrder", "code", "id"`,
    [gameId],
  );

  const rarities = await client.query(
    `SELECT "code", "name", "sort_order" AS "sortOrder" FROM "zzsh_supply"."skin_rarity"
      WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );

  const entitlements = await client.query(
    `SELECT "id", "code", "name", "value_kind" AS "valueKind", "expiry_kind" AS "expiryKind", "sort_order" AS "sortOrder"
       FROM "zzsh_supply"."entitlement"
      WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );

  const parameters: unknown[] = [gameId];
  const conditions: string[] = [`s."game_id" = $1`, `s."enabled" = true`, `s."form_visible" = true`];
  parameters.push(categories.rows.map(c=>c.id));
  conditions.push(`s."category_id" = ANY($${parameters.length}::text[])`);
  if (filters.categoryId) {
    parameters.push(filters.categoryId);
    conditions.push(`s."category_id" IN (
      WITH RECURSIVE descendants AS (
        SELECT "id" FROM "zzsh_supply"."skin_category" WHERE "id" = $${parameters.length} AND "game_id" = $1
        UNION ALL
        SELECT c."id" FROM "zzsh_supply"."skin_category" c JOIN descendants d ON c."parent_id" = d."id"
      )
      SELECT "id" FROM descendants
    )`);
  }
  if (filters.rarityCode) {
    parameters.push(filters.rarityCode);
    conditions.push(`s."rarity_code" = $${parameters.length}`);
  }
  if (filters.q) {
    parameters.push(`%${escapeLike(filters.q)}%`);
    conditions.push(`s."name" ILIKE $${parameters.length} ESCAPE '\\'`);
  }
  if (lastSkinId !== undefined) {
    parameters.push(lastSkinId);
    conditions.push(`s."id" > $${parameters.length}`);
  }
  parameters.push(limit + 1);
  const skins = await client.query(
    `SELECT s."id", s."code", s."name", s."category_id" AS "categoryId", s."rarity_code" AS "rarityCode",
            CASE WHEN EXISTS (SELECT 1 FROM zzsh_supply.media_asset a WHERE a.id=s.media_id AND a.game_id=s.game_id AND a.ownership_kind='PLATFORM_CATALOG' AND a.purpose='SKIN_MEDIA' AND a.review_state='APPROVED' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL) THEN s."media_id" ELSE NULL END AS "mediaId", s."sort_order" AS "sortOrder"
       FROM "zzsh_supply"."skin" s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s."id"
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = skins.rows.length > limit;
  const page = hasMore ? skins.rows.slice(0, limit) : skins.rows;
  const nextCursor = hasMore ? encodeCursor({ gameId, revision: gameRow.catalogRevision, filters }, page[page.length - 1]!.id) : null;

  const missing = scope === "publishing" ? (await client.query(`SELECT id,name FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled AND required AND NOT (id=ANY($2::text[]))`,[gameId,items.rows.map(i=>i.id)])).rows : [];
  return {
    ...(scope === "publishing" ? {ready: Boolean(gameRow.currentReleaseId) && missing.length===0, blockers: !gameRow.currentReleaseId ? [{code:"RULE_UNCONFIGURED",path:"rules"}] : missing.map(i=>({code:"REQUIRED_ITEM_UNPRICED",path:"inventory",itemId:i.id,name:i.name})), inputScale:0} : {}),
    game: gameRow,
    items: items.rows,
    categories: categories.rows,
    rarities: rarities.rows,
    entitlements: entitlements.rows,
    skins: page,
    nextCursor,
    limit,
  };
}

export async function readAdminCatalog(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
): Promise<Record<string, unknown>> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const game = await client.query(
    `SELECT "id", "code", "name", "description", "enabled", "catalog_revision"::text AS "catalogRevision",
            "current_release_id" AS "currentReleaseId", "cover_media_id" AS "coverMediaId"
       FROM "zzsh_supply"."game" WHERE "id" = $1`,
    [gameId],
  );
  if (game.rows.length === 0) throw notFound();
  const [items, rarities, categories, skins, entitlements, owners] = await Promise.all([
    client.query(
      `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "enabled",
              "sort_order" AS "sortOrder", "media_id" AS "mediaId", "source_field" AS "sourceField", "source_token" AS "sourceToken", "source_note" AS "sourceNote"
         FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "sort_order" AS "sortOrder", "enabled" FROM "zzsh_supply"."skin_rarity" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "parent_id" AS "parentId", "sort_order" AS "sortOrder", "enabled", "form_visible" AS "formVisible"
         FROM "zzsh_supply"."skin_category" WHERE "game_id" = $1 ORDER BY "parent_id" NULLS FIRST, "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "category_id" AS "categoryId", "rarity_code" AS "rarityCode", "enabled",
              "form_visible" AS "formVisible", "media_id" AS "mediaId", "sort_order" AS "sortOrder",
              "source_field" AS "sourceField", "source_token" AS "sourceToken", "source_namespace" AS "sourceNamespace",
              "base_name" AS "baseName", "aliases", "naming_state" AS "namingState",
              CASE WHEN owner_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',owner_kind,'id',COALESCE(owner_id,firearm_id)) END AS "ownerRef"
         FROM "zzsh_supply"."skin" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(
      `SELECT "id", "code", "name", "value_kind" AS "valueKind", "expiry_kind" AS "expiryKind", "enabled",
              "sort_order" AS "sortOrder", "source_field" AS "sourceField", "source_token" AS "sourceToken"
         FROM "zzsh_supply"."entitlement" WHERE "game_id" = $1 ORDER BY "sort_order", "code"`,
      [gameId],
    ),
    client.query(`SELECT id,kind,code,name,enabled FROM zzsh_supply.skin_owner WHERE game_id=$1 ORDER BY kind,code,id`, [gameId]),
  ]);
  return {
    game: game.rows[0],
    items: items.rows,
    rarities: rarities.rows,
    categories: categories.rows,
    skins: skins.rows,
    entitlements: entitlements.rows,
    owners: owners.rows,
  };
}
