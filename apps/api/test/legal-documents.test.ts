import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { plateDigest, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import {
  legalDigest,
  createLegalDraft,
  parseLegalAcceptanceRef,
  parsePlatformLegalAcceptance,
  recordDocumentAcceptance,
  recordPlatformAcceptances,
  readCurrentLegalDocument,
  sealLegalDocumentByApproval,
  submitLegalDocument,
  verifyPlatformLegalAcceptance,
} from "../src/legal/legal-documents";

function doc(docType: "PLATFORM_TERMS" | "PLATFORM_PRIVACY", id: string, body: string) {
  return {
    id, docType, title: id, body, bodyFormat: "text" as const, bodyDocument: null, digest: legalDigest(body), status: "SEALED",
    revision: "2", effectiveAt: "2026-10-30T00:00:00.000Z", sealedAt: "2026-10-30T00:00:00.000Z",
    approvalRequestId: null, createdAt: "2026-10-30T00:00:00.000Z",
  };
}

function fakeClient(handlers: Array<(sql: string, values: unknown[]) => unknown[] | undefined>): PoolClient & { calls: Array<{ sql: string; values: unknown[] }> } {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      for (const handler of handlers) {
        const rows = handler(sql, values);
        if (rows) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient & { calls: Array<{ sql: string; values: unknown[] }> };
}

const terms = doc("PLATFORM_TERMS", "legal_terms_1", "平台服务协议正文");
const privacy = doc("PLATFORM_PRIVACY", "legal_privacy_1", "用户隐私政策正文");

test("version-pinned reading stays scoped to the requested published document", async () => {
  const client = fakeClient([(sql) => sql.includes("legal_document_version") ? [terms] : undefined]);
  assert.equal((await readCurrentLegalDocument(client, "PLATFORM_TERMS", undefined, terms.id))?.id, terms.id);
  assert.deepEqual(client.calls[0]?.values, ["PLATFORM_TERMS", null, terms.id]);
  assert.match(client.calls[0]!.sql, /status.*SEALED/);
  assert.match(client.calls[0]!.sql, /effective_at/);
  await assert.rejects(() => readCurrentLegalDocument(client, "PLATFORM_TERMS", undefined, "bad/version"));
  assert.equal(client.calls.length, 1);
});

test("legal acceptance refs are strict and digest-bound", () => {
  const ref = parseLegalAcceptanceRef({ versionId: terms.id, digest: terms.digest }, "terms");
  assert.deepEqual(ref, { versionId: terms.id, digest: terms.digest });
  for (const value of [null, {}, { versionId: terms.id }, { versionId: terms.id, digest: "x" }, { versionId: terms.id, digest: terms.digest, extra: true }]) {
    assert.throws(() => parseLegalAcceptanceRef(value, "terms"));
  }
  const set = parsePlatformLegalAcceptance({ terms: { versionId: terms.id, digest: terms.digest }, privacy: { versionId: privacy.id, digest: privacy.digest } });
  assert.deepEqual(set?.terms, { versionId: terms.id, digest: terms.digest });
  // 按份同意：只提交变更的那份也合法，空提交与未知字段仍被拒。
  assert.deepEqual(parsePlatformLegalAcceptance({ privacy: { versionId: privacy.id, digest: privacy.digest } }), { privacy: { versionId: privacy.id, digest: privacy.digest } });
  assert.throws(() => parsePlatformLegalAcceptance({}));
  assert.throws(() => parsePlatformLegalAcceptance({ ...set, extra: true }));
});

test("no sealed platform documents keeps the legacy boolean path", async () => {
  const client = fakeClient([(sql) => sql.includes("to_regclass") ? [{ relation: null }] : []]);
  const check = await verifyPlatformLegalAcceptance(client, undefined);
  assert.deepEqual(check, { required: false });
  assert.equal(client.calls.length, 1);
});

test("both sealed documents require exact id and digest", async () => {
  const client = fakeClient([
    (sql) => sql.includes("to_regclass") ? [{ relation: "zzsh_content.legal_document_version" }] : undefined,
    (sql, values) => sql.includes("legal_document_version") ? (Array.isArray(values[0]) ? [terms, privacy] : values[0] === "PLATFORM_TERMS" ? [terms] : [privacy]) : undefined,
  ]);
  const acceptance = { terms: { versionId: terms.id, digest: terms.digest }, privacy: { versionId: privacy.id, digest: privacy.digest } };
  const check = await verifyPlatformLegalAcceptance(client, acceptance);
  assert.equal(check.required, true);
  await assert.rejects(() => verifyPlatformLegalAcceptance(client, undefined), /阅读并同意/);
  await assert.rejects(() => verifyPlatformLegalAcceptance(client, { ...acceptance, terms: { ...acceptance.terms, digest: "f".repeat(64) } }), (error: any) => error.status === 409);
  const reads = client.calls.filter(call => call.sql.includes("DISTINCT ON"));
  assert.equal(reads.length, 3, "each check reads both current versions in one statement");
});

test("legal title and subject limits fail before any database write", async () => {
  const client = fakeClient([]);
  await assert.rejects(() => createLegalDraft(client, "admin_1", { docType: "PLATFORM_TERMS", title: "a".repeat(161), body: "正文" }));
  await assert.rejects(() => createLegalDraft(client, "admin_1", { docType: "PLATFORM_TERMS", title: "测试正文", body: "正文", effectiveAt: "2026-02-31T00:00:00Z" }));
  await assert.rejects(() => recordDocumentAcceptance(client, { userId: "user_1", documentType: "RENTAL_AGREEMENT", documentVersionId: "v1", documentDigest: "a".repeat(64), subjectType: "ORDER", subjectId: "x".repeat(129), source: "ORDER_CREATE" }));
  assert.equal(client.calls.length, 0);
});

test("platform acceptance writes one immutable row per document", async () => {
  const inserted: unknown[][] = [];
  const client = fakeClient([(sql, values) => { if (sql.includes("document_acceptance")) { inserted.push(values); return []; } return undefined; }]);
  await recordPlatformAcceptances(client, "user_1", {
    terms: { versionId: terms.id, digest: terms.digest },
    privacy: { versionId: privacy.id, digest: privacy.digest },
  }, "REGISTRATION", "req_1");
  assert.equal(inserted.length, 2);
  assert.deepEqual(inserted[0]?.slice(1), ["user_1", "PLATFORM_TERMS", terms.id, terms.digest, "USER", "user_1", "REGISTRATION", "req_1"]);
  assert.deepEqual(inserted[1]?.slice(1), ["user_1", "PLATFORM_PRIVACY", privacy.id, privacy.digest, "USER", "user_1", "REGISTRATION", "req_1"]);
});

test("historical business proof does not fabricate ledger rows or authorize platform fallback", async () => {
  const client = fakeClient([(sql) => sql.includes("to_regclass") ? [{ relation: null }] : undefined]);
  const input = { userId: "user_1", documentType: "RENTAL_AGREEMENT" as const, documentVersionId: "agreement_1", documentDigest: "a".repeat(64), subjectType: "ORDER" as const, subjectId: "order_1", source: "ORDER_CREATE" as const };
  await recordDocumentAcceptance(client, input, "ORDER_SNAPSHOT");
  assert.equal(client.calls.filter(call => call.sql.includes("INSERT")).length, 0);
  await assert.rejects(() => recordDocumentAcceptance(client, { ...input, documentType: "PLATFORM_TERMS" }, "ORDER_SNAPSHOT"));
  await assert.rejects(() => recordDocumentAcceptance(fakeClient([]), input, "ORDER_SNAPSHOT"));
});

test("installed ledger write errors remain errors despite existing business proof", async () => {
  const client = fakeClient([
    (sql) => sql.includes("to_regclass") ? [{ relation: "zzsh_content.document_acceptance" }] : undefined,
    (sql) => { if (sql.includes("INSERT")) throw new Error("LEDGER_WRITE_FAILED"); return undefined; },
  ]);
  await assert.rejects(() => recordDocumentAcceptance(client, { userId: "user_1", documentType: "RENTAL_AGREEMENT", documentVersionId: "agreement_1", documentDigest: "a".repeat(64), subjectType: "ORDER", subjectId: "order_1", source: "ORDER_CREATE" }, "ORDER_SNAPSHOT"), /LEDGER_WRITE_FAILED/);
});

test("order/settlement acceptance rejects unknown document types and sources", async () => {
  const client = fakeClient([]);
  await assert.rejects(() => recordDocumentAcceptance(client, {
    userId: "user_1", documentType: "UNKNOWN" as never, documentVersionId: "v1", documentDigest: "a".repeat(64),
    subjectType: "ORDER", subjectId: "order_1", source: "ORDER_CREATE",
  }));
  await assert.rejects(() => recordDocumentAcceptance(client, {
    userId: "user_1", documentType: "RENTAL_AGREEMENT", documentVersionId: "v1", documentDigest: "a".repeat(64),
    subjectType: "ORDER", subjectId: "order_1", source: "UNKNOWN" as never,
  }));
});

test("submitting a draft binds the approval request and sealing only happens through that request", async () => {
  const body = "提前结算告知合成正文";
  const document: PlateDocumentEnvelope = { format: "plate", schemaVersion: 1, preset: "legal", value: [{ type: "p", children: [{ text: body }] }] };
  const draft = {
    id: "legal_early", docType: "EARLY_SETTLEMENT" as const, title: "提前结算告知", body, bodyFormat: "plate" as const,
    bodyDocument: document, digest: await plateDigest(document), status: "DRAFT" as const, revision: "2", effectiveAt: null,
    sealedAt: null, approvalRequestId: null, createdAt: "2026-10-30T00:00:00.000Z",
  };
  let current: typeof draft | { status: string; approvalRequestId: string | null; effectiveAt: string | null; sealedAt: string | null } = draft;
  const client = fakeClient([
    (sql) => sql.includes("FOR UPDATE") && sql.includes("legal_document_version") ? [current] : undefined,
    (sql) => { if (!sql.includes("SET \"status\" = 'PENDING'")) return undefined; current = { ...draft, status: "PENDING", approvalRequestId: "approval_req_1" }; return [current]; },
    (sql) => { if (!sql.includes("SET \"status\" = 'SEALED'")) return undefined; current = { ...draft, status: "SEALED", effectiveAt: "2026-10-30T01:00:00.000Z", sealedAt: "2026-10-30T01:00:00.000Z", approvalRequestId: "approval_req_1" }; return [current]; },
  ]);
  const pending = await submitLegalDocument(client, draft.id, "2", "approval_req_1");
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.approvalRequestId, "approval_req_1");
  const submitCall = client.calls.find(call => call.sql.includes("SET \"status\" = 'PENDING'"));
  assert.deepEqual(submitCall?.values, [draft.id, "approval_req_1"]);
  // 只有绑定本申请的 PENDING 行可被封存；别的申请号一律拒绝。
  await assert.rejects(() => sealLegalDocumentByApproval(client, "admin_1", draft.id, "approval_req_other", new Date()), /another approval request/);
  const sealed = await sealLegalDocumentByApproval(client, "admin_1", draft.id, "approval_req_1", "2026-10-30T01:00:00.000Z");
  assert.equal(sealed.status, "SEALED");
  assert.equal(sealed.effectiveAt, "2026-10-30T01:00:00.000Z");
  // 已封存行不能再提交，也不能再被任何申请封存。
  await assert.rejects(() => submitLegalDocument(client, draft.id, "2", "approval_req_2"), /already submitted or sealed/);
  const draftOnly = fakeClient([(sql) => sql.includes("FOR UPDATE") && sql.includes("legal_document_version") ? [draft] : undefined]);
  await assert.rejects(() => sealLegalDocumentByApproval(draftOnly, "admin_1", draft.id, "approval_req_1", new Date()), /not pending approval/);
  assert.equal(draftOnly.calls.filter(call => call.sql.startsWith("UPDATE")).length, 0);
});
