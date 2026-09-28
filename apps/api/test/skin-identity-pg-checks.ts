/** Explicit seams for the next authorized PG/HTTP run. No connection, server or fixture creation on import. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type Fixture = { database: "zzsh_test_supply_skin1b_schema" | "zzsh_test_supply_skin1b_fresh"; oid: number; gameId: string; categoryId: string };

/** Caller owns the registered resource lock and runtime transaction; this probe always rolls back its rows. */
export async function assertSkinIdentityPg(client: PoolClient, fixture: Fixture): Promise<void> {
  const identity = (await client.query(`SELECT d.datname,d.oid::int,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.ok(["zzsh_test_supply_skin1b_schema", "zzsh_test_supply_skin1b_fresh"].includes(fixture.database));
  assert.equal(identity.datname, fixture.database); assert.equal(identity.oid, fixture.oid); assert.equal(identity.marker, "zzsh:m3b-supply-test:v1");
  const privileges = (await client.query(`SELECT has_column_privilege(current_user,'zzsh_supply.skin','naming_state','UPDATE') AS state,
    has_column_privilege(current_user,'zzsh_supply.skin','updated_at','UPDATE') AS timestamp,
    has_column_privilege(current_user,'zzsh_supply.skin','media_id','UPDATE') AS media`)).rows[0];
  assert.equal(privileges.state, false); assert.equal(privileges.timestamp, false); assert.equal(privileges.media, true);
  await client.query('SAVEPOINT skin_identity_probe');
  try {
    const suffix = randomUUID().replaceAll('-', '');
    const id = `skin_probe_${suffix}`, second = `skin_other_${suffix}`;
    await client.query(`INSERT INTO zzsh_supply.skin(id,game_id,code,name,category_id) VALUES($1,$2,$3,'Fixture',$4)`, [id, fixture.gameId, `probe_${suffix}`, fixture.categoryId]);
    const draft = (await client.query(`SELECT naming_state,enabled,form_visible FROM zzsh_supply.skin WHERE id=$1`, [id])).rows[0];
    assert.deepEqual(draft, { naming_state: "PENDING", enabled: false, form_visible: false });
    async function rejected(sql: string, args: unknown[], code: string) {
      await client.query('SAVEPOINT skin_expected_failure');
      try { await assert.rejects(client.query(sql, args), (error: unknown) => (error as { code: string }).code === code); }
      finally { await client.query('ROLLBACK TO SAVEPOINT skin_expected_failure'); await client.query('RELEASE SAVEPOINT skin_expected_failure'); }
    }
    await rejected(`UPDATE zzsh_supply.skin SET naming_state='VERIFIED' WHERE id=$1`, [id], '42501');
    // PostgreSQL checks column privileges even with zero matching rows (media regression).
    await rejected(`UPDATE zzsh_supply.skin SET updated_at=clock_timestamp() WHERE false`, [], '42501');
    await rejected(`UPDATE zzsh_supply.skin SET enabled=true WHERE id=$1`, [id], '23514');
    await rejected(`UPDATE zzsh_supply.skin SET aliases=ARRAY['same','same'] WHERE id=$1`, [id], '23514');
    await rejected(`UPDATE zzsh_supply.skin SET owner_id='unpaired' WHERE id=$1`, [id], '23514');
    await client.query(`UPDATE zzsh_supply.skin SET source_namespace='legacy.sg_zzsh',source_field='agent_skin',source_token=$1 WHERE id=$2`, [suffix, id]);
    await rejected(`INSERT INTO zzsh_supply.skin(id,game_id,code,name,category_id,source_namespace,source_field,source_token)
      VALUES($1,$2,$3,'Other fixture',$4,'legacy.sg_zzsh','agent_skin',$5)`, [second, fixture.gameId, `other_${suffix}`, fixture.categoryId, suffix], '23505');
    await client.query(`UPDATE zzsh_supply.skin SET media_id=NULL WHERE false`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT skin_identity_probe');
    await client.query('RELEASE SAVEPOINT skin_identity_probe');
  }
}

type Response = { status: number; body: Record<string, any> };
type Request = (actor: "manager" | "forbidden" | "outOfScope", method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>, key?: string) => Promise<Response>;

/** The registered harness supplies real same-origin/BFF or API requests and manages fixture cleanup. */
export async function assertSkinIdentityHttp(request: Request, fixture: { gameId: string; categoryId: string; ownerRef: { kind: "AGENT"; id: string } }): Promise<void> {
  const root = `/api/v1/admin/supply`;
  const catalogPath = `${root}/games/${fixture.gameId}/catalog`;
  const catalog = await request("manager", "GET", catalogPath); assert.equal(catalog.status, 200);
  const code = `http_${randomUUID().replaceAll('-', '')}`;
  const body = { code, name: "Fixture raw name", categoryId: fixture.categoryId, expectedCatalogRevision: catalog.body.game.catalogRevision };
  assert.equal((await request("forbidden", "POST", `${root}/games/${fixture.gameId}/skins`, body, randomUUID())).status, 403);
  assert.ok([403, 404].includes((await request("outOfScope", "POST", `${root}/games/${fixture.gameId}/skins`, body, randomUUID())).status));
  const key = randomUUID();
  const created = await request("manager", "POST", `${root}/games/${fixture.gameId}/skins`, body, key);
  assert.equal(created.status, 200); assert.equal(created.body.namingState, "PENDING"); assert.equal(created.body.code, code);
  const replay = await request("manager", "POST", `${root}/games/${fixture.gameId}/skins`, body, key);
  assert.deepEqual(replay, created);
  const collision = await request("manager", "POST", `${root}/games/${fixture.gameId}/skins`, { ...body, name: "Changed" }, key);
  assert.equal(collision.status, 409); assert.equal(collision.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const confirmed = await request("manager", "PUT", `${root}/skins/${created.body.id}`, {
    expectedCatalogRevision: created.body.catalogRevision, ownerRef: fixture.ownerRef, baseName: "Fixture base", confirmIdentity: true,
    reason: "Isolated HTTP verification", evidenceRefs: [{ url: "https://example.org/fixture", observedAt: "2026-09-26", region: "TEST", note: "Synthetic fixture; not an official catalog identity" }],
  }, randomUUID());
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.id, created.body.id); assert.equal(confirmed.body.code, code); assert.equal(confirmed.body.namingState, "VERIFIED");
  const refreshed = await request("manager", "GET", catalogPath);
  const skin = refreshed.body.skins.find((row: Record<string, unknown>) => row.id === created.body.id);
  assert.equal(skin.enabled, false); assert.equal(skin.formVisible, false); assert.ok(skin.aliases.includes("Fixture raw name"));
}
