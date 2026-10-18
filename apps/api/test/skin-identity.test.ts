import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { createCatalogEntry, updateCatalogEntry, parseSkinWrite, createSkinOwner, readPublicCatalog } from "../src/supply/catalog";
import { configureSkinIdentityPrivileges } from "../src/database/business-migrations";
import { withIdempotency } from "../src/supply/supply-util";
import { changeMediaVisibility, reviewMediaAsset } from "../src/supply/media";

const evidence = { reason: "Reviewed relation", evidenceRefs: [{ url: "https://example.org/official", observedAt: "2026-09-26", region: "CN", note: "Offline fixture, not official evidence" }] };
const draft = { code: "skin_fixture", name: "旧名", categoryId: "category_fixture", expectedCatalogRevision: "10" };
const legacy = { id: "skin_fixture", game_id: "game_fixture", code: "stable_code", name: "旧名", category_id: "category_fixture", rarity_code: null, media_id: null, sort_order: 0, enabled: true, form_visible: true, naming_state: "LEGACY", aliases: [], owner_kind: null, owner_id: null, firearm_id: null, base_name: null, source_namespace: null, source_field: null, source_token: null };

// Records calls from the real writer; does not implement PostgreSQL constraints/locks.
function clientFixture(row: Record<string, unknown> = legacy, options: { revision?: string; cas?: boolean; sourceOccupied?: boolean; ownerGameMismatch?: boolean; ownerEnabled?: boolean } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT "id", "catalog_revision"')) rows = [{ id: "game_fixture", catalogRevision: options.revision ?? "10" }];
    else if (sql.startsWith('SELECT * FROM "zzsh_supply"."skin"')) rows = [row];
    else if (sql.includes('SELECT catalog_revision::text')) rows = [{ revision: options.revision ?? "10" }];
    else if (sql.startsWith('UPDATE zzsh_supply.game')) rows = options.cas === false ? [] : [{ revision: "11" }];
    else if (sql.startsWith('UPDATE zzsh_supply.skin SET')) rows = [{ namingState: args[11] ? "VERIFIED" : row.naming_state }];
    else if (sql.includes('source_namespace COLLATE')) rows = options.sourceOccupied ? [{ id: "other_skin" }] : [];
    else if (sql.startsWith('SELECT name,enabled FROM')) rows = options.ownerGameMismatch ? [] : [{ name: "露娜", enabled: options.ownerEnabled ?? true }];
    else if (sql.includes('SELECT 1 FROM "zzsh_supply"."skin"')) rows = [];
    else if (sql.includes('"zzsh_supply"."admin_supply_scope"')) rows = sql.includes('"game_scope_mode"') ? [{ mode: "SELECTED_GAMES", gameIds: [] }] : [];
    else if (sql.includes('SELECT 1 FROM "zzsh_supply"."skin_category"') || sql.includes('SELECT 1 FROM "zzsh_supply"."game"')) rows = [{}];
    else if (!sql.startsWith('INSERT INTO zzsh_supply.')) throw new Error(`Unexpected query: ${sql}`);
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  return { client, calls };
}

test("skin parser checks explicit shape, nulls, ASCII trim and Unicode code points", () => {
  assert.equal(parseSkinWrite({ ...draft, name: ` \t${"😀".repeat(120)}\r` }, false).name, "😀".repeat(120));
  assert.throws(() => parseSkinWrite({ ...draft, name: "😀".repeat(121) }, false));
  for (const extra of [{ namingState: "VERIFIED" }, { enabled: true }, { expectedCatalogRevision: 10 }, { expectedCatalogRevision: null }, { categoryId: null }, { aliases: [null] }, { aliases: [["a"]] }, { aliases: ["a", " a "] }, { sourceField: "agent_skin" }]) assert.throws(() => parseSkinWrite({ ...draft, ...extra }, false));
  assert.equal(parseSkinWrite({ ...draft, sourceNamespace: "legacy.sg_zzsh", sourceField: "agent_skin", sourceToken: " raw token " }, false).sourceToken, " raw token ");
  for (const ownerRef of [null, { kind: ["AGENT"], id: "x" }, { kind: "CATEGORY", id: "x" }, { kind: "AGENT", id: "x", extra: 1 }]) assert.throws(() => parseSkinWrite({ expectedCatalogRevision: "10", ownerRef, confirmIdentity: true, ...evidence }, true));
  assert.throws(() => parseSkinWrite({ expectedCatalogRevision: "10", baseName: "新名", ...evidence }, true));
  assert.throws(() => parseSkinWrite({ expectedCatalogRevision: "10", baseName: null, confirmIdentity: true, ...evidence }, true));
  assert.throws(() => parseSkinWrite({ expectedCatalogRevision: "10", confirmIdentity: true, ...evidence, evidenceRefs: [{ ...evidence.evidenceRefs[0], observedAt: "2026-99-99" }] }, true));
});

test("actual create writes a disabled pending draft and returns the terminal CAS revision", async () => {
  const f = clientFixture();
  const result = await createCatalogEntry(f.client, "admin_fixture", true, "skins", "game_fixture", draft);
  assert.equal(result.namingState, "PENDING"); assert.equal(result.catalogRevision, "11");
  const insert = f.calls.find(c => c.sql.startsWith('INSERT INTO zzsh_supply.skin'))!;
  assert.match(insert.sql, /false,false/); assert.ok(!insert.sql.includes('naming_state'));
  assert.ok(f.calls.at(-1)!.sql.startsWith('UPDATE zzsh_supply.game'));
  assert.deepEqual(f.calls.at(-1)!.args, ["game_fixture", "10"]);
});

test("actual writers reject stale revisions, foreign owner, source conflicts and failed terminal CAS", async () => {
  const unscoped = clientFixture();
  await assert.rejects(createCatalogEntry(unscoped.client, "unscoped", false, "skins", "game_fixture", draft), /No game scope/);
  assert.ok(!unscoped.calls.some(c => c.sql.startsWith('INSERT')));
  const stale = clientFixture(legacy, { revision: "11" });
  await assert.rejects(createCatalogEntry(stale.client, "a", true, "skins", "game_fixture", draft), /Catalog changed/);
  assert.ok(!stale.calls.some(c => c.sql.startsWith('INSERT')));
  const occupied = clientFixture(legacy, { sourceOccupied: true });
  await assert.rejects(createCatalogEntry(occupied.client, "a", true, "skins", "game_fixture", { ...draft, sourceNamespace: "legacy.sg_zzsh", sourceField: "agent_skin", sourceToken: "旧名" }), /already attached/);
  const body = { expectedCatalogRevision: "10", ownerRef: { kind: "AGENT", id: "owner_fixture" }, baseName: "黑·天际线", confirmIdentity: true, ...evidence };
  for (const options of [{ ownerGameMismatch: true }, { ownerEnabled: false }]) await assert.rejects(updateCatalogEntry(clientFixture(legacy, options).client, "a", true, "skins", "skin_fixture", body));
  await assert.rejects(updateCatalogEntry(clientFixture(legacy, { cas: false }).client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", sortOrder: 1 }), /Catalog changed/);
});

test("actual media withdrawal/rejection/quarantine clears skins with allowed columns and deduplicates revisions", async () => {
  for (const count of [0, 2]) for (const operation of ["PRIVATE_REVIEW", "REJECT", "QUARANTINE"]) {
    const bumped: unknown[] = [];
    let skinUpdates = 0;
    const asset = { id: "media_fixture", gameId: "game_fixture", accountId: null, purpose: "SKIN_MEDIA", ownershipKind: "PLATFORM_CATALOG", reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" };
    const client = { query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM "zzsh_supply"."media_asset"')) return { rows: [asset], rowCount: 1 };
      if (sql.startsWith('UPDATE "zzsh_supply"."skin"')) {
        skinUpdates++;
        if (sql.includes('"updated_at"')) throw new Error("runtime lacks updated_at column permission, even for zero rows");
        return { rows: Array.from({ length: count }, () => ({ gameId: "game_fixture" })), rowCount: count };
      }
      if (sql.includes('"catalog_revision" = "catalog_revision" + 1')) bumped.push(args[0]);
      return { rows: [], rowCount: 0 };
    } } as unknown as PoolClient;
    if (operation === "PRIVATE_REVIEW") await changeMediaVisibility(client, "a", true, asset.id, { visibility: operation });
    else await reviewMediaAsset(client, "a", true, asset.id, { decision: operation, reason: "Fixture withdrawal" });
    assert.equal(skinUpdates, 1); assert.deepEqual(bumped, count ? ["game_fixture"] : []);
  }
});

test("LEGACY rename keeps flags, stable identity and prior name; explicit confirmation materializes the owner", async () => {
  const f = clientFixture();
  await updateCatalogEntry(f.client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", name: "更正名", reason: "Rename" });
  const update = f.calls.find(c => c.sql.startsWith('UPDATE zzsh_supply.skin SET'))!;
  assert.deepEqual(update.args.slice(0, 3), ["更正名", true, true]); assert.deepEqual(update.args[7], ["旧名"]);
  assert.ok(!update.sql.includes('updated_at')); assert.ok(!update.sql.includes('naming_state='));
  const confirmed = clientFixture();
  const result = await updateCatalogEntry(confirmed.client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", ownerRef: { kind: "AGENT", id: "owner_fixture" }, baseName: "黑·天际线", confirmIdentity: true, ...evidence });
  assert.equal(result.code, "stable_code"); assert.equal(result.namingState, "VERIFIED");
  assert.equal(confirmed.calls.find(c => c.sql.startsWith('UPDATE zzsh_supply.skin SET'))!.args[0], "露娜-黑·天际线");
});

test("pending enable, verified bare rename, primary-source overwrite and legacy re-enable fail closed", async () => {
  for (const [row, body] of [
    [{ ...legacy, naming_state: "PENDING", enabled: false, form_visible: false }, { enabled: true }],
    [{ ...legacy, naming_state: "VERIFIED" }, { name: "随意改名", reason: "Rename" }],
    [{ ...legacy, enabled: false }, { enabled: true }],
    [{ ...legacy, source_namespace: "other", source_field: "agent_skin", source_token: "旧名" }, { sourceNamespace: "legacy.sg_zzsh", sourceField: "agent_skin", sourceToken: "旧名", ...evidence }],
  ] as const) await assert.rejects(updateCatalogEntry(clientFixture(row).client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", ...body }));
});

test("two names with different owners remain separate; owner writes stay narrow", async () => {
  const f = clientFixture();
  const result = await createSkinOwner(f.client, "a", true, "game_fixture", { expectedCatalogRevision: "10", kind: "AGENT", code: "agent_fixture", name: "露娜", ...evidence });
  assert.equal(result.kind, "AGENT");
  await assert.rejects(createSkinOwner(f.client, "a", true, "game_fixture", { expectedCatalogRevision: "10", kind: "FIREARM", code: "x1", name: "枪械", ...evidence }));
  const refs = ["first", "second"].map(id => parseSkinWrite({ expectedCatalogRevision: "10", ownerRef: { kind: "AGENT", id }, baseName: "同名", confirmIdentity: true, ...evidence }, true).ownerRef);
  assert.notDeepEqual(refs[0], refs[1]);
});

test("runner leaves old migration prefixes alone, rejects partial schemas and excludes state/timestamp grants", async () => {
  for (const [count, present] of [[0, false], [7, true], [1, true]] as const) {
    const writes: string[] = [];
    const pool = { query: async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ count }] };
      if (sql.includes('AS present')) return { rows: [{ present }] };
      writes.push(sql); return { rows: [] };
    } } as unknown as Parameters<typeof configureSkinIdentityPrivileges>[0];
    if (count === 1) await assert.rejects(configureSkinIdentityPrivileges(pool, "fixture_runtime"), /incomplete/);
    else await configureSkinIdentityPrivileges(pool, "fixture_runtime");
    assert.equal(writes.length, count === 7 ? 1 : 0);
    if (writes.length) {
      const columns = /GRANT UPDATE \(([^)]+)\) ON zzsh_supply.skin TO/.exec(writes[0]!)![1]!;
      assert.ok(!columns.includes('updated_at')); assert.ok(!columns.includes('naming_state')); assert.ok(columns.includes('media_id'));
    }
  }
});

test("existing idempotency entry reauthorizes and replays without executing a stale CAS action", async () => {
  let authorized = 0, executed = 0;
  const client = { query: async (sql: string) => ({ rows: sql.includes('FROM "zzsh_supply"."idempotency_record"') ? [{ requestFingerprint: "original", responseStatus: 200, responseBody: { catalogRevision: "11" }, publishRequired: false }] : [] }) } as unknown as PoolClient;
  const scope = { realm: "admin" as const, principalId: "a", operation: "supply.catalog.skins.update", resourceId: "s" };
  const result = await withIdempotency(client, scope, "same_key", "original", async () => { authorized++; }, async () => { executed++; throw new Error("CAS must not run"); });
  assert.equal(result.replayed, true); assert.equal(authorized, 1); assert.equal(executed, 0);
  await assert.rejects(withIdempotency(client, scope, "same_key", "changed_body", async () => { authorized++; }, async () => { throw new Error("must not execute"); }), /different request/);
  assert.equal(authorized, 2);
});

// SKIN-MODEL-7 B: official quality reuses skin_rarity. A new or changed binding must name an
// enabled entry of the same game; an unrelated edit keeps whatever is already bound. The fake
// client answers the rarity lookup from an in-memory vocabulary; it is not PostgreSQL.
const SK7_RARITIES: Record<string, Record<string, boolean>> = { game_fixture: { q_enabled: true, q_retired: false }, game_other: { q_foreign: true } };
function withRarities(fixture: ReturnType<typeof clientFixture>, options: { referenced?: boolean } = {}) {
  const inner = fixture.client.query as unknown as (sql: string, args?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  const client = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT * FROM "zzsh_supply"."skin_rarity"')) {
      fixture.calls.push({ sql, args });
      const rows = [{ id: "rarity_fixture", game_id: "game_fixture", code: "q_enabled", name: "测试品质", enabled: true }];
      return { rows, rowCount: 1 };
    }
    if (sql.includes('"zzsh_supply"."skin_rarity"') && sql.includes('"code" = $2')) {
      fixture.calls.push({ sql, args });
      const vocabulary = SK7_RARITIES[String(args[0])] ?? {};
      const code = String(args[1]);
      const rows = Object.hasOwn(vocabulary, code) ? [{ enabled: vocabulary[code] }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('"rarity_code" = $2 LIMIT 1')) {
      fixture.calls.push({ sql, args });
      const rows = options.referenced ? [{}] : [];
      return { rows, rowCount: rows.length };
    }
    return inner(sql, args);
  } } as unknown as PoolClient;
  return { client, calls: fixture.calls };
}
const sk7Update = (calls: Array<{ sql: string; args: unknown[] }>) => calls.find(c => c.sql.startsWith("UPDATE zzsh_supply.skin SET"));

test("SK7 create refuses a disabled or foreign-game quality before any insert and keeps an enabled one", async () => {
  for (const rarityCode of ["q_retired", "q_foreign", "q_missing"]) {
    const f = withRarities(clientFixture());
    await assert.rejects(createCatalogEntry(f.client, "a", true, "skins", "game_fixture", { ...draft, rarityCode }), /Rarity is (disabled|not defined)/, rarityCode);
    assert.ok(!f.calls.some(c => c.sql.startsWith("INSERT")), `${rarityCode} must not insert`);
    assert.ok(!f.calls.some(c => c.sql.startsWith("UPDATE zzsh_supply.game")), `${rarityCode} must not bump the catalog`);
  }
  const ok = withRarities(clientFixture());
  await createCatalogEntry(ok.client, "a", true, "skins", "game_fixture", { ...draft, rarityCode: "q_enabled" });
  assert.equal(ok.calls.find(c => c.sql.startsWith("INSERT INTO zzsh_supply.skin"))!.args[5], "q_enabled");
  const unknown = withRarities(clientFixture());
  await createCatalogEntry(unknown.client, "a", true, "skins", "game_fixture", draft);
  assert.equal(unknown.calls.find(c => c.sql.startsWith("INSERT INTO zzsh_supply.skin"))!.args[5], null, "unknown quality stays null, never defaulted");
});

test("SK7 update keeps an existing disabled binding through unrelated edits but refuses a new disabled or foreign one", async () => {
  const bound = { ...legacy, rarity_code: "q_retired" };
  for (const body of [{ expectedCatalogRevision: "10", sortOrder: 3 }, { expectedCatalogRevision: "10", rarityCode: "q_retired", sortOrder: 4 }]) {
    const f = withRarities(clientFixture(bound));
    await updateCatalogEntry(f.client, "a", true, "skins", "skin_fixture", body);
    assert.equal(sk7Update(f.calls)!.args[5], "q_retired", `kept binding is neither cleared nor relabelled: ${JSON.stringify(body)}`);
  }
  for (const rarityCode of ["q_retired", "q_foreign", "q_missing"]) {
    const f = withRarities(clientFixture({ ...legacy, rarity_code: "q_enabled" }));
    await assert.rejects(updateCatalogEntry(f.client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", rarityCode }), /Rarity is (disabled|not defined)/, rarityCode);
    assert.equal(sk7Update(f.calls), undefined, `${rarityCode} must not write`);
  }
  const changed = withRarities(clientFixture(bound));
  await updateCatalogEntry(changed.client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", rarityCode: "q_enabled" });
  assert.equal(sk7Update(changed.calls)!.args[5], "q_enabled");
  const cleared = withRarities(clientFixture(bound));
  await updateCatalogEntry(cleared.client, "a", true, "skins", "skin_fixture", { expectedCatalogRevision: "10", rarityCode: null });
  assert.equal(sk7Update(cleared.calls)!.args[5], null, "clearing to unknown stays possible");
});

test("SK7 a referenced quality still cannot be disabled", async () => {
  const f = withRarities(clientFixture(), { referenced: true });
  await assert.rejects(updateCatalogEntry(f.client, "a", true, "rarities", "rarity_fixture", { enabled: false }), /still referenced/);
  assert.ok(!f.calls.some(c => c.sql.startsWith('UPDATE "zzsh_supply"."skin_rarity"')));
});

test("SK7 public catalog skins carry owner type and the same-game quality name; filters list enabled qualities only", async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    queries.push(sql);
    const rows = sql.includes('FROM "zzsh_supply"."game"') ? [{ id: "game_fixture", code: "delta", name: "三角洲行动", catalogRevision: "10", currentReleaseId: null, coverMediaId: null }] : [];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  await readPublicCatalog(client, "game_fixture", {}, 20);
  const skins = queries.find(q => q.includes('s."owner_kind" AS "ownerKind"'));
  assert.ok(skins, "skin projection selects owner kind");
  assert.ok(skins!.includes("(SELECT r.name FROM zzsh_supply.skin_rarity r WHERE r.game_id=s.game_id AND r.code=s.rarity_code) AS \"rarityName\""), "quality name joins on the same game and code");
  const vocabulary = queries.find(q => /FROM "zzsh_supply"\."skin_rarity"/.test(q));
  assert.ok(vocabulary && /"enabled" = true/.test(vocabulary), "the filter vocabulary offers enabled qualities only");
  assert.ok(queries.every(q => !/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});
