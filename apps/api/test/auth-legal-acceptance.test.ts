import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

import { legalDigest, parsePlatformLegalAcceptance, recordPlatformAcceptances, verifyPlatformLegalAcceptance } from "../src/legal/legal-documents";
import { SecurityApiError, withTransaction } from "../src/auth/security-core";
import { API_V1_ERROR_CODES } from "../src/contracts/api-v1";

const filename = resolve(__dirname, "../../src/auth/auth-runtime.ts");
const file = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildPhoneRegistrationPlugin");
assert.ok(declaration, "exercise the real identifier handler, not a duplicate implementation");
const javascript = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const phoneFile = ts.createSourceFile("phone.ts", readFileSync(resolve(__dirname, "../../src/auth/user-auth-session.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const phoneDeclaration = phoneFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildTransactionalPhoneSignIn");
assert.ok(phoneDeclaration);
const phoneJavascript = ts.transpileModule(phoneDeclaration.getText(phoneFile).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const docs = ["PLATFORM_TERMS", "PLATFORM_PRIVACY"].map((docType, i) => ({ id: `legal_${i}`, docType, title: "synthetic", body: `synthetic-${i}`, digest: legalDigest(`synthetic-${i}`), status: "SEALED", revision: "1" }));
const acceptance = { terms: { versionId: docs[0]!.id, digest: docs[0]!.digest }, privacy: { versionId: docs[1]!.id, digest: docs[1]!.digest } };

async function invoke(status: number, options: { drift?: boolean; storageFailure?: boolean; count?: number; raw?: boolean; omitAcceptance?: boolean; stale?: boolean } = {}) {
  const inserts: unknown[][] = [];
  let verifications = 0, pending: unknown[][] | null = null, pendingSessions = 0, sessions = 0, cookies = 0, commits = 0;
  const client = { release() {}, query: async (sql: string, values: unknown[]) => {
    if (sql === "BEGIN") { pending = []; pendingSessions = 0; return { rows: [] }; }
    if (sql === "COMMIT") { assert(pending); inserts.push(...pending); sessions += pendingSessions; pending = null; commits++; return { rows: [] }; }
    if (sql === "ROLLBACK") { pending = null; pendingSessions = 0; return { rows: [] }; }
    if (sql.includes("to_regclass")) return { rows: [{ relation: "zzsh_content.legal_document_version" }] };
    if (sql.includes("DISTINCT ON")) {
      verifications++;
      return { rows: docs.slice(0, options.count ?? 2).map((row, i) => options.drift && verifications === 2 && i === 0 ? { ...row, id: "new_terms" } : row) };
    }
    if (sql.includes('SELECT id FROM zzsh_auth_user."user"')) return { rows: [{ id: "authenticated_user" }] };
    if (sql.includes('INSERT INTO "zzsh_content"."document_acceptance"')) {
      assert(pending); if (options.storageFailure && pending.length === 1) throw new Error("STORAGE_FAILED");
      pending.push(values); return { rows: [], rowCount: 1 };
    }
    throw new Error("Unexpected auth query: " + sql);
  } };
  const pool = { connect: async () => client };
  const globals = {
    Headers, Response, z, SecurityApiError, withTransaction,
    normalizeMainlandPhone: (value: unknown) => value === "+8613800138000" ? value : null,
    hasLegacyPhoneConflict: async () => false,
    verifyUserCredentialInTransaction: async () => status === 200 ? "retry" : "none",
    createTransactionalUserSession: async (_client: unknown, _ctx: unknown, id: string) => { assert(pending); pendingSessions++; return { user: { id }, session: { id: "synthetic_session" } }; },
    parsePlatformLegalAcceptance, verifyPlatformLegalAcceptance, recordPlatformAcceptances,
  };
  const factory = runInNewContext(`${javascript}; buildPhoneRegistrationPlugin`, globals);
  const phoneFactory = runInNewContext(`${phoneJavascript}; buildTransactionalPhoneSignIn`, globals);
  class AuthError extends Error { constructor(readonly status: string, body: { message: string }) { super(body.message); } }
  const endpoint = (_path: string, config: { body?: { parse(value: unknown): unknown } }, handler: (ctx: any) => unknown) => (ctx: any) => {
    if (config.body) ctx.body = config.body.parse(ctx.body);
    return handler(ctx);
  };
  const cookie = () => { assert.equal(pending, null); assert.ok(commits > 0); cookies++; };
  const raw = phoneFactory(pool, endpoint, AuthError, cookie);
  const context = { json: (body: unknown) => Response.json(body), headers: new Headers(), context: { password: {} } };
  const plugin = factory(endpoint, AuthError, cookie, pool, [], false, false, {
    dispatch: async (_identifier: string, password: string, _headers: Headers, _kind: unknown, legalAcceptance: unknown) => {
      return raw({ ...context, body: { phoneNumber: "+8613800138000", password, ...(legalAcceptance === undefined ? {} : { legalAcceptance }) } });
    },
  });
  const refs = options.stale ? { ...acceptance, terms: { ...acceptance.terms, digest: "f".repeat(64) } } : acceptance;
  const run = () => (options.raw ? raw : plugin.endpoints.signInIdentifier)({ ...context, body: {
    ...(options.raw ? { phoneNumber: "+8613800138000" } : { identifier: "+8613800138000" }), password: "synthetic",
    ...(options.omitAcceptance ? {} : { legalAcceptance: refs }),
  } });
  return { inserts, run, count: () => verifications, state: () => ({ sessions, cookies, commits }) };
}

test("failed password authentication cannot create legal acceptances", async () => {
  const probe = await invoke(401);
  await assert.rejects(probe.run, (error: any) => error.status === "UNAUTHORIZED");
  assert.equal(probe.inserts.length, 0);
  assert.deepEqual(probe.state(), { sessions: 0, cookies: 0, commits: 0 });
});

test("successful login records the SDK-authenticated user and rechecks versions", async () => {
  const probe = await invoke(200);
  assert.equal((await probe.run()).status, 200);
  assert.equal(probe.count(), 2);
  assert.equal(probe.inserts.length, 2);
  assert.ok(probe.inserts.every(values => values[1] === "authenticated_user"));
  assert.deepEqual(probe.state(), { sessions: 1, cookies: 1, commits: 1 });
});

test("version drift during authentication prevents acceptance and a success response", async () => {
  const probe = await invoke(200, { drift: true });
  await assert.rejects(probe.run, (error: any) => error.status === "CONFLICT");
  assert.equal(probe.inserts.length, 0);
  assert.equal(probe.state().sessions, 0); assert.equal(probe.state().cookies, 0);
});

test("acceptance storage failure is not reported as successful login", async () => {
  const probe = await invoke(200, { storageFailure: true });
  await assert.rejects(probe.run, /STORAGE_FAILED/);
  assert.equal(probe.inserts.length, 0); assert.equal(probe.state().sessions, 0); assert.equal(probe.state().cookies, 0);
});

for (const raw of [false, true]) {
  test(`${raw ? "direct phone" : "identifier"} login preserves zero-document compatibility and closes incomplete/stale acceptance`, async () => {
    const legacy = await invoke(200, { raw, count: 0, omitAcceptance: true }); assert.equal((await legacy.run()).status, 200); assert.equal(legacy.inserts.length, 0);
    for (const options of [{ count: 1 }, { omitAcceptance: true }, { stale: true }]) {
      const f = await invoke(200, { ...options, raw }); await assert.rejects(f.run); assert.deepEqual(f.state(), { sessions: 0, cookies: 0, commits: 0 });
    }
    const valid = await invoke(200, { raw }); assert.equal((await valid.run()).status, 200); assert.equal(valid.inserts.length, 2); assert.equal(valid.state().sessions, 1);
    const failure = await invoke(200, { raw, storageFailure: true }); await assert.rejects(failure.run, /STORAGE_FAILED/); assert.deepEqual(failure.state(), { sessions: 0, cookies: 0, commits: 0 });
  });
}

const boundaryNames = ["safeWebAuthHandler", "copyWebResponseHeaders", "authErrorCode", "safeWebError"];
const boundaryDeclarations = file.statements.filter(node => ts.isFunctionDeclaration(node) && boundaryNames.includes(node.name?.text ?? ""));
assert.equal(boundaryDeclarations.length, boundaryNames.length);
const boundaryJavascript = ts.transpileModule(boundaryDeclarations.map(node => node.getText(file)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
async function errorBoundary(status: number, payload: unknown, path = "/api/auth/user/sign-in/phone-number", method = "POST") {
  const handler = runInNewContext(`${boundaryJavascript}; safeWebAuthHandler`, { Headers, Response, URL, API_V1_ERROR_CODES, randomUUID: () => "boundary-test" });
  const response = await handler(async () => Response.json(payload, { status }), new Request(`http://localhost${path}`, { method, headers: { "x-request-id": "req_boundary" } }));
  return { response, payload: await response.json() as { error: { code: string; message: string; reason?: string; requestId: string } } };
}

test("verified frozen phone sign-in keeps only its controlled public reason", async () => {
  for (const path of ["/api/auth/user/sign-in/phone-number", "/api/auth/user/sign-in/identifier"]) {
    const result = await errorBoundary(403, { code: "ACCOUNT_FROZEN", message: "PRIVATE_UPSTREAM_MESSAGE" }, path);
    assert.equal(result.payload.error.code, "FORBIDDEN");
    assert.equal(result.payload.error.reason, "ACCOUNT_FROZEN");
    assert.equal(result.payload.error.message, "账号已被冻结，如有疑问请联系客服");
    assert.equal(result.payload.error.requestId, "req_boundary");
    assert.equal(JSON.stringify(result.payload).includes("PRIVATE_UPSTREAM_MESSAGE"), false);
  }
});

test("unverified and foreign auth errors cannot disclose a frozen account", async () => {
  for (const [status, path, method] of [
    [401, "/api/auth/user/sign-in/phone-number", "POST"],
    [500, "/api/auth/user/sign-in/phone-number", "POST"],
    [403, "/api/auth/admin/sign-in/username", "POST"],
    [403, "/api/auth/user/sign-in/phone-number", "GET"],
  ] as const) {
    const result = await errorBoundary(status, { code: "ACCOUNT_FROZEN", message: "PRIVATE" }, path, method);
    assert.equal(result.payload.error.reason, undefined);
    assert.equal(JSON.stringify(result.payload).includes("PRIVATE"), false);
  }
});

test("unknown SDK auth errors retain the generic boundary", async () => {
  const result = await errorBoundary(403, { code: "OTHER_PRIVATE_CODE", message: "PRIVATE_PROVIDER_MESSAGE" });
  assert.equal(result.payload.error.reason, undefined);
  assert.equal(result.payload.error.message, "Authentication request rejected");
});
