import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { recordAudit } from "../auth/security-core";
import { invalid } from "../supply/supply-util";
import { legalDigest, newEarlySettlementDisclosure, readLegalDocumentById, type FixedDocType } from "./legal-documents";

/**
 * 首部署法律文书初始化（P3a）。由 Master 的首部署脚本在 bootstrapDefaultContent
 * 之后、同一事务内调用：平台协议与隐私首次生效必须同一 effective_at，提前结算告知
 * v1 原文纯文本入库。不写任何审批申请或决定，也不改写任何已封存行。
 *
 * 全有或全无：逐条比对确认清单摘要、publish 校验、法律逐字核对与提前结算金标准，
 * 任一不符整体失败且不写任何行；目标全部存在且摘要一致则幂等成功。
 */

const nodeRequire = createRequire(__filename);
const DEFAULTS_DIR = path.join(path.dirname(nodeRequire.resolve("@zzsh/content")), "defaults");

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const strip = (value: string): string => value.replace(/\s+/g, "");

type LegalSeed = { key: string; docType: FixedDocType; versionId: string; file: string; format: "plate" | "text" };

const LEGAL_SEEDS: readonly LegalSeed[] = [
  { key: "platform-terms", docType: "PLATFORM_TERMS", versionId: "platform-terms-v1", file: "legal/terms.json", format: "plate" },
  { key: "platform-privacy", docType: "PLATFORM_PRIVACY", versionId: "platform-privacy-v1", file: "legal/privacy.json", format: "plate" },
  { key: "early-settlement-v1", docType: "EARLY_SETTLEMENT", versionId: "early-settlement-fees-v1", file: "legal/early-settlement-v1.txt", format: "text" },
];

type ManifestItem = { key: string; kind: string; file: string; digest: string };
type VerifiedSeed = { seed: LegalSeed; title: string; body: string; digest: string; document: PlateDocumentEnvelope | null };

export type LegalBootstrapProblem = { key: string; reason: "MISSING" | "DIGEST_MISMATCH" | "INVALID"; detail?: string };

async function verifySeeds(): Promise<{ problems: LegalBootstrapProblem[]; verified: VerifiedSeed[]; manifestDigest: string }> {
  const problems: LegalBootstrapProblem[] = [];
  const verified: VerifiedSeed[] = [];
  const manifestBytes = readFileSync(path.join(DEFAULTS_DIR, "manifest.confirmed.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { items: ManifestItem[] };
  const manifestDigest = sha256(manifestBytes);
  const early = newEarlySettlementDisclosure();
  for (const seed of LEGAL_SEEDS) {
    const item = manifest.items.find(entry => entry.key === seed.key);
    const absolute = path.join(DEFAULTS_DIR, seed.file);
    if (!item || !existsSync(absolute)) { problems.push({ key: seed.key, reason: "MISSING", detail: seed.file }); continue; }
    if (item.file !== seed.file) { problems.push({ key: seed.key, reason: "INVALID", detail: "manifest file" }); continue; }
    const bytes = readFileSync(absolute);
    if (seed.format === "text") {
      const body = bytes.toString("utf8");
      const digest = sha256(bytes);
      // 金标准：入库摘要必须等于改造前常量的 sha256，也等于确认清单摘要。
      if (digest !== item.digest) { problems.push({ key: seed.key, reason: "DIGEST_MISMATCH", detail: "manifest" }); continue; }
      if (digest !== early.digest || body !== early.body) { problems.push({ key: seed.key, reason: "DIGEST_MISMATCH", detail: "early-settlement constant" }); continue; }
      verified.push({ seed, title: "提前结算告知", body, digest, document: null });
      continue;
    }
    let entry: { document?: PlateDocumentEnvelope; source?: string; sourceSha256?: string; meta?: { title?: string } };
    try { entry = JSON.parse(bytes.toString("utf8")); }
    catch { problems.push({ key: seed.key, reason: "INVALID", detail: "json parse" }); continue; }
    const document = entry.document;
    if (!document) { problems.push({ key: seed.key, reason: "INVALID", detail: "document" }); continue; }
    if (await plateDigest(document) !== item.digest) { problems.push({ key: seed.key, reason: "DIGEST_MISMATCH", detail: "plateDigest" }); continue; }
    const checked = validatePlateDocument(document, { preset: "legal", mode: "publish" });
    if (!checked.ok) { problems.push({ key: seed.key, reason: "INVALID", detail: checked.errors.slice(0, 3).map(issue => `${issue.path} ${issue.code}`).join(";") }); continue; }
    if (typeof entry.source !== "string" || typeof entry.sourceSha256 !== "string") { problems.push({ key: seed.key, reason: "INVALID", detail: "source binding" }); continue; }
    const sourceBytes = readFileSync(path.join(DEFAULTS_DIR, entry.source));
    if (sha256(sourceBytes) !== entry.sourceSha256) { problems.push({ key: seed.key, reason: "DIGEST_MISMATCH", detail: "sourceSha256" }); continue; }
    const body = extractPlate(document).plainText;
    if (strip(body) !== strip(sourceBytes.toString("utf8"))) { problems.push({ key: seed.key, reason: "INVALID", detail: "legal verbatim mismatch" }); continue; }
    const title = seed.docType === "PLATFORM_TERMS" ? "洲洲商行平台服务协议" : "洲洲商行用户隐私政策";
    verified.push({ seed, title: entry.meta?.title ?? title, body, digest: item.digest, document });
  }
  return { problems, verified, manifestDigest };
}

export type LegalBootstrapResult = { status: "CREATED" | "ALREADY_INITIALIZED"; created: number; effectiveAt: string | null; manifestDigest: string };

export async function bootstrapLegalDocuments(client: PoolClient, input: { actorAdminId: string; requestId: string }): Promise<LegalBootstrapResult> {
  const actorAdminId = input.actorAdminId;
  if (typeof actorAdminId !== "string" || !actorAdminId) throw invalid("A real first BOSS admin id is required");
  const { problems, verified, manifestDigest } = await verifySeeds();
  if (problems.length) {
    throw invalid(`法律文书初始化失败：${problems.map(problem => `${problem.key}(${problem.reason}${problem.detail ? `:${problem.detail}` : ""})`).join("、")}`);
  }

  const existing = new Map<string, { digest: string; status: string }>();
  for (const seed of LEGAL_SEEDS) {
    const row = await readLegalDocumentById(client, seed.versionId);
    if (row) existing.set(seed.key, { digest: row.digest, status: row.status });
    // 任何已存在的运营版本（不是初始化种子）都让整体失败，绝不覆盖或改写。
    const others = (await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_content"."legal_document_version" WHERE "doc_type" = $1 AND "id" <> $2`,
      [seed.docType, seed.versionId],
    )).rows[0];
    if (Number(others?.count ?? 0) > 0) {
      throw invalid(`法律文书初始化失败：${seed.key} 已存在非初始化版本，不覆盖运营内容`);
    }
  }
  if (existing.size > 0) {
    const allMatch = LEGAL_SEEDS.every(seed => {
      const row = existing.get(seed.key);
      const expected = verified.find(entry => entry.seed.key === seed.key);
      return row && expected && row.digest === expected.digest && row.status === "SEALED";
    });
    if (existing.size === LEGAL_SEEDS.length && allMatch) {
      return { status: "ALREADY_INITIALIZED", created: 0, effectiveAt: null, manifestDigest };
    }
    const status = LEGAL_SEEDS.map(seed => `${seed.key}:${existing.has(seed.key) ? "present" : "absent"}`);
    throw invalid(`法律文书初始化失败：目标非空且不一致（${status.join("、")}）`);
  }

  // 首次生效：两份平台文书与提前结算告知共用同一 effective_at，同一事务写入。
  const effectiveAt = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
  for (const entry of verified) {
    await client.query(
      `INSERT INTO "zzsh_content"."legal_document_version"
        ("id", "doc_type", "title", "body", "body_format", "body_document", "digest", "status",
         "effective_at", "created_by_admin_id", "sealed_by_admin_id", "sealed_at", "system_initial_sha256")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'SEALED', $8::timestamptz, $9, $9, $8::timestamptz, $10)`,
      [entry.seed.versionId, entry.seed.docType, entry.title, entry.body, entry.seed.format,
        entry.document ? JSON.stringify(entry.document) : null, entry.digest, effectiveAt, actorAdminId, manifestDigest],
    );
  }
  await recordAudit(client, {
    actorType: "system", action: "CONTENT_BOOTSTRAPPED",
    objectType: "legal_bootstrap", objectId: manifestDigest, outcome: "SUCCESS", requestId: input.requestId,
    reason: "first-deploy legal documents",
    details: {
      manifestDigest, compatibilityBossRef: actorAdminId, created: verified.length, effectiveAt: effectiveAt.toISOString(),
      items: verified.map(entry => ({ key: entry.seed.key, docType: entry.seed.docType, versionId: entry.seed.versionId, digest: entry.digest, bodyFormat: entry.seed.format })),
      earlySettlementDigest: legalDigest(newEarlySettlementDisclosure().body),
    },
  });
  return { status: "CREATED", created: verified.length, effectiveAt: effectiveAt.toISOString(), manifestDigest };
}