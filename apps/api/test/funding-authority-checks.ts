import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import { lockPublishingAccount } from "../src/supply/publishing";
import { reviewMediaAsset } from "../src/supply/media";
import { fingerprintRequest } from "../src/supply/supply-util";

type Jar = { header: () => string; update: (response: Response) => void };
type Staff = { id: string; jar: Jar };
type Post = (path: string, body: Record<string, unknown> | undefined, jar: Jar, origin?: string, headers?: Record<string, string>, method?: string) => Promise<{ response: Response; body: Record<string, any> | null }>;
const ADMIN = "http://127.0.0.1:3101", USER = "http://127.0.0.1:3100";

export async function runFundingAuthorityChecks(t: TestContext, o: {
  pool: Pool; ownerPool: Pool; base: string; owner: Jar; verifier: Staff; secondVerifier: Staff; boss: Staff; gameId: string; post: Post;
  uploadEvidence: (accountId: string) => Promise<{ assetId: string; bytes: Buffer }>;
  createFormalRelease: (mode?: "NOT_REQUIRED" | "SATISFIED") => Promise<void>;
  evidenceReadProbe: { run?: () => Promise<void> };
}) {
  const key = () => ({ "idempotency-key": `c2_${randomUUID()}` });
  const path = (id: string) => `/api/bff/admin/supply/accounts/${id}/guarantee-proof`;
  const context = async (id: string) => {
    const result = await o.post(path(id), undefined, o.boss.jar, ADMIN);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body!;
  };
  const create = async () => {
    const r = await o.post("/api/v1/supply/accounts", { gameId: o.gameId }, o.owner, USER);
    assert.equal(r.response.status, 200, JSON.stringify(r.body));
    return r.body!.accountId as string;
  };
  const body = (c: Record<string, any>, status: string, assetId?: string) => {
    const evidence = status === "SATISFIED" ? c.evidenceOptions.find((e: any) => e.assetId === assetId) : status === "NOT_REQUIRED" ? c.policyEvidence : c.revocationEvidence;
    assert.ok(evidence);
    return { expectedProofVersion: c.context.proofVersion, expectedPolicyVersion: c.context.policyVersion,
      expectedPriceVersionId: c.context.priceVersionId, expectedReleaseId: c.context.releaseId, status,
      ...(status === "SATISFIED" ? { coveredCents: c.context.requirement.requiredCents } : {}),
      evidenceRef: evidence.evidenceRef, evidenceDigest: evidence.evidenceDigest, reason: "TR-C2 isolated synthetic evidence" };
  };
  const counts = async (id: string) => (await o.pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_supply.account_guarantee_proof WHERE account_id=$1) AS proofs,
    (SELECT count(*)::int FROM zzsh_supply.idempotency_record WHERE scope_key LIKE '%' || $1 || '%') AS receipts,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action='supply.guarantee.proof_appended' AND outcome='SUCCESS') AS audits`, [id])).rows[0];
  const write = (id: string, b: Record<string, unknown>, staff = o.verifier, k = key()) => o.post(path(id), b, staff.jar, ADMIN, k);
  const readBytes = (id: string, assetId: string, staff = o.verifier) => fetch(`${o.base}/api/bff/admin/supply/accounts/${id}/guarantee-evidence/${assetId}/content`, { headers: { origin: ADMIN, cookie: staff.jar.header() } });
  const setRead = async (effect: string) => { await o.ownerPool.query(`UPDATE zzsh_iam.admin_user_permission SET effect=$2 WHERE admin_user_id=$1 AND permission_code='supply.guarantee.read'`, [o.verifier.id, effect]); };
  const waitBlocked = async () => {
    const deadline = Date.now() + 10_000;
    do {
      const r = await o.ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`);
      if (r.rows[0].n > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error("No deterministic database lock barrier observed");
  };
  const held = async (lock: (client: PoolClient) => Promise<unknown>, pending: () => Promise<any>, change: (client: PoolClient) => Promise<unknown>) => {
    const client = await o.ownerPool.connect();
    let work: Promise<any> | undefined;
    try {
      await client.query("BEGIN"); await lock(client); work = pending();
      await waitBlocked(); await change(client); await client.query("COMMIT");
      return await work;
    } finally { await client.query("ROLLBACK"); client.release(); if (work) await work.catch(() => undefined); }
  };
  const whileReading = async <T>(request: () => Promise<T>, change: () => Promise<void>) => {
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { reached = r; });
    const gate = new Promise<void>(r => { release = r; });
    o.evidenceReadProbe.run = async () => { delete o.evidenceReadProbe.run; reached(); await gate; };
    const pending = request();
    const timeout = setTimeout(() => reached(), 10_000);
    try { await ready; assert.equal(o.evidenceReadProbe.run, undefined, "storage read barrier was not reached"); await change(); release(); return await pending; }
    finally { clearTimeout(timeout); delete o.evidenceReadProbe.run; release(); await pending.catch(() => undefined); }
  };

  const noListing = await create();
  await t.test("TR-C2 context and lookup include accounts without listings; missing policy fails closed", async () => {
    const c = await context(noListing);
    assert.equal(c.context.currentVersionId, null); assert.equal(c.evaluation.effective, false);
    assert.ok(c.evaluation.reasonCodes.includes("POLICY_UNAVAILABLE"));
    const list = await o.post(`/api/bff/admin/supply/guarantee-accounts?gameId=${o.gameId}&after=${noListing.slice(0, -1)}&limit=100`, undefined, o.verifier.jar, ADMIN);
    assert.equal(list.response.status, 200); assert.ok(list.body!.items.some((a: any) => a.accountId === noListing));
  });
  await o.createFormalRelease();
  await t.test("TR-C2 waiver evidence, stale versions and double-admin CAS have zero failed-write effects", async () => {
    const c = await context(noListing), b = body(c, "NOT_REQUIRED"), before = await counts(noListing);
    for (const changed of [{ ...b, evidenceDigest: "0".repeat(64) }, { ...b, expectedPriceVersionId: "stale_price" }, { ...b, expectedReleaseId: "stale_release" }]) {
      assert.ok([400, 409].includes((await write(noListing, changed)).response.status)); assert.deepEqual(await counts(noListing), before);
    }
    const results = await held(client => client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=(SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1) FOR UPDATE`, [noListing]),
      () => Promise.all([write(noListing, b), write(noListing, b, o.secondVerifier)]), async () => undefined);
    assert.deepEqual(results.map((r: any) => r.response.status).sort(), [200, 409]);
    assert.equal((await context(noListing)).evaluation.effective, true);
    assert.equal((await counts(noListing)).proofs, 1);
  });
  await t.test("TR-C2 old price with identical policy text is rejected after waiting for the owner lock", async () => {
    const c = await context(noListing), b = body(c, "NOT_REQUIRED"), before = await counts(noListing);
    const r = await held(client => client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=(SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1) FOR UPDATE`, [noListing]),
      () => write(noListing, b), () => o.createFormalRelease());
    assert.equal(r.response.status, 409); assert.deepEqual(await counts(noListing), before);
    const now = await context(noListing);
    assert.equal(now.context.policyVersion, c.context.policyVersion); assert.notEqual(now.context.priceVersionId, c.context.priceVersionId);
    assert.equal(now.evaluation.effective, false); assert.ok(now.evaluation.reasonCodes.includes("PRICE_CHANGED"));
  });
  await o.createFormalRelease("SATISFIED");
  const account = await create(), foreign = await create(), material = await o.uploadEvidence(account);
  const materialPath = `/api/bff/admin/supply/accounts/${account}/guarantee-evidence/${material.assetId}/content`;
  await t.test("TR-C2 minimum guarantee reader gets exact private bytes; legacy and foreign media routes refuse", async () => {
    const response = await readBytes(account, material.assetId);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), material.bytes);
    assert.equal((await readBytes(foreign, material.assetId)).status, 404);
    const old = await fetch(`${o.base}/api/bff/admin/supply/media/${material.assetId}/content`, { headers: { origin: ADMIN, cookie: o.verifier.jar.header() } });
    assert.equal(old.status, 403);
    const display = (await o.pool.query(`SELECT id FROM zzsh_supply.media_asset WHERE purpose='ACCOUNT_DISPLAY' LIMIT 1`)).rows[0].id;
    assert.equal((await readBytes(account, display)).status, 404);
  });
  const c = await context(account), b = body(c, "SATISFIED", material.assetId), idem = key();
  await t.test("TR-C2 satisfied source digest and cross-account input validation precede any write", async () => {
    const before = await counts(account);
    assert.equal((await write(account, { ...b, evidenceDigest: "0".repeat(64) })).response.status, 400);
    assert.deepEqual(await counts(account), before);
    assert.equal((await write(foreign, b)).response.status, 404);
    assert.equal((await write(account, b, o.verifier, idem)).response.status, 200);
    assert.equal((await context(account)).evaluation.effective, true);
    const success = await counts(account);
    assert.equal((await write(account, b, o.verifier, idem)).response.status, 200); assert.deepEqual(await counts(account), success);
    assert.equal((await write(account, { ...b, reason: "different body" }, o.verifier, idem)).body!.error.code, "IDEMPOTENCY_KEY_REUSED");
  });
  await t.test("TR-C2 legacy successful receipt replays without the newly required CAS fields", async () => {
    const { expectedPriceVersionId: _price, expectedReleaseId: _release, ...legacy } = b;
    const legacyKey = key();
    await o.ownerPool.query(`INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required)
      SELECT scope_key,$2,$3,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE key=$1`,
    [idem["idempotency-key"], legacyKey["idempotency-key"], fingerprintRequest("supply.guarantee.proof.create", account, legacy)]);
    const before = await counts(account), replay = await write(account, legacy, o.verifier, legacyKey);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body)); assert.deepEqual(await counts(account), before);
    assert.equal((await write(account, legacy)).response.status, 400); assert.deepEqual(await counts(account), before);
  });
  await t.test("TR-C2 storage failure and revoked game scope withhold evidence", async () => {
    try {
      o.evidenceReadProbe.run = async () => { throw new Error("synthetic storage read unavailable"); };
      assert.equal((await readBytes(account, material.assetId)).status, 503);
    } finally { delete o.evidenceReadProbe.run; }
    await o.ownerPool.query(`DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`, [o.verifier.id, o.gameId]);
    try {
      assert.equal((await readBytes(account, material.assetId)).status, 404);
      assert.equal((await write(account, b, o.verifier, idem)).response.status, 404);
    } finally {
      await o.ownerPool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$3)`, [o.verifier.id, o.gameId, o.boss.id]);
    }
  });
  await t.test("TR-C2 final byte-read authorization notices revoked read permission and replay never leaks", async () => {
    try {
      const response = await whileReading(() => readBytes(account, material.assetId), () => setRead("DENY"));
      assert.equal(response.status, 403); assert.match(response.headers.get("content-type")!, /json/);
      const r = await write(account, b, o.verifier, idem);
      assert.equal(r.response.status, 403); assert.equal(JSON.stringify(r.body).includes(b.evidenceDigest), false);
    } finally { await setRead("ALLOW"); }
  });
  await t.test("TR-C2 byte-read quarantine race withholds bytes and historical replay redacts evidence", async () => {
    const response = await whileReading(() => readBytes(account, material.assetId), async () => {
      const r = await o.post(`/api/bff/admin/supply/media/${material.assetId}/review`, { decision: "QUARANTINE", reason: "isolated byte-read barrier" }, o.boss.jar, ADMIN);
      assert.equal(r.response.status, 200, JSON.stringify(r.body));
    });
    assert.equal(response.status, 409);
    const replay = await write(account, b, o.verifier, idem);
    assert.equal(replay.response.status, 200); assert.equal(replay.body!.proof.evidenceRef, null); assert.equal(replay.body!.proof.evidenceDigest, null);
    assert.equal(replay.body!.proof.evidenceAvailability, "UNAVAILABLE");
    const before = await counts(account);
    assert.equal((await write(account, { ...b, expectedProofVersion: "1" })).response.status, 409);
    assert.deepEqual(await counts(account), before);
  });
  await t.test("TR-C2 revoke uses previous-proof digest even when its material is quarantined", async () => {
    const now = await context(account), revoke = body(now, "REVOKED");
    assert.equal((await write(account, { ...revoke, evidenceDigest: "0".repeat(64) }, o.secondVerifier)).response.status, 400);
    assert.equal((await write(account, revoke, o.secondVerifier)).response.status, 200);
    const result = await context(account);
    assert.equal(result.proof.status, "REVOKED"); assert.equal(result.evaluation.effective, false); assert.ok(result.evaluation.reasonCodes.includes("REVOKED"));
  });
  await t.test("TR-C2 quarantine-first and permission-revoke-first writes reject after real lock waits", async () => {
    const id = await create(), m = await o.uploadEvidence(id), input = body(await context(id), "SATISFIED", m.assetId), before = await counts(id);
    const isolated = await held(client => lockPublishingAccount(client, id), () => write(id, input),
      client => reviewMediaAsset(client, o.boss.id, true, m.assetId, { decision: "QUARANTINE", reason: "isolated write barrier" }, lockPublishingAccount));
    assert.equal(isolated.response.status, 409); assert.deepEqual(await counts(id), before);
    try {
      const denied = await held(client => client.query(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id=$1 FOR UPDATE`, [o.verifier.id]),
        () => write(id, input), client => client.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='supply.guarantee.read'`, [o.verifier.id]));
      assert.equal(denied.response.status, 403); assert.deepEqual(await counts(id), before);
    } finally { await setRead("ALLOW"); }
  });
  for (const decision of ["QUARANTINE", "REJECT", "APPROVE"] as const) {
    await t.test(`TR-C2 context revalidates ${decision} and material revisions after its repeatable-read storage wait`, async () => {
      const id = await create(), selected = await o.uploadEvidence(id), other = await o.uploadEvidence(id), unchanged = await o.uploadEvidence(id);
      const created = await write(id, body(await context(id), "SATISFIED", selected.assetId));
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      const original = await context(id);
      assert.equal(original.proof.evidenceAvailability, "AVAILABLE");
      assert.equal(original.evidenceOptions.length, 3);
      const result = await whileReading(() => o.post(path(id), undefined, o.verifier.jar, ADMIN), async () => {
        // A later proof must not silently replace the one captured in the GET snapshot.
        const replaced = await write(id, body(original, "SATISFIED", unchanged.assetId));
        assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
        for (const assetId of [selected.assetId, other.assetId]) {
          const changed = await o.post(`/api/bff/admin/supply/media/${assetId}/review`, { decision, reason: "TR-C2 context material race" }, o.boss.jar, ADMIN);
          assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
        }
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body!.context, original.context);
      assert.equal(result.body!.proof.id, original.proof.id);
      assert.equal(result.body!.proof.versionNo, original.proof.versionNo);
      assert.equal(result.body!.proof.evidenceAvailability, "UNAVAILABLE");
      assert.equal(result.body!.proof.evidenceRef, null); assert.equal(result.body!.proof.evidenceDigest, null);
      assert.deepEqual(result.body!.evidenceOptions.map((e: any) => e.assetId), [unchanged.assetId]);
      assert.equal(result.body!.evaluation.effective, original.evaluation.effective);
      const latest = await context(id);
      assert.equal(latest.proof.versionNo, "2"); assert.equal(latest.proof.evidenceAvailability, "AVAILABLE");
      console.log("TR_C2_CONTEXT_RACE_FIXED", JSON.stringify({ decision, capturedVersion: result.body!.proof.versionNo,
        latestVersion: latest.proof.versionNo, availability: result.body!.proof.evidenceAvailability, options: result.body!.evidenceOptions.length }));
    });
  }
  await t.test("TR-C2 context final authorization withholds all material fields after read permission revocation", async () => {
    const id = await create(), material = await o.uploadEvidence(id);
    assert.equal((await write(id, body(await context(id), "SATISFIED", material.assetId))).response.status, 200);
    try {
      const result = await whileReading(() => o.post(path(id), undefined, o.verifier.jar, ADMIN), () => setRead("DENY"));
      assert.equal(result.response.status, 403);
      assert.equal(result.body!.proof, undefined); assert.equal(result.body!.evidenceOptions, undefined);
    } finally { await setRead("ALLOW"); }
  });
  console.log("TR-C2-API-A controlled HTTP/PG checks completed", JSON.stringify({ materialPath, realChannels: 0 }));
}
