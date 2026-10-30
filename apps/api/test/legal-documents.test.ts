import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import {
  legalDigest,
  createLegalDraft,
  parseLegalAcceptanceRef,
  parsePlatformLegalAcceptance,
  recordDocumentAcceptance,
  recordPlatformAcceptances,
  readCurrentLegalDocument,
  sealLegalDocument,
  verifyPlatformLegalAcceptance,
} from "../src/legal/legal-documents";

function doc(docType: "PLATFORM_TERMS" | "PLATFORM_PRIVACY", id: string, body: string) {
  return {
    id, docType, title: id, body, digest: legalDigest(body), status: "SEALED",
    revision: "2", effectiveAt: "2026-10-30T00:00:00.000Z", sealedAt: "2026-10-30T00:00:00.000Z",
    createdAt: "2026-10-30T00:00:00.000Z",
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
  assert.throws(() => parsePlatformLegalAcceptance({ terms: { versionId: terms.id, digest: terms.digest } }));
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

test("sealing a draft records the server time and rejects a stale revision", async () => {
  const client = fakeClient([
    (sql) => sql.includes("FOR UPDATE") && sql.includes("legal_document_version") ? [{ ...terms, status: "DRAFT", effectiveAt: null, sealedAt: null }] : undefined,
    (sql) => sql.includes("SET \"status\" = 'SEALED'") ? [{ ...terms, effectiveAt: "2026-10-30T01:00:00.000Z", sealedAt: "2026-10-30T01:00:00.000Z" }] : undefined,
  ]);
  const sealed = await sealLegalDocument(client, "admin_1", terms.id, "2");
  assert.equal(sealed.status, "SEALED");
  assert.equal(sealed.effectiveAt, "2026-10-30T01:00:00.000Z");
  await assert.rejects(() => sealLegalDocument(client, "admin_1", terms.id, "1"), /changed/);
});
