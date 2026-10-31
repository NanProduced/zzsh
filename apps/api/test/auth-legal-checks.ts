import assert from "node:assert/strict";
import type { Pool } from "pg";
import { assertBusinessMigrationPrefix } from "../src/database/business-migrations";
import { withTransaction } from "../src/auth/security-core";
import { createLegalDraft, sealLegalDocument } from "../src/legal/legal-documents";

type Result = { status: number; body: any; authenticated: boolean; cookieIssued: boolean; userId?: string };
export async function runAuthLegalChecks(o: {
  migration: Pool; runtime: Pool; adminId: string; password: string;
  api(path: string, body: Record<string, unknown>): Promise<Result>;
  otp(phone: string): string;
}) {
  const probe = await o.migration.connect();
  try {
    await probe.query("BEGIN");
    await probe.query("UPDATE zzsh_business_meta.migrations SET hash=$1 WHERE id=(SELECT min(id) FROM zzsh_business_meta.migrations)", ["0".repeat(64)]);
    await assert.rejects(assertBusinessMigrationPrefix(probe), (e: any) => e.reason === "NOT_EXACT_PREFIX" && e.index === 0);
  } finally {
    try { await probe.query("ROLLBACK"); } catch (error) { probe.release(true); throw error; }
    probe.release();
  }
  await assertBusinessMigrationPrefix(o.migration);

  const phone = "+8613900876501";
  assert.equal((await o.api("/phone-registration/send-otp", { phoneNumber: phone })).status, 200);
  const registered = await o.api("/phone-registration/complete", { phoneNumber: phone, code: o.otp(phone), password: o.password, acceptedTerms: true });
  assert.equal(registered.status, 200); assert.ok(registered.userId);
  const userId = registered.userId;
  const counts = async () => (await o.runtime.query(`SELECT
    (SELECT count(*)::int FROM zzsh_auth_user.session WHERE "userId"=$1) AS sessions,
    (SELECT count(*)::int FROM zzsh_content.document_acceptance WHERE user_id=$1) AS accepts`, [userId])).rows[0];
  const initial = await counts(); assert.deepEqual(initial, { sessions: 1, accepts: 0 });
  const publish = (docType: string) => withTransaction(o.migration, async client => {
    const draft = await createLegalDraft(client, o.adminId, { docType, title: "Synthetic regression document", body: "Synthetic regression fixture only." });
    return sealLegalDocument(client, o.adminId, draft.id, draft.revision);
  });
  const terms = await publish("PLATFORM_TERMS");
  for (const path of ["/sign-in/phone-number", "/sign-in/identifier"]) {
    const result = await o.api(path, { ...(path.endsWith("identifier") ? { identifier: phone } : { phoneNumber: phone }), password: o.password });
    assert.equal(result.status, 503); assert.equal(result.authenticated, false); assert.equal(result.cookieIssued, false); assert.deepEqual(await counts(), initial);
  }
  const privacy = await publish("PLATFORM_PRIVACY");
  const legalAcceptance = { terms: { versionId: terms.id, digest: terms.digest }, privacy: { versionId: privacy.id, digest: privacy.digest } };
  for (const path of ["/sign-in/phone-number", "/sign-in/identifier"]) {
    const body = { ...(path.endsWith("identifier") ? { identifier: phone } : { phoneNumber: phone }), password: o.password };
    for (const [input, status] of [
      [body, 400], [{ ...body, password: "wrong-password", legalAcceptance }, 401],
      [{ ...body, legalAcceptance: { ...legalAcceptance, terms: { ...legalAcceptance.terms, digest: "f".repeat(64) } } }, 409],
    ] as Array<[Record<string, unknown>, number]>) {
      const denied = await o.api(path, input); assert.equal(denied.status, status); assert.equal(denied.authenticated, false); assert.equal(denied.cookieIssued, false); assert.deepEqual(await counts(), initial);
    }
  }

  await o.migration.query(`CREATE FUNCTION zzsh_content.auth_legal_failure_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.document_type='PLATFORM_PRIVACY' THEN RAISE EXCEPTION 'synthetic legal ledger failure'; END IF; RETURN NEW; END $$`);
  try {
    await o.migration.query("CREATE TRIGGER auth_legal_failure_probe BEFORE INSERT ON zzsh_content.document_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_content.auth_legal_failure_probe()");
    for (const path of ["/sign-in/phone-number", "/sign-in/identifier"]) {
      const failure = await o.api(path, { ...(path.endsWith("identifier") ? { identifier: phone } : { phoneNumber: phone }), password: o.password, legalAcceptance });
      assert.equal(failure.status, 500); assert.equal(failure.authenticated, false); assert.equal(failure.cookieIssued, false); assert.deepEqual(await counts(), initial);
    }
  } finally {
    await o.migration.query("DROP TRIGGER IF EXISTS auth_legal_failure_probe ON zzsh_content.document_acceptance");
    await o.migration.query("DROP FUNCTION zzsh_content.auth_legal_failure_probe()");
  }
  for (const [i, path] of ["/sign-in/phone-number", "/sign-in/identifier"].entries()) {
    const success = await o.api(path, { ...(path.endsWith("identifier") ? { identifier: phone } : { phoneNumber: phone }), password: o.password, legalAcceptance });
    assert.equal(success.status, 200); assert.equal(success.authenticated, true); assert.equal(success.cookieIssued, true);
    assert.deepEqual(await counts(), { sessions: 2 + i, accepts: 2 });
  }
  console.log("AUTH_LEGAL_PG_CHECKS exact-prefix/read-only-mutation-rejection raw+identifier/incomplete/missing/stale/wrong-password second-insert-rollback no-cookie stable-acceptance");
}
