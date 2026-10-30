import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { humanText } from "../supply/content-hash";
import { conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "../supply/supply-util";

export const LEGAL_DOC_TYPES = ["PLATFORM_TERMS", "PLATFORM_PRIVACY"] as const;
export type LegalDocType = (typeof LEGAL_DOC_TYPES)[number];

export const DOCUMENT_TYPES = [
  ...LEGAL_DOC_TYPES,
  "RENTAL_AGREEMENT",
  "FULL_PAYOUT_TERMS",
  "EARLY_SETTLEMENT_OWNER",
  "EARLY_SETTLEMENT_RENTER",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const ACCEPTANCE_SOURCES = [
  "REGISTRATION",
  "LOGIN",
  "ACCOUNT_READ",
  "ORDER_CREATE",
  "SETTLEMENT_SUBMIT",
  "SETTLEMENT_DECISION",
] as const;
export type AcceptanceSource = (typeof ACCEPTANCE_SOURCES)[number];

export type LegalDocumentVersion = {
  id: string;
  docType: LegalDocType;
  title: string;
  body: string;
  digest: string;
  status: "DRAFT" | "SEALED";
  revision: string;
  effectiveAt: string | null;
  sealedAt: string | null;
  createdAt: string;
};

export type LegalAcceptanceRef = { versionId: string; digest: string };
export type PlatformLegalAcceptance = { terms: LegalAcceptanceRef; privacy: LegalAcceptanceRef };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function text(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") throw invalid("Legal document field is invalid", field);
  const normalized = humanText(value).trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) throw invalid("Legal document field is invalid", field);
  return normalized;
}

export function legalDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function parseLegalDocType(value: unknown): LegalDocType {
  if (typeof value !== "string" || !(LEGAL_DOC_TYPES as readonly string[]).includes(value)) throw invalid("Legal document type is invalid", "docType");
  return value as LegalDocType;
}

export function parseDocumentType(value: unknown): DocumentType {
  if (typeof value !== "string" || !(DOCUMENT_TYPES as readonly string[]).includes(value)) throw invalid("Document type is invalid", "documentType");
  return value as DocumentType;
}

export function parseAcceptanceSource(value: unknown): AcceptanceSource {
  if (typeof value !== "string" || !(ACCEPTANCE_SOURCES as readonly string[]).includes(value)) throw invalid("Acceptance source is invalid", "source");
  return value as AcceptanceSource;
}

function effectiveAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid("Effective time is invalid", "effectiveAt");
  return value;
}

export function parseLegalAcceptanceRef(value: unknown, field: string): LegalAcceptanceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Legal acceptance is invalid", field);
  const record = value as Record<string, unknown>;
  ensureOnlyFields(record, ["versionId", "digest"]);
  if (typeof record.versionId !== "string" || !ID.test(record.versionId) || typeof record.digest !== "string" || !DIGEST.test(record.digest)) {
    throw invalid("Legal acceptance is invalid", field);
  }
  return { versionId: record.versionId, digest: record.digest };
}

export function parsePlatformLegalAcceptance(value: unknown): PlatformLegalAcceptance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Legal acceptance is invalid", "legalAcceptance");
  const record = value as Record<string, unknown>;
  ensureOnlyFields(record, ["terms", "privacy"]);
  return {
    terms: parseLegalAcceptanceRef(record.terms, "legalAcceptance.terms"),
    privacy: parseLegalAcceptanceRef(record.privacy, "legalAcceptance.privacy"),
  };
}

const SELECT_FIELDS = `v."id", v."doc_type" AS "docType", v."title", v."body", v."digest", v."status",
  v."revision"::text AS "revision",
  to_char(v."effective_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
  to_char(v."sealed_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sealedAt",
  to_char(v."created_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
const RETURNING_FIELDS = SELECT_FIELDS.replaceAll('v."', '"');

function verifyRow(row: LegalDocumentVersion): LegalDocumentVersion {
  if (legalDigest(row.body) !== row.digest) throw conflict("法律文书正文与摘要不一致");
  return row;
}

export async function listLegalDocuments(client: PoolClient, docType?: LegalDocType): Promise<LegalDocumentVersion[]> {
  const rows = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v
      WHERE ($1::text IS NULL OR v."doc_type" = $1)
      ORDER BY v."created_at" DESC, v."id" DESC LIMIT 50`,
    [docType ?? null],
  )).rows;
  return rows.map(verifyRow);
}

export async function readLegalDocumentById(client: PoolClient, id: string): Promise<LegalDocumentVersion | null> {
  const row = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = $1`, [id],
  )).rows[0];
  return row ? verifyRow(row) : null;
}

export async function createLegalDraft(client: PoolClient, adminUserId: string, body: Record<string, unknown>): Promise<LegalDocumentVersion> {
  ensureOnlyFields(body, ["docType", "title", "body", "effectiveAt"]);
  const docType = parseLegalDocType(body.docType);
  const title = text(body.title, "title", 640);
  const documentBody = text(body.body, "body", 20_000);
  const at = effectiveAt(body.effectiveAt);
  const id = newSupplyId("legal");
  const row = (await client.query<LegalDocumentVersion>(
    `INSERT INTO "zzsh_content"."legal_document_version"
      ("id", "doc_type", "title", "body", "digest", "effective_at", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
     RETURNING ${RETURNING_FIELDS}`,
    [id, docType, title, documentBody, legalDigest(documentBody), at, adminUserId],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

export async function updateLegalDraft(client: PoolClient, id: string, body: Record<string, unknown>): Promise<LegalDocumentVersion> {
  ensureOnlyFields(body, ["expectedRevision", "title", "body", "effectiveAt"]);
  if (typeof body.expectedRevision !== "string" || !/^(1|[1-9]\d*)$/.test(body.expectedRevision)) throw invalid("Expected revision is invalid", "expectedRevision");
  const current = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = $1 FOR UPDATE`, [id],
  )).rows[0];
  if (!current) throw notFound();
  if (current.status !== "DRAFT") throw conflict("Sealed legal document cannot be edited");
  if (current.revision !== body.expectedRevision) throw conflict("Legal document changed; reload and retry");
  const title = body.title === undefined ? current.title : text(body.title, "title", 640);
  const documentBody = body.body === undefined ? current.body : text(body.body, "body", 20_000);
  const at = body.effectiveAt === undefined ? current.effectiveAt : effectiveAt(body.effectiveAt);
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "title" = $2, "body" = $3, "digest" = $4, "effective_at" = $5::timestamptz,
            "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id, title, documentBody, legalDigest(documentBody), at],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

export async function sealLegalDocument(client: PoolClient, adminUserId: string, id: string, expectedRevision: unknown): Promise<LegalDocumentVersion> {
  if (typeof expectedRevision !== "string" || !/^(1|[1-9]\d*)$/.test(expectedRevision)) throw invalid("Expected revision is invalid", "expectedRevision");
  const current = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = $1 FOR UPDATE`, [id],
  )).rows[0];
  if (!current) throw notFound();
  if (current.status !== "DRAFT") throw conflict("Legal document is already sealed");
  if (current.revision !== expectedRevision) throw conflict("Legal document changed; reload and retry");
  verifyRow(current);
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "status" = 'SEALED', "sealed_by_admin_id" = $2, "sealed_at" = clock_timestamp(),
            "effective_at" = COALESCE("effective_at", clock_timestamp()), "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id, adminUserId],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

export async function readCurrentLegalDocument(client: PoolClient, docType: LegalDocType, at?: string): Promise<LegalDocumentVersion | null> {
  const row = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v
      WHERE v."doc_type" = $1 AND v."status" = 'SEALED'
        AND v."effective_at" <= COALESCE($2::timestamptz, clock_timestamp())
      ORDER BY v."effective_at" DESC, v."sealed_at" DESC, v."id" DESC LIMIT 1`,
    [docType, at ?? null],
  )).rows[0];
  return row ? verifyRow(row) : null;
}

export async function readCurrentPlatformDocuments(client: PoolClient, at?: string): Promise<{ terms: LegalDocumentVersion | null; privacy: LegalDocumentVersion | null }> {
  const terms = await readCurrentLegalDocument(client, "PLATFORM_TERMS", at);
  const privacy = await readCurrentLegalDocument(client, "PLATFORM_PRIVACY", at);
  return { terms, privacy };
}

export type PlatformLegalAcceptanceCheck =
  | { required: false }
  | { required: true; terms: LegalDocumentVersion; privacy: LegalDocumentVersion };

export async function verifyPlatformLegalAcceptance(client: PoolClient, value: unknown): Promise<PlatformLegalAcceptanceCheck> {
  const current = await readCurrentPlatformDocuments(client);
  if (!current.terms && !current.privacy) return { required: false };
  if (!current.terms || !current.privacy) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "平台法律文书未完整发布");
  const acceptance = parsePlatformLegalAcceptance(value);
  if (!acceptance) throw invalid("注册或登录前需阅读并同意平台服务协议与隐私政策", "legalAcceptance");
  if (acceptance.terms.versionId !== current.terms.id || acceptance.terms.digest !== current.terms.digest
    || acceptance.privacy.versionId !== current.privacy.id || acceptance.privacy.digest !== current.privacy.digest) {
    throw conflict("平台法律文书已更新，请重新阅读并确认");
  }
  return { required: true, terms: current.terms, privacy: current.privacy };
}

export type DocumentAcceptanceInput = {
  userId: string;
  documentType: DocumentType;
  documentVersionId: string;
  documentDigest: string;
  subjectType: "USER" | "ACCOUNT" | "ORDER";
  subjectId: string;
  source: AcceptanceSource;
  requestId?: string;
};

export async function recordDocumentAcceptance(client: PoolClient, input: DocumentAcceptanceInput): Promise<void> {
  const documentType = parseDocumentType(input.documentType);
  const source = parseAcceptanceSource(input.source);
  if (!ID.test(input.documentVersionId) || !DIGEST.test(input.documentDigest) || !ID.test(input.subjectId)) throw invalid("Document acceptance is invalid");
  await client.query(
    `INSERT INTO "zzsh_content"."document_acceptance"
      ("id", "user_id", "document_type", "document_version_id", "document_digest", "subject_type", "subject_id", "source", "request_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("user_id", "document_type", "document_version_id", "document_digest", "subject_type", "subject_id") DO NOTHING`,
    [newSupplyId("accept"), input.userId, documentType, input.documentVersionId, input.documentDigest,
      input.subjectType, input.subjectId, source, input.requestId ?? null],
  );
}

export async function recordPlatformAcceptances(
  client: PoolClient,
  userId: string,
  acceptance: PlatformLegalAcceptance,
  source: "REGISTRATION" | "LOGIN",
  requestId?: string,
): Promise<void> {
  await recordDocumentAcceptance(client, {
    userId, documentType: "PLATFORM_TERMS", documentVersionId: acceptance.terms.versionId,
    documentDigest: acceptance.terms.digest, subjectType: "USER", subjectId: userId, source, requestId,
  });
  await recordDocumentAcceptance(client, {
    userId, documentType: "PLATFORM_PRIVACY", documentVersionId: acceptance.privacy.versionId,
    documentDigest: acceptance.privacy.digest, subjectType: "USER", subjectId: userId, source, requestId,
  });
}

export function sameAcceptanceRef(ref: LegalAcceptanceRef, versionId: string, digest: string): boolean {
  return ref.versionId === versionId && ref.digest === digest;
}
