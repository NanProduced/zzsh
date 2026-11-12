import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { humanText } from "../supply/content-hash";
import { conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "../supply/supply-util";

/** 平台协议两份按份同意；EARLY_SETTLEMENT 只进订单快照，不进登录同意。 */
export const LEGAL_DOC_TYPES = ["PLATFORM_TERMS", "PLATFORM_PRIVACY"] as const;
export type LegalDocType = (typeof LEGAL_DOC_TYPES)[number];

export const FIXED_DOC_TYPES = [...LEGAL_DOC_TYPES, "EARLY_SETTLEMENT"] as const;
export type FixedDocType = (typeof FIXED_DOC_TYPES)[number];

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

export type LegalDocumentStatus = "DRAFT" | "PENDING" | "SEALED";
export type LegalBodyFormat = "text" | "plate";

export type LegalDocumentVersion = {
  id: string;
  docType: FixedDocType;
  title: string;
  body: string;
  bodyFormat: LegalBodyFormat;
  bodyDocument: PlateDocumentEnvelope | null;
  digest: string;
  status: LegalDocumentStatus;
  revision: string;
  effectiveAt: string | null;
  sealedAt: string | null;
  approvalRequestId: string | null;
  createdAt: string;
};

export type LegalAcceptanceRef = { versionId: string; digest: string };
/** 按份同意：只提交本次需要（或客户端愿意重新确认）的那几份。 */
export type PlatformLegalAcceptance = { terms?: LegalAcceptanceRef; privacy?: LegalAcceptanceRef };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function text(value: unknown, field: string, maxBytes: number, maxChars?: number): string {
  if (typeof value !== "string") throw invalid("Legal document field is invalid", field);
  const normalized = humanText(value).trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes || maxChars !== undefined && Array.from(normalized).length > maxChars) throw invalid("Legal document field is invalid", field);
  return normalized;
}

export function legalDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function normalizeLegalDocumentBody(value: unknown): string {
  return text(value, "body", 20_000);
}

/**
 * 提前结算告知 v1 的原文与摘要金标准。正文已入库（0202 + 首部署初始化），
 * 常量只保留作初始化比对与既有订单快照的金标准，不再作为新单的唯一来源。
 */
const EARLY_DISCLOSURE_BODY = "本次提前结束需双方确认并经受权客服复核后生效。费用和退款责任以本次结算版本列示的金额为准，具体承担按核实的结束原因处理。退款在结算生效后7个自然日发起；发起退款不代表渠道或银行到账。";
export type EarlySettlementDisclosure = { versionId: string; body: string; digest: string };

export function newEarlySettlementDisclosure(): EarlySettlementDisclosure {
  return { versionId: "early-settlement-fees-v1", body: EARLY_DISCLOSURE_BODY, digest: legalDigest(EARLY_DISCLOSURE_BODY) };
}

export function readEarlySettlementDisclosure(quote: { agreementAcceptanceSchema?: unknown; earlySettlementDisclosure?: unknown }): EarlySettlementDisclosure | null {
  if (quote.agreementAcceptanceSchema !== 1) return null;
  const doc = quote.earlySettlementDisclosure as Partial<EarlySettlementDisclosure> | null;
  if (!doc || typeof doc.versionId !== "string" || !ID.test(doc.versionId) || doc.versionId.length > 80 || typeof doc.body !== "string" || !doc.body || typeof doc.digest !== "string" || doc.digest !== legalDigest(doc.body)) {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "本单提前结束说明暂时无法核验");
  }
  return { versionId: doc.versionId, body: doc.body, digest: doc.digest };
}

export function parseLegalDocType(value: unknown): LegalDocType {
  if (typeof value !== "string" || !(LEGAL_DOC_TYPES as readonly string[]).includes(value)) throw invalid("Legal document type is invalid", "docType");
  return value as LegalDocType;
}

export function parseFixedDocType(value: unknown): FixedDocType {
  if (typeof value !== "string" || !(FIXED_DOC_TYPES as readonly string[]).includes(value)) throw invalid("Legal document type is invalid", "docType");
  return value as FixedDocType;
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
  if (Number(value.slice(0, 4)) < 1 || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid("Effective time is invalid", "effectiveAt");
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

/** 缺哪份要哪份：至少提交一份，字段只允许 terms / privacy。 */
export function parsePlatformLegalAcceptance(value: unknown): PlatformLegalAcceptance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Legal acceptance is invalid", "legalAcceptance");
  const record = value as Record<string, unknown>;
  ensureOnlyFields(record, ["terms", "privacy"]);
  const acceptance: PlatformLegalAcceptance = {};
  if (record.terms !== undefined) acceptance.terms = parseLegalAcceptanceRef(record.terms, "legalAcceptance.terms");
  if (record.privacy !== undefined) acceptance.privacy = parseLegalAcceptanceRef(record.privacy, "legalAcceptance.privacy");
  if (!acceptance.terms && !acceptance.privacy) throw invalid("Legal acceptance is invalid", "legalAcceptance");
  return acceptance;
}

const SELECT_FIELDS = `v."id", v."doc_type" AS "docType", v."title", v."body", v."body_format" AS "bodyFormat",
  v."body_document" AS "bodyDocument", v."digest", v."status",
  v."revision"::text AS "revision", v."approval_request_id" AS "approvalRequestId",
  to_char(v."effective_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
  to_char(v."sealed_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sealedAt",
  to_char(v."created_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
const RETURNING_FIELDS = SELECT_FIELDS.replaceAll('v."', '"');

/**
 * 摘要校验只依赖存储值：text 行永远 sha256(body)（绝不重算历史行），
 * plate 行 plateDigest(body_document)，并核对 body 仍是该文档的纯文本投影。
 */
async function verifyRow(row: LegalDocumentVersion): Promise<LegalDocumentVersion> {
  if (row.bodyFormat === "plate") {
    if (!row.bodyDocument) throw conflict("法律文书正文与摘要不一致");
    if (await plateDigest(row.bodyDocument) !== row.digest) throw conflict("法律文书正文与摘要不一致");
    if (plateProjection(row.bodyDocument) !== row.body) throw conflict("法律文书正文与摘要不一致");
    return row;
  }
  if (legalDigest(row.body) !== row.digest) throw conflict("法律文书正文与摘要不一致");
  return row;
}

/** plate 行的 body 是纯文本投影，由服务端派生，客户端不能自带。 */
export function plateProjection(document: PlateDocumentEnvelope): string {
  return extractPlate(document).plainText;
}

export function parseLegalPlateDocument(value: unknown, mode: "draft" | "publish"): PlateDocumentEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Legal document plate payload is invalid", "bodyDocument");
  const document = value as PlateDocumentEnvelope;
  if (document.format !== "plate" || document.schemaVersion !== 1 || document.preset !== "legal") {
    throw invalid("Legal document plate payload is invalid", "bodyDocument");
  }
  const checked = validatePlateDocument(document, { preset: "legal", mode });
  if (!checked.ok) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "法律文书排版校验未通过",
      checked.errors.slice(0, 5).map(issue => ({ path: `bodyDocument${issue.path.slice(1)}`, code: "PLATE_INVALID" as const })));
  }
  const projection = plateProjection(document);
  if (!projection.trim() || Buffer.byteLength(projection, "utf8") > 20_000) throw invalid("Legal document field is invalid", "bodyDocument");
  return document;
}

export async function listLegalDocuments(client: PoolClient, docType?: FixedDocType): Promise<LegalDocumentVersion[]> {
  const rows = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v
      WHERE ($1::text IS NULL OR v."doc_type" = $1)
      ORDER BY v."created_at" DESC, v."id" DESC LIMIT 50`,
    [docType ?? null],
  )).rows;
  return Promise.all(rows.map(verifyRow));
}

export async function readLegalDocumentById(client: PoolClient, id: string): Promise<LegalDocumentVersion | null> {
  const row = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = $1`, [id],
  )).rows[0];
  return row ? verifyRow(row) : null;
}

/** 审批投影按页批量取冻结草稿：查询条数与申请行数无关。 */
export async function readLegalDocumentsByIds(client: PoolClient, ids: readonly string[]): Promise<LegalDocumentVersion[]> {
  if (ids.length === 0) return [];
  const rows = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = ANY($1::text[])`, [[...ids]],
  )).rows;
  return Promise.all(rows.map(verifyRow));
}

async function lockLegalDocument(client: PoolClient, id: string): Promise<LegalDocumentVersion> {
  const row = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v WHERE v."id" = $1 FOR UPDATE`, [id],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

type DraftContent = { title: string; bodyFormat: LegalBodyFormat; bodyDocument: PlateDocumentEnvelope | null; documentBody: string; digest: string };

async function draftContent(body: Record<string, unknown>, docType: FixedDocType, current?: LegalDocumentVersion): Promise<DraftContent> {
  const title = body.title === undefined ? current?.title ?? "" : text(body.title, "title", 640, 160);
  if (!title) throw invalid("Legal document field is invalid", "title");
  const format: LegalBodyFormat = current ? current.bodyFormat : docType === "EARLY_SETTLEMENT" ? "text" : "plate";
  if (format === "plate") {
    if (body.body !== undefined) throw invalid("Plate legal document body is derived from bodyDocument", "body");
    if (body.bodyDocument === undefined && !current) throw invalid("Legal document plate payload is invalid", "bodyDocument");
    const document = body.bodyDocument === undefined ? current!.bodyDocument! : parseLegalPlateDocument(body.bodyDocument, "draft");
    return { title, bodyFormat: "plate", bodyDocument: document, documentBody: plateProjection(document), digest: await plateDigest(document) };
  }
  if (body.bodyDocument !== undefined) throw invalid("Early settlement disclosure stays plain text", "bodyDocument");
  if (body.body === undefined && !current) throw invalid("Legal document field is invalid", "body");
  const documentBody = body.body === undefined ? current!.body : normalizeLegalDocumentBody(body.body);
  return { title, bodyFormat: "text", bodyDocument: null, documentBody, digest: legalDigest(documentBody) };
}

export async function createLegalDraft(client: PoolClient, adminUserId: string, body: Record<string, unknown>): Promise<LegalDocumentVersion> {
  ensureOnlyFields(body, ["docType", "title", "body", "bodyDocument", "effectiveAt"]);
  const docType = parseFixedDocType(body.docType);
  const content = await draftContent(body, docType);
  const at = effectiveAt(body.effectiveAt);
  const id = newSupplyId("legal");
  const row = (await client.query<LegalDocumentVersion>(
    `INSERT INTO "zzsh_content"."legal_document_version"
      ("id", "doc_type", "title", "body", "body_format", "body_document", "digest", "effective_at", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9)
     RETURNING ${RETURNING_FIELDS}`,
    [id, docType, content.title, content.documentBody, content.bodyFormat,
      content.bodyDocument ? JSON.stringify(content.bodyDocument) : null, content.digest, at, adminUserId],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

export async function updateLegalDraft(client: PoolClient, id: string, body: Record<string, unknown>): Promise<LegalDocumentVersion> {
  ensureOnlyFields(body, ["expectedRevision", "title", "body", "bodyDocument", "effectiveAt"]);
  if (typeof body.expectedRevision !== "string" || !/^(1|[1-9]\d*)$/.test(body.expectedRevision)) throw invalid("Expected revision is invalid", "expectedRevision");
  const current = await lockLegalDocument(client, id);
  if (current.status !== "DRAFT") throw conflict("Sealed legal document cannot be edited");
  if (current.revision !== body.expectedRevision) throw conflict("Legal document changed; reload and retry");
  const content = await draftContent(body, current.docType, current);
  const at = body.effectiveAt === undefined ? current.effectiveAt : effectiveAt(body.effectiveAt);
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "title" = $2, "body" = $3, "body_format" = $4, "body_document" = $5::jsonb, "digest" = $6,
            "effective_at" = $7::timestamptz, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id, content.title, content.documentBody, content.bodyFormat,
      content.bodyDocument ? JSON.stringify(content.bodyDocument) : null, content.digest, at],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

/**
 * 提交发布审批：DRAFT → PENDING，并绑定真实审批申请号。
 * 生效只能由「固定文书发布」执行器在同一决定事务里完成（PENDING → SEALED）。
 */
export async function submitLegalDocument(client: PoolClient, id: string, expectedRevision: unknown, approvalRequestId: string): Promise<LegalDocumentVersion> {
  if (typeof expectedRevision !== "string" || !/^(1|[1-9]\d*)$/.test(expectedRevision)) throw invalid("Expected revision is invalid", "expectedRevision");
  if (typeof approvalRequestId !== "string" || !ID.test(approvalRequestId)) throw invalid("Approval request is invalid", "approvalRequestId");
  const current = await lockLegalDocument(client, id);
  if (current.status !== "DRAFT") throw conflict("Legal document is already submitted or sealed");
  if (current.revision !== expectedRevision) throw conflict("Legal document changed; reload and retry");
  if (current.docType !== "EARLY_SETTLEMENT" && current.bodyFormat !== "plate") throw conflict("平台法律文书新版本只能使用 Plate 排版");
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "status" = 'PENDING', "approval_request_id" = $2, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id, approvalRequestId],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

/** 审批被驳回 / 撤回后退回草稿：正文与摘要保持提交时的冻结值。 */
export async function returnLegalDocumentToDraft(client: PoolClient, id: string): Promise<LegalDocumentVersion> {
  const current = await lockLegalDocument(client, id);
  if (current.status !== "PENDING") throw conflict("Legal document is not pending approval");
  const request = (await client.query<{ status: string }>(
    `SELECT "status" FROM "zzsh_iam"."approval_request" WHERE "id" = $1`, [current.approvalRequestId],
  )).rows[0];
  if (!request) throw conflict("Approval request is unavailable");
  if (request.status === "PENDING" || request.status === "APPROVED") throw conflict("审批仍在处理中，不能退回草稿");
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "status" = 'DRAFT', "approval_request_id" = NULL, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

/**
 * 执行器专用：PENDING → SEALED。同批共用一个 effectiveAt（调用方传入同一值），
 * 封存时间取数据库时钟；不接受任何正文改写。
 */
export async function sealLegalDocumentByApproval(client: PoolClient, adminUserId: string, id: string, approvalRequestId: string, effectiveAt: Date | string): Promise<LegalDocumentVersion> {
  const current = await lockLegalDocument(client, id);
  if (current.status !== "PENDING") throw conflict("Legal document is not pending approval");
  if (current.approvalRequestId !== approvalRequestId) throw conflict("Legal document belongs to another approval request");
  const row = (await client.query<LegalDocumentVersion>(
    `UPDATE "zzsh_content"."legal_document_version"
        SET "status" = 'SEALED', "sealed_by_admin_id" = $2, "sealed_at" = clock_timestamp(),
            "effective_at" = $3::timestamptz, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING ${RETURNING_FIELDS}`,
    [id, adminUserId, effectiveAt instanceof Date ? effectiveAt.toISOString() : effectiveAt],
  )).rows[0];
  if (!row) throw notFound();
  return verifyRow(row);
}

export async function readCurrentLegalDocument(client: PoolClient, docType: FixedDocType, at?: string, versionId?: string): Promise<LegalDocumentVersion | null> {
  if (versionId !== undefined && !ID.test(versionId)) throw invalid("Legal document version is invalid", "version");
  const row = (await client.query<LegalDocumentVersion>(
    `SELECT ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v
      WHERE v."doc_type" = $1 AND v."status" = 'SEALED'
        AND v."effective_at" <= COALESCE($2::timestamptz, statement_timestamp())
        AND ($3::text IS NULL OR v."id" = $3)
      ORDER BY v."effective_at" DESC, v."sealed_at" DESC, v."id" DESC LIMIT 1`,
    [docType, at ?? null, versionId ?? null],
  )).rows[0];
  return row ? verifyRow(row) : null;
}

/** 当前生效的提前结算告知；读不到由调用方决定 503，绝不回退到代码常量。 */
export async function readCurrentEarlySettlementDisclosure(client: PoolClient, at?: string): Promise<EarlySettlementDisclosure | null> {
  const row = await readCurrentLegalDocument(client, "EARLY_SETTLEMENT", at);
  return row ? { versionId: row.id, body: row.body, digest: row.digest } : null;
}

export async function readCurrentPlatformDocuments(client: PoolClient, at?: string): Promise<{ terms: LegalDocumentVersion | null; privacy: LegalDocumentVersion | null }> {
  // Rollout guard: code may be deployed before the additive migration is journaled
  // and applied. No table means no sealed platform document yet, not a login outage.
  const relation = (await client.query<{ relation: string | null }>(
    `SELECT to_regclass('zzsh_content.legal_document_version')::text AS relation`,
  )).rows[0]?.relation;
  if (!relation) return { terms: null, privacy: null };
  // 只取两类平台文档：EARLY_SETTLEMENT 不进登录同意，也不对用户端 /legal 暴露。
  const rows = await Promise.all((await client.query<LegalDocumentVersion>(
    `SELECT DISTINCT ON (v."doc_type") ${SELECT_FIELDS} FROM "zzsh_content"."legal_document_version" v
      WHERE v."doc_type" = ANY($1::text[]) AND v."status" = 'SEALED'
        AND v."effective_at" <= COALESCE($2::timestamptz, statement_timestamp())
      ORDER BY v."doc_type", v."effective_at" DESC, v."sealed_at" DESC, v."id" DESC`,
    [[...LEGAL_DOC_TYPES], at ?? null],
  )).rows.map(verifyRow));
  return { terms: rows.find(row => row.docType === "PLATFORM_TERMS") ?? null, privacy: rows.find(row => row.docType === "PLATFORM_PRIVACY") ?? null };
}

export type PlatformLegalAcceptanceCheck =
  | { required: false }
  | { required: true; terms: LegalDocumentVersion; privacy: LegalDocumentVersion; requiredDocTypes: LegalDocType[]; acceptance: PlatformLegalAcceptance };

export type PlatformLegalRequirement = {
  reason: "LEGAL_ACCEPTANCE_REQUIRED";
  requiredDocTypes: LegalDocType[];
  versions: { docType: LegalDocType; versionId: string; digest: string; title: string }[];
};

/** 需要重新同意的份与当前版本：错误 details 与前端勾选框共用同一事实。 */
export function platformLegalRequirement(current: { terms: LegalDocumentVersion; privacy: LegalDocumentVersion }, requiredDocTypes: readonly LegalDocType[]): PlatformLegalRequirement {
  const byType = { PLATFORM_TERMS: current.terms, PLATFORM_PRIVACY: current.privacy } as const;
  return {
    reason: "LEGAL_ACCEPTANCE_REQUIRED",
    requiredDocTypes: [...requiredDocTypes],
    versions: requiredDocTypes.map(docType => ({ docType, versionId: byType[docType].id, digest: byType[docType].digest, title: byType[docType].title })),
  };
}

const ACCEPTANCE_FIELD: Record<LegalDocType, string> = { PLATFORM_TERMS: "legalAcceptance.terms", PLATFORM_PRIVACY: "legalAcceptance.privacy" };
const DOC_TITLE: Record<LegalDocType, string> = { PLATFORM_TERMS: "平台服务协议", PLATFORM_PRIVACY: "隐私政策" };

function acceptanceError(status: 400 | 409, docTypes: readonly LegalDocType[], code: "REQUIRED_FIELD" | "INVALID_FIELD"): SecurityApiError {
  const message = status === 400
    ? `注册或登录前需阅读并同意${docTypes.map(docType => DOC_TITLE[docType]).join("与")}`
    : "平台法律文书已更新，请重新阅读并确认";
  return new SecurityApiError(status, status === 400 ? API_V1_ERROR_CODES.INVALID_ARGUMENT : API_V1_ERROR_CODES.VERSION_CHANGED, message,
    docTypes.map(docType => ({ path: ACCEPTANCE_FIELD[docType], code })));
}

/** 该用户对当前版本已同意的份：只认 versionId + 存储 digest 完全一致的记录。 */
async function acceptedPlatformDocTypes(client: PoolClient, userId: string, current: { terms: LegalDocumentVersion; privacy: LegalDocumentVersion }): Promise<Set<LegalDocType>> {
  const rows = (await client.query<{ docType: LegalDocType }>(
    `SELECT DISTINCT a."document_type" AS "docType" FROM "zzsh_content"."document_acceptance" a
      WHERE a."user_id" = $1 AND a."subject_type" = 'USER' AND a."subject_id" = $1
        AND ((a."document_type" = 'PLATFORM_TERMS' AND a."document_version_id" = $2 AND a."document_digest" = $3)
          OR (a."document_type" = 'PLATFORM_PRIVACY' AND a."document_version_id" = $4 AND a."document_digest" = $5))`,
    [userId, current.terms.id, current.terms.digest, current.privacy.id, current.privacy.digest],
  )).rows;
  return new Set(rows.map(row => row.docType));
}

/**
 * 按份同意（裁定 17）：两份都无当前版本 → 不要求；只有一份 → 503；
 * 注册（userId 为 null）→ 两份都要；登录 → 缺哪份要哪份，已同意当前版本的不重复要求。
 */
export async function verifyPlatformLegalAcceptance(client: PoolClient, value: unknown, userId?: string | null): Promise<PlatformLegalAcceptanceCheck> {
  const current = await readCurrentPlatformDocuments(client);
  if (!current.terms && !current.privacy) return { required: false };
  if (!current.terms || !current.privacy) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "平台法律文书未完整发布");
  const accepted = userId ? await acceptedPlatformDocTypes(client, userId, { terms: current.terms, privacy: current.privacy }) : new Set<LegalDocType>();
  const requiredDocTypes = LEGAL_DOC_TYPES.filter(docType => !accepted.has(docType));
  if (requiredDocTypes.length === 0) return { required: false };
  const acceptance = parsePlatformLegalAcceptance(value);
  if (!acceptance) throw acceptanceError(400, requiredDocTypes, "REQUIRED_FIELD");
  const submitted: { docType: LegalDocType; ref: LegalAcceptanceRef }[] = [];
  if (acceptance.terms) submitted.push({ docType: "PLATFORM_TERMS", ref: acceptance.terms });
  if (acceptance.privacy) submitted.push({ docType: "PLATFORM_PRIVACY", ref: acceptance.privacy });
  const stale = submitted.filter(({ docType, ref }) => {
    const version = docType === "PLATFORM_TERMS" ? current.terms! : current.privacy!;
    return ref.versionId !== version.id || ref.digest !== version.digest;
  }).map(({ docType }) => docType);
  if (stale.length) throw acceptanceError(409, stale, "INVALID_FIELD");
  const missing = requiredDocTypes.filter(docType => !submitted.some(entry => entry.docType === docType));
  if (missing.length) throw acceptanceError(400, missing, "REQUIRED_FIELD");
  return { required: true, terms: current.terms, privacy: current.privacy, requiredDocTypes, acceptance };
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

export async function recordDocumentAcceptance(client: PoolClient, input: DocumentAcceptanceInput, businessProof?: "ORDER_SNAPSHOT" | "SETTLEMENT_AUDIT"): Promise<void> {
  const documentType = parseDocumentType(input.documentType);
  const source = parseAcceptanceSource(input.source);
  if (!ID.test(input.documentVersionId) || !DIGEST.test(input.documentDigest) || !ID.test(input.subjectId) || input.subjectId.length > 128) throw invalid("Document acceptance is invalid");
  if (businessProof) {
    const allowed = input.subjectType === "ORDER" && (businessProof === "ORDER_SNAPSHOT"
      ? source === "ORDER_CREATE" && (documentType === "RENTAL_AGREEMENT" || documentType === "FULL_PAYOUT_TERMS")
      : (source === "SETTLEMENT_SUBMIT" || source === "SETTLEMENT_DECISION") && (documentType === "EARLY_SETTLEMENT_OWNER" || documentType === "EARLY_SETTLEMENT_RENTER"));
    if (!allowed) throw invalid("Document acceptance proof is invalid");
    const observed = (await client.query(`SELECT to_regclass('zzsh_content.document_acceptance')::text AS relation`)).rows[0];
    if (!observed || !Object.hasOwn(observed, "relation") || observed.relation !== null && typeof observed.relation !== "string") throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "接受记录存储状态暂时无法核验");
    // Historical-prefix orders retain immutable snapshot/audit proof; platform sign-in never takes this path.
    if (observed.relation === null) return;
  }
  await client.query(
    `INSERT INTO "zzsh_content"."document_acceptance"
      ("id", "user_id", "document_type", "document_version_id", "document_digest", "subject_type", "subject_id", "source", "request_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("user_id", "document_type", "document_version_id", "document_digest", "subject_type", "subject_id") DO NOTHING`,
    [newSupplyId("accept"), input.userId, documentType, input.documentVersionId, input.documentDigest,
      input.subjectType, input.subjectId, source, input.requestId ?? null],
  );
}

/** 只记录本次提交的文档；重复提交已同意的份由 ON CONFLICT 去重，旧行不改。 */
export async function recordPlatformAcceptances(
  client: PoolClient,
  userId: string,
  acceptance: PlatformLegalAcceptance,
  source: "REGISTRATION" | "LOGIN",
  requestId?: string,
): Promise<void> {
  for (const [docType, ref] of [["PLATFORM_TERMS", acceptance.terms], ["PLATFORM_PRIVACY", acceptance.privacy]] as const) {
    if (!ref) continue;
    await recordDocumentAcceptance(client, {
      userId, documentType: docType, documentVersionId: ref.versionId,
      documentDigest: ref.digest, subjectType: "USER", subjectId: userId, source, requestId,
    });
  }
}

export function sameAcceptanceRef(ref: LegalAcceptanceRef, versionId: string, digest: string): boolean {
  return ref.versionId === versionId && ref.digest === digest;
}
