import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { API_V1_ERROR_CODES } from "../src/contracts/api-v1";
import {
  legalDigest,
  newEarlySettlementDisclosure,
  readEarlySettlementDisclosure,
  readCurrentEarlySettlementDisclosure,
  recordPlatformAcceptances,
  returnLegalDocumentToDraft,
  sealLegalDocumentByApproval,
  submitLegalDocument,
  verifyPlatformLegalAcceptance,
  type LegalDocumentVersion,
} from "../src/legal/legal-documents";
import {
  FIXED_DOCUMENT_PUBLISH_OPERATION,
  FIXED_DOC_EFFECTIVE,
  blockChangeCounts,
  diffDocumentBlocks,
  executeFixedDocumentPublish,
  parseFixedDocumentPublishPayload,
  submitFixedDocumentPublish,
} from "../src/legal/fixed-document-publish";
import { fixedDocumentView, loadFixedDocumentFacts } from "../src/legal/fixed-document-projection";
import { approvalRegistration, membershipBusinessPermission, membershipDecisionRequiresBoss, approvalDecisionRequiresTotp, membershipOperationRequiresGameScope, APPROVAL_EXECUTION_MODE, type ApprovalRequestFacts } from "../src/auth/approval-business";

const MIGRATIONS = resolve(__dirname, "../../migrations/business");
const DEFAULTS = resolve(__dirname, "../../../../packages/content/defaults");

const plate = (text: string): PlateDocumentEnvelope => ({ format: "plate", schemaVersion: 1, preset: "legal", value: [{ type: "p", children: [{ text }] }] });

async function plateRow(docType: string, id: string, text: string, overrides: Partial<LegalDocumentVersion> = {}): Promise<LegalDocumentVersion> {
  const document = plate(text);
  return {
    id, docType: docType as LegalDocumentVersion["docType"], title: `${docType} 标题`, body: extractPlate(document).plainText,
    bodyFormat: "plate", bodyDocument: document, digest: await plateDigest(document), status: "DRAFT", revision: "1",
    effectiveAt: null, sealedAt: null, approvalRequestId: null, createdAt: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}

function textRow(docType: string, id: string, body: string, overrides: Partial<LegalDocumentVersion> = {}): LegalDocumentVersion {
  return {
    id, docType: docType as LegalDocumentVersion["docType"], title: `${docType} 标题`, body, bodyFormat: "text", bodyDocument: null,
    digest: legalDigest(body), status: "DRAFT", revision: "1", effectiveAt: null, sealedAt: null, approvalRequestId: null,
    createdAt: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}

type Call = { sql: string; values: unknown[] };

/** 离线内存替身：只模拟本任务用到的语句，写入全部留痕供断言。 */
function store(initial: LegalDocumentVersion[], options: { acceptances?: { docType: string; versionId: string; digest: string }[]; requestStatus?: string; failOn?: RegExp } = {}) {
  const rows = initial.map(row => ({ ...row }));
  const calls: Call[] = [];
  const acceptances = options.acceptances ?? [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (options.failOn?.test(sql)) throw new Error("SYNTHETIC_STORAGE_FAILURE");
    if (sql.includes("to_regclass")) return { rows: [{ relation: "zzsh_content.legal_document_version" }], rowCount: 1 };
    if (sql.includes("clock_timestamp() AS at")) return { rows: [{ at: new Date("2026-11-12T00:00:00.000Z") }], rowCount: 1 };
    if (sql.includes("approval_template")) return { rows: [{ id: "approval_tpl_fixed_document", version: 1 }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_iam"."approval_request"')) return { rows: [{ status: options.requestStatus ?? "REJECTED" }], rowCount: 1 };
    if (sql.includes("document_acceptance") && sql.trimStart().startsWith("SELECT")) {
      return { rows: acceptances.filter(row => row.versionId === values[1] || row.versionId === values[3]).map(row => ({ docType: row.docType })), rowCount: 0 };
    }
    if (sql.includes("DISTINCT ON")) {
      const latest = new Map<string, LegalDocumentVersion>();
      for (const row of rows.filter(entry => entry.status === "SEALED" && entry.docType !== "EARLY_SETTLEMENT")) {
        const previous = latest.get(row.docType);
        if (!previous || String(row.effectiveAt) > String(previous.effectiveAt)) latest.set(row.docType, row);
      }
      return { rows: [...latest.values()], rowCount: 0 };
    }
    if (sql.includes("legal_document_version") && sql.startsWith("UPDATE")) {
      const row = rows.find(entry => entry.id === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      if (sql.includes("'PENDING'")) { row.status = "PENDING"; row.approvalRequestId = String(values[1]); }
      else if (sql.includes("'SEALED'")) { row.status = "SEALED"; row.effectiveAt = String(values[2]); row.sealedAt = "2026-11-12T00:00:00.000Z"; }
      else if (sql.includes("'DRAFT'")) { row.status = "DRAFT"; row.approvalRequestId = null; }
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("legal_document_version") && sql.includes('WHERE v."id" = $1')) {
      const found = rows.filter(row => row.id === values[0]);
      return { rows: found, rowCount: found.length };
    }
    if (sql.includes("legal_document_version") && sql.includes('"doc_type" = $1')) {
      const found = rows.filter(row => row.docType === values[0] && row.status === "SEALED");
      return { rows: found, rowCount: found.length };
    }
    if (sql.includes("legal_document_version") && sql.includes("ANY($1::text[])")) {
      const ids = values[0] as string[];
      return { rows: rows.filter(row => ids.includes(row.id)), rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { client: { query } as unknown as PoolClient, calls, rows };
}

const facts = (payload: Record<string, unknown>, overrides: Partial<ApprovalRequestFacts> = {}): ApprovalRequestFacts => ({
  id: "approval_req_1", operationCode: FIXED_DOCUMENT_PUBLISH_OPERATION, payloadVersion: 1,
  operationPayload: payload, operationPayloadHash: "a".repeat(64), summary: "固定文书发布", requestedBy: "admin_ops",
  status: "PENDING", decidedBy: null, expiresAt: "infinity", ...overrides,
});

const viewer = (permissions: string[], isBoss = false) => ({
  userId: "admin_ops",
  access: { status: "ACTIVE" as const, isBoss, passwordChangeRequired: false, permissions: new Set(permissions) },
  gameScope: { mode: "ALL_GAMES" as const, gameIds: [] },
});

test("0206 repairs both 0112 gaps, keeps every stored row and is journaled", () => {
  const migration = readFileSync(resolve(MIGRATIONS, "0206_legal_fixed_documents.sql"), "utf8");
  const original = readFileSync(resolve(MIGRATIONS, "0112_legal_documents.sql"), "utf8");
  // 0112 字节不动：仍是不含 PENDING 的原始约束与触发器。
  assert.equal(original.includes("PENDING"), false);
  assert.match(original, /CHECK \("status" IN \('DRAFT', 'SEALED'\)\)/);
  assert.match(original, /ELSIF NEW\."status" NOT IN \('DRAFT', 'SEALED'\)/);
  // 新列与新类型只追加。
  for (const column of ['"body_format"', '"body_document"', '"approval_request_id"']) assert.match(migration, new RegExp(`ADD COLUMN ${column}`));
  assert.match(migration, /'PLATFORM_TERMS', 'PLATFORM_PRIVACY', 'EARLY_SETTLEMENT'/);
  assert.match(migration, /CHECK \("status" IN \('DRAFT', 'PENDING', 'SEALED'\)\)/);
  // CHECK 重写：PENDING 是合法形态，SEALED 仍要求封存三列。
  assert.match(migration, /"status" = 'PENDING' AND "approval_request_id" IS NOT NULL/);
  assert.match(migration, /"status" = 'SEALED' AND "sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL AND "effective_at" IS NOT NULL/);
  assert.match(migration, /"body_format" = 'plate' AND "body_document" IS NOT NULL AND "doc_type" <> 'EARLY_SETTLEMENT'/);
  // 触发器状态机：DRAFT→PENDING→SEALED 与 PENDING→DRAFT 退回，其余拒绝。
  const trigger = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"), migration.indexOf("--> statement-breakpoint\n-- 固定文书发布审批"));
  assert.match(trigger, /IF OLD\."status" = 'DRAFT' THEN/);
  assert.match(trigger, /IF NEW\."status" = 'PENDING' AND NEW\."approval_request_id" IS NOT NULL THEN RETURN NEW/);
  assert.match(trigger, /IF OLD\."status" = 'PENDING' THEN/);
  assert.match(trigger, /IF NEW\."status" = 'SEALED' THEN/);
  assert.match(trigger, /IF NEW\."status" = 'DRAFT' THEN/);
  assert.match(trigger, /pending legal document content is frozen/);
  assert.match(trigger, /RAISE EXCEPTION 'legal document status transition is invalid'/);
  // SEALED 逐列比较必须含三个新列（以及 updated_at），否则新列不受保护。
  const sealedBranch = trigger.slice(trigger.indexOf('IF OLD."status" = \'SEALED\''), trigger.indexOf('IF OLD."status" = \'DRAFT\''));
  for (const column of ["body_format", "body_document", "approval_request_id", "updated_at", "digest", "effective_at"]) {
    assert.ok(sealedBranch.includes(`NEW."${column}"`) && sealedBranch.includes(`OLD."${column}"`), `SEALED comparison must cover ${column}`);
  }
  assert.match(trigger, /IF TG_OP = 'DELETE' THEN/);
  // 只追加：迁移不改写、不删除任何已封存行。
  assert.equal(/UPDATE\s+"zzsh_content"\."legal_document_version"\s+SET/.test(migration), false);
  assert.equal(/DELETE FROM/.test(migration), false);
  // 审批类型、权限与模板登记。
  assert.match(migration, /'content\.fixed\.submit'/);
  assert.match(migration, /'content\.fixed\.publish'/);
  assert.match(migration, /'content\.fixed_document\.publish'/);
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const entry = journal.entries.find(item => item.tag === "0206_legal_fixed_documents");
  assert.ok(entry, "0206 must be journaled");
  assert.equal(journal.entries[entry.idx]?.tag, entry.tag);
  assert.equal(journal.entries[entry.idx - 1]?.tag, "0205_docs_discussions");
});

test("approval registration wires ops submit/approve without boss-only, dynamic code or game scope", () => {
  const registration = approvalRegistration(FIXED_DOCUMENT_PUBLISH_OPERATION);
  assert.ok(registration);
  assert.equal(registration.businessType, "content");
  assert.equal(registration.title, "固定文书发布");
  assert.equal(registration.executionMode, APPROVAL_EXECUTION_MODE.genericTransaction);
  assert.equal(registration.testOnly, false);
  assert.equal(membershipBusinessPermission(FIXED_DOCUMENT_PUBLISH_OPERATION, "REQUEST"), "content.fixed.submit");
  assert.equal(membershipBusinessPermission(FIXED_DOCUMENT_PUBLISH_OPERATION, "DECIDE"), "content.fixed.publish");
  assert.equal(membershipBusinessPermission(FIXED_DOCUMENT_PUBLISH_OPERATION, "EXECUTE"), "content.fixed.publish");
  assert.equal(membershipDecisionRequiresBoss(FIXED_DOCUMENT_PUBLISH_OPERATION), false);
  assert.equal(approvalDecisionRequiresTotp(FIXED_DOCUMENT_PUBLISH_OPERATION), false);
  assert.equal(membershipOperationRequiresGameScope(FIXED_DOCUMENT_PUBLISH_OPERATION), false);
});

test("state machine counter-examples: no direct seal, no foreign request, no return while pending", async () => {
  const sealed = await plateRow("PLATFORM_TERMS", "legal_sealed", "已封存正文", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const pending = await plateRow("PLATFORM_PRIVACY", "legal_pending", "待审批正文", { status: "PENDING", approvalRequestId: "approval_req_1" });
  const draft = await plateRow("PLATFORM_TERMS", "legal_draft", "草稿正文");
  const { client, calls } = store([sealed, pending, draft]);

  await assert.rejects(() => submitLegalDocument(client, sealed.id, "1", "approval_req_2"), /already submitted or sealed/);
  await assert.rejects(() => submitLegalDocument(client, pending.id, "1", "approval_req_2"), /already submitted or sealed/);
  await assert.rejects(() => submitLegalDocument(client, draft.id, "9", "approval_req_2"), /changed/);
  await assert.rejects(() => sealLegalDocumentByApproval(client, "admin_1", draft.id, "approval_req_1", new Date()), /not pending approval/);
  await assert.rejects(() => sealLegalDocumentByApproval(client, "admin_1", pending.id, "approval_req_other", new Date()), /another approval request/);
  assert.equal(calls.filter(call => call.sql.startsWith("UPDATE")).length, 0, "反例不得产生任何写入");

  // PENDING 插入：DRAFT → PENDING 绑定真实申请号。
  const submitted = await submitLegalDocument(client, draft.id, "1", "approval_req_1");
  assert.equal(submitted.status, "PENDING");
  const insert = calls.find(call => call.sql.includes("SET \"status\" = 'PENDING'"));
  assert.deepEqual(insert?.values, [draft.id, "approval_req_1"]);

  // 退回只在申请已关闭时允许，且清空审批引用。
  const pendingStore = store([submitted], { requestStatus: "PENDING" });
  await assert.rejects(() => returnLegalDocumentToDraft(pendingStore.client, submitted.id), /审批仍在处理中/);
  const closedStore = store([submitted], { requestStatus: "REJECTED" });
  const returned = await returnLegalDocumentToDraft(closedStore.client, submitted.id);
  assert.equal(returned.status, "DRAFT");
  assert.equal(returned.approvalRequestId, null);
  assert.ok(closedStore.calls.some(call => call.sql.includes("SET \"status\" = 'DRAFT'") && call.sql.includes('"approval_request_id" = NULL')));
});

test("first effect requires both platform documents in one submission and one effective_at", async () => {
  const terms = await plateRow("PLATFORM_TERMS", "legal_terms", "协议第一版");
  const privacy = await plateRow("PLATFORM_PRIVACY", "legal_privacy", "隐私第一版");
  const single = store([terms, privacy]);
  await assert.rejects(
    () => submitFixedDocumentPublish(single.client, { id: "admin_ops", sessionId: "s" }, {
      payload: { items: [{ kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: terms.id, digest: terms.digest, baseVersionId: null }] },
      reason: "首次发布平台协议",
    }, "req_1"),
    (error: any) => error.status === 409 && /隐私政策/.test(error.message),
  );
  assert.equal(single.calls.filter(call => call.sql.includes("INSERT INTO \"zzsh_iam\".\"approval_request\"")).length, 0);

  const both = store([terms, privacy]);
  const submission = await submitFixedDocumentPublish(both.client, { id: "admin_ops", sessionId: "s" }, {
    payload: { items: [
      { kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: terms.id, digest: terms.digest, baseVersionId: null },
      { kind: "PLATFORM_PRIVACY", key: "PLATFORM_PRIVACY", draftVersionId: privacy.id, digest: privacy.digest, baseVersionId: null },
    ] },
    reason: "首次发布两份平台文书",
  }, "req_1");
  assert.match(submission.approvalRequestId, /^approval_req_/);
  const requests = both.calls.filter(call => call.sql.includes("INSERT INTO \"zzsh_iam\".\"approval_request\""));
  assert.equal(requests.length, 1, "一次提交只建一个真实审批申请");
  assert.equal(requests[0]?.values[3], FIXED_DOCUMENT_PUBLISH_OPERATION);
  assert.match(requests[0]!.sql, /'PENDING', 'infinity'::timestamptz/);
  assert.equal(both.calls.filter(call => call.sql.includes("SET \"status\" = 'PENDING'")).length, 2);
  assert.equal(both.calls.filter(call => call.sql.includes("approval_execution")).length, 0, "提交不得伪造执行回执");
  assert.equal(both.calls.filter(call => call.sql.includes("approval_decision")).length, 0, "提交不得伪造决定");

  // 批准执行：同批两份共用同一 effective_at，回执 resultCode 非空。
  const executing = store([
    { ...terms, status: "PENDING", approvalRequestId: submission.approvalRequestId },
    { ...privacy, status: "PENDING", approvalRequestId: submission.approvalRequestId },
  ]);
  const executed = await executeFixedDocumentPublish(executing.client, {
    requestId: submission.approvalRequestId, operationCode: FIXED_DOCUMENT_PUBLISH_OPERATION, payloadVersion: 1,
    operationPayload: { items: [
      { kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: terms.id, digest: terms.digest, baseVersionId: null },
      { kind: "PLATFORM_PRIVACY", key: "PLATFORM_PRIVACY", draftVersionId: privacy.id, digest: privacy.digest, baseVersionId: null },
    ] },
    operationPayloadHash: submission.payloadHash, requestedBy: "admin_ops", decidedBy: "admin_ops", expiresAt: "infinity",
  }, { userId: "admin_ops", sessionId: "s" }, "req_2");
  assert.equal(executed.resultCode, FIXED_DOC_EFFECTIVE);
  assert.ok(executed.resultDetail);
  const seals = executing.calls.filter(call => call.sql.includes("SET \"status\" = 'SEALED'"));
  assert.equal(seals.length, 2);
  assert.equal(seals[0]?.values[2], seals[1]?.values[2], "同批同一 effective_at");
  assert.ok(executing.calls.some(call => call.sql.includes("audit_event") && call.values.includes(FIXED_DOC_EFFECTIVE)));
});

test("executor re-checks digest and base version, and any failure rolls the whole batch back", async () => {
  const terms = await plateRow("PLATFORM_TERMS", "legal_terms", "协议第二版", { status: "PENDING", approvalRequestId: "approval_req_1" });
  const live = await plateRow("PLATFORM_TERMS", "legal_terms_v1", "协议第一版", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const privacy = await plateRow("PLATFORM_PRIVACY", "legal_privacy", "隐私第一版", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const payload = { items: [{ kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: terms.id, digest: terms.digest, baseVersionId: live.id }] };
  const input = { requestId: "approval_req_1", operationCode: FIXED_DOCUMENT_PUBLISH_OPERATION, payloadVersion: 1, operationPayload: payload, operationPayloadHash: "b".repeat(64), requestedBy: "admin_ops", decidedBy: "admin_boss", expiresAt: "infinity" };

  // 线上版本已被别人换掉：409，且不写任何行。
  const moved = store([terms, { ...live, id: "legal_terms_v2" }, privacy]);
  await assert.rejects(() => executeFixedDocumentPublish(moved.client, input, { userId: "admin_boss", sessionId: "s" }, "req"), (error: any) => error.status === 409);
  assert.equal(moved.calls.filter(call => call.sql.startsWith("UPDATE")).length, 0);

  // 摘要被改：409。
  const tampered = store([terms, live, privacy]);
  await assert.rejects(() => executeFixedDocumentPublish(tampered.client, { ...input, operationPayload: { items: [{ ...payload.items[0]!, digest: "f".repeat(64) }] } }, { userId: "admin_boss", sessionId: "s" }, "req"), (error: any) => error.status === 409);

  // 执行中途存储失败：整笔抛错（决定事务由审批中心回滚），不留下部分封存。
  const failing = store([terms, live, privacy], { failOn: /SET "status" = 'SEALED'/ });
  await assert.rejects(() => executeFixedDocumentPublish(failing.client, input, { userId: "admin_boss", sessionId: "s" }, "req"), /SYNTHETIC_STORAGE_FAILURE/);
  assert.equal(failing.rows.find(row => row.id === terms.id)?.status, "PENDING");
});

test("single-document update only asks for the changed document; registration always asks for both", async () => {
  const termsV1 = await plateRow("PLATFORM_TERMS", "terms_v1", "协议第一版", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const privacyV1 = await plateRow("PLATFORM_PRIVACY", "privacy_v1", "隐私第一版", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const privacyV2 = await plateRow("PLATFORM_PRIVACY", "privacy_v2", "隐私第二版", { status: "SEALED", effectiveAt: "2026-11-05T00:00:00.000Z", sealedAt: "2026-11-05T00:00:00.000Z" });
  const ref = (row: LegalDocumentVersion) => ({ versionId: row.id, digest: row.digest });

  // 两份都无当前版本 → 不要求；只有一份 → 503（保留现行为）。
  const empty = store([]);
  assert.deepEqual(await verifyPlatformLegalAcceptance(empty.client, undefined, "user_1"), { required: false });
  const partial = store([termsV1]);
  await assert.rejects(() => verifyPlatformLegalAcceptance(partial.client, undefined, "user_1"), (error: any) => error.status === 503);

  // 注册（userId=null）→ 两份都要；只交一份被拒。
  const registration = store([termsV1, privacyV1]);
  const both = { terms: ref(termsV1), privacy: ref(privacyV1) };
  await assert.rejects(() => verifyPlatformLegalAcceptance(registration.client, { terms: ref(termsV1) }, null), (error: any) => error.status === 400 && error.code === API_V1_ERROR_CODES.INVALID_ARGUMENT);
  const registered = await verifyPlatformLegalAcceptance(registration.client, both, null);
  assert.equal(registered.required, true);
  assert.deepEqual(registered.required && registered.requiredDocTypes, ["PLATFORM_TERMS", "PLATFORM_PRIVACY"]);

  // 登录：已同意旧协议 + 旧隐私，只有隐私更新 → 只要隐私。
  const login = store([termsV1, privacyV2], { acceptances: [
    { docType: "PLATFORM_TERMS", versionId: termsV1.id, digest: termsV1.digest },
    { docType: "PLATFORM_PRIVACY", versionId: privacyV1.id, digest: privacyV1.digest },
  ] });
  const missing = await verifyPlatformLegalAcceptance(login.client, undefined, "user_1").catch((error: any) => error);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.details, [{ path: "legalAcceptance.privacy", code: "REQUIRED_FIELD" }]);
  const onlyPrivacy = await verifyPlatformLegalAcceptance(login.client, { privacy: ref(privacyV2) }, "user_1");
  assert.equal(onlyPrivacy.required, true);
  assert.deepEqual(onlyPrivacy.required && onlyPrivacy.requiredDocTypes, ["PLATFORM_PRIVACY"]);
  // 提交已过期版本 → 409 VERSION_CHANGED。
  await assert.rejects(() => verifyPlatformLegalAcceptance(login.client, { privacy: ref(privacyV1) }, "user_1"), (error: any) => error.status === 409 && error.code === API_V1_ERROR_CODES.VERSION_CHANGED);
  // 两份都已同意当前版本 → 不再要求。
  const settled = store([termsV1, privacyV2], { acceptances: [
    { docType: "PLATFORM_TERMS", versionId: termsV1.id, digest: termsV1.digest },
    { docType: "PLATFORM_PRIVACY", versionId: privacyV2.id, digest: privacyV2.digest },
  ] });
  assert.deepEqual(await verifyPlatformLegalAcceptance(settled.client, undefined, "user_1"), { required: false });

  // 只记录本次提交的那份，旧行不改。
  const ledger = store([termsV1, privacyV2]);
  await recordPlatformAcceptances(ledger.client, "user_1", { privacy: ref(privacyV2) }, "LOGIN", "req_1");
  const inserts = ledger.calls.filter(call => call.sql.includes("INSERT INTO \"zzsh_content\".\"document_acceptance\""));
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0]?.values.slice(1), ["user_1", "PLATFORM_PRIVACY", privacyV2.id, privacyV2.digest, "USER", "user_1", "LOGIN", "req_1"]);
  assert.ok(inserts[0]?.sql.includes("ON CONFLICT"), "重复提交由 ON CONFLICT 去重");
});

test("early settlement v1 keeps the golden digest and the unchanged snapshot verification", async () => {
  const bytes = readFileSync(resolve(DEFAULTS, "legal/early-settlement-v1.txt"));
  const golden = newEarlySettlementDisclosure();
  assert.equal(golden.versionId, "early-settlement-fees-v1");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), golden.digest);
  assert.equal(bytes.toString("utf8"), golden.body);
  const manifest = JSON.parse(readFileSync(resolve(DEFAULTS, "manifest.confirmed.json"), "utf8")) as { items: { key: string; digest: string }[] };
  const entry = JSON.parse(readFileSync(resolve(DEFAULTS, "legal/early-settlement-v1.json"), "utf8"));
  assert.equal(entry.sourceSha256, golden.digest);
  assert.equal(manifest.items.find(item => item.key === "early-settlement-v1")?.digest, await plateDigest(entry.document));
  // 快照校验逻辑不变：只比 sha256(存储原文)。
  const quote = { agreementAcceptanceSchema: 1, earlySettlementDisclosure: golden };
  assert.deepEqual(readEarlySettlementDisclosure(quote), golden);
  assert.throws(() => readEarlySettlementDisclosure({ ...quote, earlySettlementDisclosure: { ...golden, body: "changed" } }), (error: any) => error.status === 503);
  assert.equal(readEarlySettlementDisclosure({ agreementAcceptanceSchema: 0 }), null);
  // 库内当前版本只读存储值；EARLY_SETTLEMENT 不进平台同意，也不进 /legal 公开路由。
  const early = textRow("EARLY_SETTLEMENT", golden.versionId, golden.body, { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const db = store([early]);
  assert.deepEqual(await readCurrentEarlySettlementDisclosure(db.client), golden);
  const terms = await plateRow("PLATFORM_TERMS", "terms_v1", "协议", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const withEarly = store([early, terms]);
  await assert.rejects(() => verifyPlatformLegalAcceptance(withEarly.client, undefined, null), (error: any) => error.status === 503);
});

test("payload contract and block diff stay strict and readable", () => {
  const item = { kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: "legal_1", digest: "a".repeat(64), baseVersionId: null };
  assert.deepEqual(parseFixedDocumentPublishPayload({ items: [item] }).items, [item]);
  for (const payload of [
    null, {}, { items: [] }, { items: [item], extra: true },
    { items: [{ ...item, kind: "RENTAL_AGREEMENT" }] },
    { items: [{ ...item, key: "placement:PUBLISH_NOTICE" }] },
    { items: [{ ...item, kind: "NOTICE", key: "guide:help" }] },
    { items: [{ ...item, digest: "xyz" }] },
    { items: [{ ...item, baseVersionId: 3 }] },
    { items: [item, item] },
    { items: [{ ...item, extra: true }] },
  ]) assert.throws(() => parseFixedDocumentPublishPayload(payload));
  assert.deepEqual(parseFixedDocumentPublishPayload({ items: [{ ...item, kind: "NOTICE", key: "placement:PUBLISH_NOTICE" }] }).items[0]?.kind, "NOTICE");

  const blocks = diffDocumentBlocks("第一块\n第二块\n第三块", "第一块\n第二块改\n第三块\n第四块");
  assert.deepEqual(blocks.map(block => block.status), ["UNCHANGED", "CHANGED", "UNCHANGED", "ADDED"]);
  assert.deepEqual(blockChangeCounts(blocks), { added: 1, removed: 0, changed: 1, unchanged: 2 });
  assert.deepEqual(diffDocumentBlocks("只有旧块", "").map(block => block.status), ["REMOVED"]);
  assert.deepEqual(diffDocumentBlocks("", "").length, 0);
  assert.deepEqual(diffDocumentBlocks("同一段", "同一段").map(block => block.status), ["UNCHANGED"]);
});

test("approval detail projects the user preview and the live diff, and stays permission gated", async () => {
  const terms = await plateRow("PLATFORM_TERMS", "legal_terms_v2", "协议第二版", { status: "PENDING", approvalRequestId: "approval_req_1" });
  const live = await plateRow("PLATFORM_TERMS", "legal_terms_v1", "协议第一版", { status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const db = store([terms, live]);
  const row = facts({ items: [{ kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: terms.id, digest: terms.digest, baseVersionId: live.id }] });
  const loaded = await loadFixedDocumentFacts(db.client, [row]);
  const view = await fixedDocumentView(row, viewer(["content.fixed.submit"]), loaded, undefined);
  assert.equal(view.summaryAvailable, true);
  const fixed = (view.summary as any).fixedDocument;
  assert.equal(fixed.items.length, 1);
  assert.equal(fixed.items[0].preview.document.preset, "legal");
  assert.equal(fixed.items[0].base.versionId, live.id);
  assert.deepEqual(fixed.items[0].blocks.map((block: any) => block.status), ["CHANGED"]);
  assert.equal(view.resultAvailability, "NOT_APPLICABLE");

  const executed = await fixedDocumentView({ ...row, status: "EXECUTED" }, viewer(["content.fixed.publish"]), loaded, { status: "SUCCEEDED", resultCode: FIXED_DOC_EFFECTIVE, resultDetail: "2026-11-12T00:00:00.000Z" });
  assert.equal(executed.resultAvailability, "UNRESOLVED", "回执成功但草稿未封存时不声称已生效");

  const sealedStore = store([{ ...terms, status: "SEALED", effectiveAt: "2026-11-12T00:00:00.000Z", sealedAt: "2026-11-12T00:00:00.000Z" }, live]);
  const sealedFacts = await loadFixedDocumentFacts(sealedStore.client, [row]);
  const known = await fixedDocumentView({ ...row, status: "EXECUTED" }, viewer(["content.fixed.publish"]), sealedFacts, { status: "SUCCEEDED", resultCode: FIXED_DOC_EFFECTIVE, resultDetail: "2026-11-12T00:00:00.000Z" });
  assert.equal(known.resultAvailability, "KNOWN");

  const denied = await fixedDocumentView(row, viewer(["approval.request.read"]), loaded, undefined);
  assert.equal(denied.summaryAvailable, false);
  assert.deepEqual(denied.restrictedReasonCodes, ["BUSINESS_PERMISSION_REQUIRED"]);
});
