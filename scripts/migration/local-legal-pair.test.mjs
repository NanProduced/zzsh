import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeLegalPair, prepareLegalPair, verifyLegalPair } from "./local-legal-pair.mjs";

const require = createRequire(import.meta.url);
const legal = require(fileURLToPath(new URL("../../apps/api/dist/src/legal/legal-documents.js", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const texts = { "C:\\fixture\\terms.txt": Buffer.from("合成服务协议\r\n内容"), "C:\\fixture\\privacy.txt": Buffer.from("合成隐私政策\n内容") };
const input = { schema: "zzsh.legal-initial-source.v1", effectiveAt: "2026-01-01T00:00:00.000Z",
  terms: { path: "C:\\fixture\\terms.txt", sha256: hash(texts["C:\\fixture\\terms.txt"]) },
  privacy: { path: "C:\\fixture\\privacy.txt", sha256: hash(texts["C:\\fixture\\privacy.txt"]) } };
const read = path => texts[path];

test("legal initialization binds both approved source bytes and the shared normalization", () => {
  const prepared = prepareLegalPair(input, read, legal);
  assert.equal(prepared.documents.terms.body, "合成服务协议\n内容");
  assert.equal(prepared.documents.terms.digest, legal.legalDigest(prepared.documents.terms.body));
  assert.throws(() => prepareLegalPair({ ...input, privacy: { ...input.privacy, sha256: "a".repeat(64) } }, read, legal), /LEGAL_INITIAL_SOURCE_CHANGED/);
  assert.throws(() => prepareLegalPair({ ...input, terms: undefined }, read, legal), /LEGAL_INITIAL_SOURCE_INVALID/);
  assert.throws(() => prepareLegalPair({ ...input, effectiveAt: "invalid" }, read, legal), /LEGAL_INITIAL_SOURCE_INVALID/);
});

test("legal readiness needs both current sealed versions from the exact approved sources", () => {
  const prepared = prepareLegalPair(input, read, legal);
  const current = Object.fromEntries(["terms", "privacy"].map(key => [key, { id: "synthetic_" + key,
    docType: prepared.documents[key].type, title: prepared.documents[key].title, body: prepared.documents[key].body,
    digest: prepared.documents[key].digest, status: "SEALED", effectiveAt: input.effectiveAt }]));
  const proof = verifyLegalPair(current, prepared);
  assert.equal(proof.terms.id, "synthetic_terms"); assert.equal(JSON.stringify(proof).includes("合成服务协议"), false);
  for (const changed of [{ ...current, privacy: null }, { ...current, terms: { ...current.terms, digest: "a".repeat(64) } },
    { ...current, privacy: { ...current.privacy, status: "DRAFT" } }, { ...current, terms: { ...current.terms, effectiveAt: "2026-01-02T00:00:00.000Z" } }]) {
    assert.throws(() => verifyLegalPair(changed, prepared), /LEGAL_INITIAL_PAIR_NOT_CURRENT/);
  }
});

test("legal initialization commits both documents together or neither in isolated PostgreSQL", { skip: !process.env.ZZSH_SYNTH_IDENTITY_PORT }, async () => {
  const { Pool } = require("pg"), { recordAudit } = require(fileURLToPath(new URL("../../apps/api/dist/src/auth/security-core.js", import.meta.url)));
  const port = process.env.ZZSH_SYNTH_IDENTITY_PORT, expectedSystem = process.env.ZZSH_SYNTH_IDENTITY_SYSTEM;
  assert.match(port ?? "", /^[1-9][0-9]{3,4}$/); assert.match(expectedSystem ?? "", /^[0-9]+$/);
  const pool = new Pool({ host: "127.0.0.1", port: Number(port), database: "zzsh_synth_legal", user: "postgres", max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const client = await pool.connect();
  try {
    const identity = (await client.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker`)).rows[0];
    assert.deepEqual(identity, { database: "zzsh_synth_legal", system: expectedSystem, marker: "zzsh:synthetic:legal-pair-v1" });
    assert.equal((await client.query("SELECT to_regnamespace('zzsh_content') IS NULL AS fresh")).rows[0]?.fresh, true);
    await client.query(`CREATE ROLE zzsh_synth_legal_m NOLOGIN; CREATE SCHEMA zzsh_content AUTHORIZATION zzsh_synth_legal_m;
      CREATE SCHEMA zzsh_iam AUTHORIZATION zzsh_synth_legal_m; CREATE SCHEMA zzsh_auth_user AUTHORIZATION zzsh_synth_legal_m;
      CREATE SCHEMA zzsh_auth_admin AUTHORIZATION zzsh_synth_legal_m`);
    await client.query("SET ROLE zzsh_synth_legal_m");
    await client.query(`CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY);
      CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY);
      CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,object_id text,outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb)`);
    await client.query(readFileSync(fileURLToPath(new URL("../../apps/api/migrations/business/0112_legal_documents.sql", import.meta.url)), "utf8"));
    await client.query(`INSERT INTO zzsh_auth_admin."user" VALUES('synthetic_admin')`);
    const actor = { id: "synthetic_admin", sessionId: "synthetic_session", requestId: "synthetic_legal_request" };
    const prepared = prepareLegalPair(input, read, legal);
    await client.query("BEGIN");
    let auditCount = 0;
    await assert.rejects(initializeLegalPair(client, actor, prepared, legal, async (...args) => {
      if (++auditCount === 2) throw new Error("synthetic audit failure"); return recordAudit(...args);
    }), /synthetic audit failure/);
    await client.query("ROLLBACK");
    assert.equal(Number((await client.query("SELECT count(*) FROM zzsh_content.legal_document_version")).rows[0].count), 0);
    assert.equal(Number((await client.query("SELECT count(*) FROM zzsh_iam.audit_event")).rows[0].count), 0);
    await client.query("BEGIN");
    const draft = await legal.createLegalDraft(client, actor.id, { docType: "PLATFORM_TERMS", title: prepared.documents.terms.title, body: prepared.documents.terms.body, effectiveAt: input.effectiveAt });
    await legal.sealLegalDocument(client, actor.id, draft.id, draft.revision);
    await assert.rejects(initializeLegalPair(client, actor, prepared, legal, recordAudit), /LEGAL_INITIAL_PAIR_NOT_CURRENT/);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    const result = await initializeLegalPair(client, actor, prepared, legal, recordAudit);
    assert.equal(result.status, "INITIALIZED"); await client.query("COMMIT");
    assert.equal(Number((await client.query("SELECT count(*) FROM zzsh_content.legal_document_version WHERE status='SEALED'")).rows[0].count), 2);
    const audit = (await client.query("SELECT actor_type,actor_id,session_id,details FROM zzsh_iam.audit_event ORDER BY object_id")).rows;
    assert.equal(audit.length, 2); assert.ok(audit.every(row => row.actor_type === "admin" && row.actor_id === actor.id && row.session_id === actor.sessionId));
    assert.equal(JSON.stringify(audit).includes("合成服务协议"), false);
    await client.query("BEGIN"); assert.equal((await initializeLegalPair(client, actor, prepared, legal, recordAudit)).status, "EXACT_PRESENT"); await client.query("ROLLBACK");
    assert.equal(Number((await client.query("SELECT count(*) FROM zzsh_iam.audit_event")).rows[0].count), 2);
  } finally { await client.query("ROLLBACK").catch(() => {}); await client.query("RESET ROLE").catch(() => {}); client.release(); await pool.end(); }
});
