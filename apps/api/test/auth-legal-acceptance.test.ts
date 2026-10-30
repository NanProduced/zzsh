import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { parsePlatformLegalAcceptance, recordPlatformAcceptances } from "../src/legal/legal-documents";
import { SecurityApiError } from "../src/auth/security-core";

const filename = resolve(__dirname, "../../src/auth/auth-runtime.ts");
const file = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildPhoneRegistrationPlugin");
assert.ok(declaration, "exercise the real identifier handler, not a duplicate implementation");
const javascript = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const acceptance = { terms: { versionId: "terms_1", digest: "a".repeat(64) }, privacy: { versionId: "privacy_1", digest: "b".repeat(64) } };

async function invoke(status: number, options: { drift?: boolean; storageFailure?: boolean } = {}) {
  const inserts: unknown[][] = [];
  let verifications = 0;
  const client = { query: async (_sql: string, values: unknown[]) => {
    if (options.storageFailure) throw new Error("STORAGE_FAILED");
    inserts.push(values); return { rows: [], rowCount: 1 };
  } };
  const factory = runInNewContext(`${javascript}; buildPhoneRegistrationPlugin`, {
    Headers,
    SecurityApiError,
    bodyOf: (body: unknown) => body,
    passwordFrom: (body: { password: string }) => body.password,
    withTransaction: async (_pool: unknown, execute: (client: unknown) => Promise<unknown>) => execute(client),
    verifyPlatformLegalAcceptance: async () => {
      verifications++;
      if (options.drift && verifications === 2) throw new SecurityApiError(409, "CONFLICT", "DOCUMENT_CHANGED");
      return { required: true };
    },
    parsePlatformLegalAcceptance,
    recordPlatformAcceptances,
  });
  class AuthError extends Error { constructor(readonly status: string, body: { message: string }) { super(body.message); } }
  const plugin = factory((_path: string, _options: unknown, handler: unknown) => handler, AuthError, () => {}, {}, [], false, false, {
    dispatch: async () => Response.json(status === 200 ? { user: { id: "authenticated_user" } } : { error: "INVALID_PASSWORD" }, { status }),
  });
  const run = () => plugin.endpoints.signInIdentifier({ body: { identifier: "+8613800138000", password: "synthetic", legalAcceptance: acceptance }, headers: new Headers() });
  return { inserts, run, count: () => verifications };
}

test("failed password authentication cannot create legal acceptances", async () => {
  const probe = await invoke(401);
  assert.equal((await probe.run()).status, 401);
  assert.equal(probe.inserts.length, 0);
});

test("successful login records the SDK-authenticated user and rechecks versions", async () => {
  const probe = await invoke(200);
  assert.equal((await probe.run()).status, 200);
  assert.equal(probe.count(), 2);
  assert.equal(probe.inserts.length, 2);
  assert.ok(probe.inserts.every(values => values[1] === "authenticated_user"));
});

test("version drift during authentication prevents acceptance and a success response", async () => {
  const probe = await invoke(200, { drift: true });
  await assert.rejects(probe.run, (error: unknown) => error instanceof Error && error.message === "DOCUMENT_CHANGED" && (error as Error & { status: string }).status === "CONFLICT");
  assert.equal(probe.inserts.length, 0);
});

test("acceptance storage failure is not reported as successful login", async () => {
  const probe = await invoke(200, { storageFailure: true });
  await assert.rejects(probe.run, /STORAGE_FAILED/);
});
