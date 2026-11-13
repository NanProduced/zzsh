import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { recordAudit } from "../auth/security-core";
import { invalid } from "../supply/supply-util";
import { newEarlySettlementDisclosure, readLegalDocumentById, type FixedDocType } from "./legal-documents";

/**
 * 首部署法律文书初始化（P3a）。由 Master 的首部署脚本在 bootstrapDefaultContent
 * 首次启用平台协议与隐私共用一个生效时点。固定费初始化可先单独种入提前结算告知，
 * 稍后再通过完整内容初始化补齐平台文书。原已封存版本保持原内容与摘要。
 */

const nodeRequire = createRequire(__filename);
const DEFAULTS_DIR = path.join(path.dirname(nodeRequire.resolve("@zzsh/content")), "defaults");

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const strip = (value: string): string => value.replace(/\s+/g, "");

type LegalSeed = { key: string; docType: FixedDocType; versionId: string; file: string };

const LEGAL_SEEDS: readonly LegalSeed[] = [
  { key: "platform-terms", docType: "PLATFORM_TERMS", versionId: "platform-terms-v1", file: "legal/terms.json" },
  { key: "platform-privacy", docType: "PLATFORM_PRIVACY", versionId: "platform-privacy-v1", file: "legal/privacy.json" },
  { key: "early-settlement-v1", docType: "EARLY_SETTLEMENT", versionId: "early-settlement-fees-plate-v1", file: "legal/early-settlement-v1.json" },
];

type ManifestItem = { key: string; kind: string; file: string; digest: string };
type VerifiedSeed = { seed: LegalSeed; title: string; body: string; digest: string; document: PlateDocumentEnvelope };

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
    if (seed.docType === "EARLY_SETTLEMENT" && (body !== early.body || entry.sourceSha256 !== early.digest)) {
      problems.push({ key: seed.key, reason: "DIGEST_MISMATCH", detail: "early-settlement constant" });
      continue;
    }
    const title = entry.meta?.title ?? (seed.docType === "PLATFORM_TERMS" ? "洲洲商行平台服务协议"
      : seed.docType === "PLATFORM_PRIVACY" ? "洲洲商行用户隐私政策" : "提前结算告知");
    verified.push({ seed, title, body, digest: item.digest, document });
  }
  return { problems, verified, manifestDigest };
}

export type LegalBootstrapResult = { status: "CREATED" | "ALREADY_INITIALIZED"; created: number; effectiveAt: string | null; manifestDigest: string };

export async function bootstrapLegalDocuments(client: PoolClient, input: { actorAdminId: string; requestId: string; earlySettlementOnly?: boolean }): Promise<LegalBootstrapResult> {
  const actorAdminId = input.actorAdminId;
  if (typeof actorAdminId !== "string" || !actorAdminId) throw invalid("A real first BOSS admin id is required");
  const { problems, verified, manifestDigest } = await verifySeeds();
  if (problems.length) {
    throw invalid(`法律文书初始化失败：${problems.map(problem => `${problem.key}(${problem.reason}${problem.detail ? `:${problem.detail}` : ""})`).join("、")}`);
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('confirmed-content-bootstrap', 0))");
  const legacy = newEarlySettlementDisclosure();
  const effectiveAt = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
  const missing: VerifiedSeed[] = [];
  for (const entry of verified) {
    const { seed } = entry;
    const early = seed.docType === "EARLY_SETTLEMENT";
    if (input.earlySettlementOnly && !early) continue;
    const ids = early ? [seed.versionId, legacy.versionId] : [seed.versionId];
    const idsInUse = (await client.query<{ id: string }>(
      `SELECT id FROM zzsh_content.legal_document_version WHERE doc_type=$1 ORDER BY id`, [seed.docType],
    )).rows;
    if (idsInUse.length === 0) { missing.push(entry); continue; }
    if (idsInUse.length !== 1 || !ids.includes(idsInUse[0]!.id))
      throw invalid(`法律文书初始化失败：${seed.key} 已存在非初始化版本`);
    const row = await readLegalDocumentById(client, idsInUse[0]!.id);
    const historical = row?.id === legacy.versionId;
    if (!row || row.status !== "SEALED" || !row.effectiveAt || Date.parse(row.effectiveAt) > effectiveAt.getTime()
      || row.digest !== (historical ? legacy.digest : entry.digest) || row.bodyFormat !== (historical ? "text" : "plate")) {
      throw invalid(`法律文书初始化失败：${seed.key} 原版本不可核验`);
    }
  }
  const platformMissing = missing.filter(entry => entry.seed.docType !== "EARLY_SETTLEMENT").length;
  if (platformMissing === 1) throw invalid("法律文书初始化失败：现有平台协议与隐私政策未成对");
  if (missing.length === 0) return { status: "ALREADY_INITIALIZED", created: 0, effectiveAt: null, manifestDigest };

  for (const entry of missing) {
    await client.query(
      `INSERT INTO "zzsh_content"."legal_document_version"
        ("id", "doc_type", "title", "body", "body_format", "body_document", "digest", "status",
         "effective_at", "created_by_admin_id", "sealed_by_admin_id", "sealed_at", "system_initial_sha256")
       VALUES ($1, $2, $3, $4, 'plate', $5::jsonb, $6, 'SEALED', $7::timestamptz, $8, $8, $7::timestamptz, $9)`,
      [entry.seed.versionId, entry.seed.docType, entry.title, entry.body,
        JSON.stringify(entry.document), entry.digest, effectiveAt, actorAdminId, manifestDigest],
    );
  }
  await recordAudit(client, {
    actorType: "system", action: "CONTENT_BOOTSTRAPPED",
    objectType: "legal_bootstrap", objectId: manifestDigest, outcome: "SUCCESS", requestId: input.requestId,
    reason: "first-deploy legal documents",
    details: {
      manifestDigest, compatibilityBossRef: actorAdminId, created: missing.length, effectiveAt: effectiveAt.toISOString(),
      items: missing.map(entry => ({ key: entry.seed.key, docType: entry.seed.docType, versionId: entry.seed.versionId, digest: entry.digest, bodyFormat: "plate" })),
    },
  });
  return { status: "CREATED", created: missing.length, effectiveAt: effectiveAt.toISOString(), manifestDigest };
}