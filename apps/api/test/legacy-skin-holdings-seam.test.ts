import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import type { PublishingAccount, SupplyGateReader } from "../src/supply/publishing";
import {
  recordLegacySkinHoldings,
  resolveLegacyObservationToDraft,
  type LegacySkinHoldingsInput,
  type LegacyImportActor,
} from "../src/supply/legacy-observation";

const DIGEST = "a".repeat(64);
const HOLDING_DIGEST = "c".repeat(64);
const ACTOR: LegacyImportActor = { id: "admin-1", sessionId: "session-1", requestId: "request-1" };
const ACTOR_2: LegacyImportActor = { id: "admin-2", sessionId: "session-2", requestId: "request-2" };
const FREE_GATE: SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "fixture:free" });

function account(id = "account-1"): PublishingAccount {
  return {
    id,
    owner_user_id: "user-1",
    game_id: "game-delta",
    current_version_id: "obs-1",
    owner_paused: false,
    staff_restricted: false,
    restriction_reason: null,
    legacy_hold: "UNRESOLVED",
    lifecycle: "ACTIVE",
    revision: "1",
    display_no: null,
  };
}

type LegacyHoldingRow = {
  account_id: string;
  observation_version_id: string;
  source_system: string;
  source_entity: string;
  legacy_id: string;
  source_digest: string;
  holding_digest: string;
  skin_ids: string[];
  created_by_admin_id: string;
};

type FakeVersion = {
  id: string;
  account_id: string;
  sequence?: string;
  origin: string;
  review_state: string;
  title?: string;
  description?: string | null;
  attributes?: Record<string, unknown>;
  term_option_code?: string;
  pricing_option_code?: string;
  schema_version?: number;
};

type FakeMap = {
  source_system?: string;
  source_entity?: string;
  legacy_id?: string;
  source_digest: string;
  version_id: string;
  account_id: string;
  evidence_ref?: string;
};

class FakeClient {
  readonly accounts = new Map<string, PublishingAccount>([["account-1", account()]]);
  readonly maps = new Map<string, FakeMap>();
  readonly versions = new Map<string, FakeVersion>();
  readonly skins = new Map<string, { id: string; game_id: string; naming_state: string; enabled: boolean; form_visible: boolean }>();
  readonly legacySkinHoldings = new Map<string, LegacyHoldingRow>();
  readonly listingSkins: Array<{ version_id: string; skin_id: string }> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly idempotency = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>();
  readonly queries: string[] = [];
  permission = true;
  scope = true;

  constructor() {
    this.maps.set("legacy_mysql_restore|la_rental_accounts|source-1", {
      source_system: "legacy_mysql_restore",
      source_entity: "la_rental_accounts",
      legacy_id: "source-1",
      source_digest: DIGEST,
      version_id: "obs-1",
      account_id: "account-1",
      evidence_ref: "evidence-map-1",
    });
    this.versions.set("obs-1", {
      id: "obs-1",
      account_id: "account-1",
      sequence: "1",
      origin: "LEGACY_OBSERVATION",
      review_state: "IMPORTED_UNVERIFIED",
      title: "历史资料待核实",
      description: null,
      attributes: {},
      term_option_code: "",
      pricing_option_code: "",
      schema_version: 1,
    });
    this.skins.set("skin_luna", { id: "skin_luna", game_id: "game-delta", naming_state: "VERIFIED", enabled: true, form_visible: true });
    this.skins.set("skin_gu", { id: "skin_gu", game_id: "game-delta", naming_state: "VERIFIED", enabled: true, form_visible: true });
    this.skins.set("skin_pending", { id: "skin_pending", game_id: "game-delta", naming_state: "PENDING", enabled: false, form_visible: false });
    this.skins.set("skin_disabled", { id: "skin_disabled", game_id: "game-delta", naming_state: "VERIFIED", enabled: false, form_visible: false });
    this.skins.set("skin_other_game", { id: "skin_other_game", game_id: "game-other", naming_state: "VERIFIED", enabled: true, form_visible: true });
  }

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.includes("idempotency_record") && sql.startsWith("SELECT")) {
      const row = this.idempotency.get(`${values[0]}|${values[1]}`);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("idempotency_record") && sql.startsWith("INSERT")) {
      this.idempotency.set(`${values[0]}|${values[1]}`, {
        requestFingerprint: String(values[2]),
        responseStatus: Number(values[3]),
        responseBody: JSON.parse(String(values[4])),
        publishRequired: false,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT s."game_scope_mode"')) {
      return { rows: [{ mode: this.scope ? "ALL_GAMES" : "SELECTED_GAMES", gameIds: [] } as T], rowCount: 1 };
    }
    if (sql.startsWith('SELECT "status", "is_boss"')) {
      return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false } as T], rowCount: 1 };
    }
    if (sql.includes('SELECT "suspended" FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false } as T], rowCount: 1 };
    if (sql.includes("user_identity_state")) return { rows: [], rowCount: 0 };
    if (sql.includes("game_service_operation")) return { rows: [{ id: "service-1", gameId: "game-delta", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1", supported: true } as T], rowCount: 1 };
    if (sql.includes("role_permissions") || sql.includes("admin_user_permission")) {
      return { rows: this.permission ? [{ permissionCode: "supply.catalog.manage" } as T] : [], rowCount: this.permission ? 1 : 0 };
    }
    if (sql.includes("admin_supply_scope")) return { rows: this.scope ? [{ one: 1 } as T] : [], rowCount: this.scope ? 1 : 0 };
    if (sql.includes("FROM zzsh_supply.rental_account") && sql.includes("WHERE id=$1")) {
      const row = this.accounts.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.listing_version") && sql.includes("WHERE id=$1 AND account_id=$2")) {
      const [verId, accId] = values;
      const row = this.versions.get(String(verId));
      if (row && row.account_id === accId) {
        return { rows: [{ ...row } as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM zzsh_supply.legacy_supply_map")) {
      const [system, entity, legacyId] = values;
      const key = `${system}|${entity}|${legacyId}`;
      const row = this.maps.get(key);
      return { rows: row ? [{ ...row } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.skin WHERE game_id=$1")) {
      const gameId = values[0];
      const skinIds = values[1] as string[];
      const matched = skinIds
        .map(id => this.skins.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s && s.game_id === gameId));
      return {
        rows: matched.map(s => ({
          id: s.id,
          naming_state: s.naming_state,
          enabled: s.enabled,
          form_visible: s.form_visible,
        }) as T),
        rowCount: matched.length,
      };
    }
    if (sql.includes("FROM zzsh_supply.legacy_skin_holding WHERE account_id=$1")) {
      const accId = String(values[0]);
      const row = this.legacySkinHoldings.get(accId);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.legacy_skin_holding WHERE observation_version_id=$1")) {
      const verId = String(values[0]);
      const matched = Array.from(this.legacySkinHoldings.values()).filter(r => r.observation_version_id === verId);
      return { rows: matched as T[], rowCount: matched.length };
    }
    if (sql.includes("INSERT INTO zzsh_supply.legacy_skin_holding")) {
      const [accId, verId, sys, ent, legId, srcDigest, hDigest, skinIds, adminId] = values as [string, string, string, string, string, string, string, string[], string];
      if (this.legacySkinHoldings.has(accId)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      this.legacySkinHoldings.set(accId, {
        account_id: accId,
        observation_version_id: verId,
        source_system: sys,
        source_entity: ent,
        legacy_id: legId,
        source_digest: srcDigest,
        holding_digest: hDigest,
        skin_ids: skinIds,
        created_by_admin_id: adminId,
      });
      return { rows: [], rowCount: 1 };
    }
    // Simulation of guard_listing_child trigger from 0018_m3c_listing_publication.sql
    if (sql.includes("INSERT INTO zzsh_supply.listing_skin")) {
      // Direct insertion counterexample check
      const match = /VALUES\(\$1,\s*\$2\)/.exec(sql);
      if (match) {
        const [verId, skinId] = values as [string, string];
        const ver = this.versions.get(String(verId));
        if (!ver) throw new Error("listing version not found");
        if (ver.review_state !== "DRAFT") {
          const err = new Error("submitted listing children are immutable") as Error & { code: string };
          err.code = "40001";
          throw err;
        }
        if (!this.listingSkins.some(ls => ls.version_id === verId && ls.skin_id === skinId)) {
          this.listingSkins.push({ version_id: verId, skin_id: skinId });
        }
        return { rows: [], rowCount: 1 };
      }
      // Union resolution insert into draft version
      const unionMatch = /SELECT \$1,\s*skin_id FROM/.exec(sql);
      if (unionMatch) {
        const [draftId, oldVerId] = values as [string, string];
        const draftVer = this.versions.get(String(draftId));
        if (!draftVer) throw new Error("listing version not found");
        if (draftVer.review_state !== "DRAFT") {
          const err = new Error("submitted listing children are immutable") as Error & { code: string };
          err.code = "40001";
          throw err;
        }
        // Copy existing listing_skin
        for (const ls of this.listingSkins.filter(x => x.version_id === oldVerId)) {
          if (!this.listingSkins.some(x => x.version_id === draftId && x.skin_id === ls.skin_id)) {
            this.listingSkins.push({ version_id: draftId, skin_id: ls.skin_id });
          }
        }
        // Copy unnested legacy_skin_holding
        for (const h of Array.from(this.legacySkinHoldings.values()).filter(x => x.observation_version_id === oldVerId)) {
          for (const sid of h.skin_ids) {
            if (!this.listingSkins.some(x => x.version_id === draftId && x.skin_id === sid)) {
              this.listingSkins.push({ version_id: draftId, skin_id: sid });
            }
          }
        }
        return { rows: [], rowCount: 1 };
      }
    }
    if (sql.includes("INSERT INTO zzsh_supply.listing_version")) {
      const [id, seq, origin, reviewState] = [values[0] as string, values[1] as string, "NATIVE", "DRAFT"];
      this.versions.set(id, { id, account_id: "account-1", origin, review_state: reviewState });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT (COALESCE(MAX(sequence),0)+1)::text")) {
      return { rows: [{ next: "2" } as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE zzsh_supply.rental_account")) {
      return { rows: [{ id: "account-1" } as T], rowCount: 1 };
    }
    if (sql.includes("audit_event")) {
      this.audits.push({ sql, values });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

function asClient(fake: FakeClient): PoolClient {
  return fake as unknown as PoolClient;
}

function validInput(overrides: Partial<LegacySkinHoldingsInput> = {}): LegacySkinHoldingsInput {
  return {
    observationVersionId: "obs-1",
    sourceSystem: "legacy_mysql_restore",
    sourceEntity: "la_rental_accounts",
    legacyId: "source-1",
    sourceDigest: DIGEST,
    holdingDigest: HOLDING_DIGEST,
    skinIds: ["skin_luna", "skin_gu"],
    evidenceRef: "legacy-skin-holdings-v1:first500:3841",
    ...overrides,
  };
}

test("SK11-R1-01: guard_listing_child counterexample reproduces 40001 on non-DRAFT listing_skin", async () => {
  const fake = new FakeClient();
  // Directly attempting to insert into listing_skin for IMPORTED_UNVERIFIED observation raises 40001
  await assert.rejects(
    async () => {
      await fake.query("INSERT INTO zzsh_supply.listing_skin(version_id, skin_id) VALUES($1, $2)", [
        "obs-1",
        "skin_luna",
      ]);
    },
    (err: unknown) => {
      const e = err as Error & { code: string };
      return e.code === "40001" && e.message.includes("submitted listing children are immutable");
    },
  );
});

test("SK11-R1-01: recordLegacySkinHoldings writes to legacy_skin_holding without violating guard_listing_child", async () => {
  const fake = new FakeClient();
  const res = await recordLegacySkinHoldings(asClient(fake), "account-1", validInput(), ACTOR);
  assert.equal(res.accountId, "account-1");
  assert.equal(res.observationVersionId, "obs-1");
  assert.deepEqual(res.attachedSkins, ["skin_gu", "skin_luna"]);
  // Listing_skin was untouched
  assert.equal(fake.listingSkins.length, 0);
  // Persisted to legacySkinHoldings
  const holding = fake.legacySkinHoldings.get("account-1");
  assert.ok(holding);
  assert.equal(holding.observation_version_id, "obs-1");
  assert.equal(holding.holding_digest, HOLDING_DIGEST);
  assert.deepEqual(holding.skin_ids, ["skin_gu", "skin_luna"]);
  assert.ok(fake.audits.length > 0);
});

test("SK11-R1-01: resolveLegacyObservationToDraft carries legacy_skin_holding into native DRAFT listing_skin", async () => {
  const fake = new FakeClient();
  await recordLegacySkinHoldings(asClient(fake), "account-1", validInput(), ACTOR);

  const draft = await resolveLegacyObservationToDraft(
    asClient(fake),
    "account-1",
    {
      sourceSystem: "legacy_mysql_restore",
      sourceEntity: "la_rental_accounts",
      legacyId: "source-1",
      sourceDigest: DIGEST,
      expectedObservationVersionId: "obs-1",
      expectedOwnerUserId: "user-1",
      expectedGameId: "game-delta",
    },
    ACTOR,
    FREE_GATE,
  );

  assert.equal(draft.status, "DRAFT");
  // The new native DRAFT version has the skins copied into listing_skin legally
  const draftSkins = fake.listingSkins.filter(ls => ls.version_id === draft.versionId);
  assert.equal(draftSkins.length, 2);
  assert.ok(draftSkins.some(ls => ls.skin_id === "skin_luna"));
  assert.ok(draftSkins.some(ls => ls.skin_id === "skin_gu"));
});

test("SK11-R1-02: validates parameters, exact map, holding digest and verified public skins", async () => {
  const fake = new FakeClient();
  // Parameter validation
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceSystem: "unknown" }), ACTOR), /system\/entity/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceEntity: "unknown" }), ACTOR), /system\/entity/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceDigest: "short" }), ACTOR), /Source digest is invalid/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ holdingDigest: "bad" }), ACTOR), /Holding digest is invalid/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: "not_array" as never }), ACTOR), /skinIds must be an array/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ evidenceRef: "" }), ACTOR), /Invalid evidence ref/);

  // Missing map
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ legacyId: "missing-source" }), ACTOR), /Legacy supply map not found/);

  // Mismatched map account
  fake.maps.set("legacy_mysql_restore|la_rental_accounts|other-acc", { source_digest: DIGEST, version_id: "obs-1", account_id: "account-other" });
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ legacyId: "other-acc" }), ACTOR), /account does not match target account/);

  // Mismatched map version
  fake.maps.set("legacy_mysql_restore|la_rental_accounts|other-ver", { source_digest: DIGEST, version_id: "obs-other", account_id: "account-1" });
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ legacyId: "other-ver" }), ACTOR), /version does not match target version/);

  // Mismatched source digest
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceDigest: "b".repeat(64) }), ACTOR), /conflicts/);

  // Unverified or disabled skins
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_pending"] }), ACTOR), /not a verified, enabled, public skin/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_disabled"] }), ACTOR), /not a verified, enabled, public skin/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_other_game"] }), ACTOR), /do not belong/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_nonexistent"] }), ACTOR), /do not belong/);
});

test("SK11-R1-02: legal empty vs non-legal empty validation", async () => {
  const fake = new FakeClient();
  // Empty skinIds without columns proof is rejected
  await assert.rejects(
    () => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: [] }), ACTOR),
    /Empty skinIds requires proof of four observed empty columns/,
  );

  // Empty skinIds with non-empty column tokens is rejected
  await assert.rejects(
    () => recordLegacySkinHoldings(
      asClient(fake),
      "account-1",
      validInput({
        skinIds: [],
        columns: { knife_skin: "赤霄", agent_skin: "", weapon_skin: null, gold_skin: null },
      }),
      ACTOR,
    ),
    /Empty skinIds requires proof of four observed empty columns/,
  );

  // Empty skinIds with 4 observed empty columns is accepted as legal empty
  const res = await recordLegacySkinHoldings(
    asClient(fake),
    "account-1",
    validInput({
      skinIds: [],
      columns: { knife_skin: "", agent_skin: null, weapon_skin: "", gold_skin: " , " },
    }),
    ACTOR,
  );
  assert.deepEqual(res.attachedSkins, []);
  assert.deepEqual(fake.legacySkinHoldings.get("account-1")?.skin_ids, []);
});

test("SK11-R1-03: set conflict detection prevents disjoint keys or union accumulation", async () => {
  const fake = new FakeClient();
  // First declaration: set A = [skin_luna]
  const inputA = validInput({ skinIds: ["skin_luna"] });
  const resA = await recordLegacySkinHoldings(asClient(fake), "account-1", inputA, ACTOR);
  assert.deepEqual(resA.attachedSkins, ["skin_luna"]);

  // Replay of identical set A succeeds cleanly
  const replayA = await recordLegacySkinHoldings(asClient(fake), "account-1", inputA, ACTOR);
  assert.deepEqual(replayA.attachedSkins, ["skin_luna"]);

  // Second declaration: set B = [skin_gu] (different set)
  // MUST NOT create a new key or accumulate A ∪ B; MUST conflict!
  const inputB = validInput({ skinIds: ["skin_gu"], holdingDigest: "d".repeat(64) });
  await assert.rejects(
    () => recordLegacySkinHoldings(asClient(fake), "account-1", inputB, ACTOR),
    /Legacy skin holdings conflict with recorded holding for this account/,
  );

  // Cross-actor attempt with set B also conflicts
  await assert.rejects(
    () => recordLegacySkinHoldings(asClient(fake), "account-1", inputB, ACTOR_2),
    /Legacy skin holdings conflict with recorded holding for this account/,
  );

  // Persistent record remains exactly set A
  const persisted = fake.legacySkinHoldings.get("account-1");
  assert.deepEqual(persisted?.skin_ids, ["skin_luna"]);
});

test("SK11-R1-03: reverse order B then A conflicts", async () => {
  const fake = new FakeClient();
  const inputB = validInput({ skinIds: ["skin_gu"], holdingDigest: "d".repeat(64) });
  await recordLegacySkinHoldings(asClient(fake), "account-1", inputB, ACTOR);

  const inputA = validInput({ skinIds: ["skin_luna"] });
  await assert.rejects(
    () => recordLegacySkinHoldings(asClient(fake), "account-1", inputA, ACTOR),
    /Legacy skin holdings conflict with recorded holding for this account/,
  );
});
