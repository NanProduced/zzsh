import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import {
  legalDigest,
  parseLegalAcceptanceRef,
  parsePlatformLegalAcceptance,
  recordDocumentAcceptance,
  recordPlatformAcceptances,
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
  const client = fakeClient([(sql) => sql.includes("legal_document_version") ? [] : undefined]);
  const check = await verifyPlatformLegalAcceptance(client, undefined);
  assert.deepEqual(check, { required: false });
  assert.equal(client.calls.length, 2);
});

test("both sealed documents require exact id and digest", async () => {
  const client = fakeClient([(sql, values) => sql.includes("legal_document_version") ? (values[0] === "PLATFORM_TERMS" ? [terms] : [privacy]) : undefined]);
  const acceptance = { terms: { versionId: terms.id, digest: terms.digest }, privacy: { versionId: privacy.id, digest: privacy.digest } };
  const check = await verifyPlatformLegalAcceptance(client, acceptance);
  assert.equal(check.required, true);
  await assert.rejects(() => verifyPlatformLegalAcceptance(client, undefined), /阅读并同意/);
  await assert.rejects(() => verifyPlatformLegalAcceptance(client, { ...acceptance, terms: { ...acceptance.terms, digest: "f".repeat(64) } }), (error: any) => error.status === 409);
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
