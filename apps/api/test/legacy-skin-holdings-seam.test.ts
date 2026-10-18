import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import type { PublishingAccount } from "../src/supply/publishing";
import {
  recordLegacySkinHoldings,
  type LegacySkinHoldingsInput,
  type LegacyImportActor,
} from "../src/supply/legacy-observation";

const DIGEST = "a".repeat(64);
const ACTOR: LegacyImportActor = { id: "admin-1", sessionId: "session-1", requestId: "request-1" };

function account(id = "account-1"): PublishingAccount {
  return {
    id,
    owner_user_id: "user-1",
    game_id: "game-delta",
    current_version_id: null,
    owner_paused: false,
    staff_restricted: false,
    restriction_reason: null,
    legacy_hold: "NONE",
    lifecycle: "ACTIVE",
    revision: "1",
    display_no: null,
  };
}

class FakeClient {
  readonly accounts = new Map<string, PublishingAccount>([["account-1", account()]]);
  readonly maps = new Map<string, { source_digest: string }>();
  readonly versions = new Map<string, { id: string; account_id: string; origin: string }>();
  readonly skins = new Map<string, { id: string; game_id: string }>();
  readonly listingSkins: Array<{ version_id: string; skin_id: string }> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly idempotency = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>();
  readonly queries: string[] = [];
  permission = true;
  scope = true;

  constructor() {
    this.maps.set("legacy_mysql_restore|la_rental_accounts|source-1|account-1", { source_digest: DIGEST });
    this.versions.set("obs-1", { id: "obs-1", account_id: "account-1", origin: "LEGACY_OBSERVATION" });
    this.skins.set("skin_luna", { id: "skin_luna", game_id: "game-delta" });
    this.skins.set("skin_gu", { id: "skin_gu", game_id: "game-delta" });
    this.skins.set("skin_other_game", { id: "skin_other_game", game_id: "game-other" });
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
    if (sql.includes("role_permissions") || sql.includes("admin_user_permission")) {
      return { rows: this.permission ? [{ permissionCode: "supply.catalog.manage" } as T] : [], rowCount: this.permission ? 1 : 0 };
    }
    if (sql.includes("admin_supply_scope")) return { rows: this.scope ? [{ one: 1 } as T] : [], rowCount: this.scope ? 1 : 0 };
    if (sql.includes("FROM zzsh_supply.rental_account") && sql.includes("WHERE id=$1")) {
      const row = this.accounts.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.listing_version") && sql.includes("origin='LEGACY_OBSERVATION'")) {
      const [verId, accId] = values;
      const row = this.versions.get(String(verId));
      if (row && row.account_id === accId && row.origin === "LEGACY_OBSERVATION") {
        return { rows: [{ id: row.id } as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM zzsh_supply.legacy_supply_map")) {
      const [system, entity, legacyId, accId] = values;
      const key = `${system}|${entity}|${legacyId}|${accId}`;
      const row = this.maps.get(key);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.skin WHERE game_id=$1")) {
      const gameId = values[0];
      const skinIds = values[1] as string[];
      const matched = skinIds
        .map(id => this.skins.get(id))
        .filter((s): s is { id: string; game_id: string } => Boolean(s && s.game_id === gameId));
      return { rows: matched.map(s => ({ id: s.id }) as T), rowCount: matched.length };
    }
    if (sql.includes("INSERT INTO zzsh_supply.listing_skin")) {
      const [verId, skinId] = values as [string, string];
      if (!this.listingSkins.some(ls => ls.version_id === verId && ls.skin_id === skinId)) {
        this.listingSkins.push({ version_id: verId, skin_id: skinId });
      }
      return { rows: [], rowCount: 1 };
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
    skinIds: ["skin_luna", "skin_gu"],
    evidenceRef: "legacy-skin-holdings-v1:first500:3841",
    ...overrides,
  };
}

test("recordLegacySkinHoldings validates input parameters strictly", async () => {
  const fake = new FakeClient();
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceSystem: "unknown" }), ACTOR), /system\/entity/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceEntity: "unknown" }), ACTOR), /system\/entity/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceDigest: "short" }), ACTOR), /Source digest is invalid/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: "not_array" as never }), ACTOR), /skinIds must be an array/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ evidenceRef: "" }), ACTOR), /Invalid evidence ref/);
});

test("recordLegacySkinHoldings checks permission and game scope", async () => {
  const noPerm = new FakeClient();
  noPerm.permission = false;
  await assert.rejects(() => recordLegacySkinHoldings(asClient(noPerm), "account-1", validInput(), ACTOR), /Permission required/);

  const noScope = new FakeClient();
  noScope.scope = false;
  await assert.rejects(() => recordLegacySkinHoldings(asClient(noScope), "account-1", validInput(), ACTOR), /No game scope is assigned/);
});

test("recordLegacySkinHoldings rejects non-existent or mismatched observation version", async () => {
  const fake = new FakeClient();
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ observationVersionId: "obs-unknown" }), ACTOR));
});

test("recordLegacySkinHoldings rejects mismatched source digest", async () => {
  const fake = new FakeClient();
  const badDigest = "b".repeat(64);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ sourceDigest: badDigest }), ACTOR), /conflicts/);
});

test("recordLegacySkinHoldings rejects skins from a different game or non-existent skins", async () => {
  const fake = new FakeClient();
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_luna", "skin_other_game"] }), ACTOR), /do not belong/);
  await assert.rejects(() => recordLegacySkinHoldings(asClient(fake), "account-1", validInput({ skinIds: ["skin_nonexistent"] }), ACTOR), /do not belong/);
});

test("recordLegacySkinHoldings successfully attaches verified skins and records audit trail", async () => {
  const fake = new FakeClient();
  const res = await recordLegacySkinHoldings(asClient(fake), "account-1", validInput(), ACTOR);
  assert.equal(res.accountId, "account-1");
  assert.equal(res.observationVersionId, "obs-1");
  assert.deepEqual(res.attachedSkins, ["skin_gu", "skin_luna"]);
  assert.equal(fake.listingSkins.length, 2);
  assert.ok(fake.listingSkins.some(ls => ls.skin_id === "skin_luna" && ls.version_id === "obs-1"));
  assert.ok(fake.listingSkins.some(ls => ls.skin_id === "skin_gu" && ls.version_id === "obs-1"));
  assert.ok(fake.audits.length > 0);
});

test("recordLegacySkinHoldings is idempotent on re-execution", async () => {
  const fake = new FakeClient();
  const first = await recordLegacySkinHoldings(asClient(fake), "account-1", validInput(), ACTOR);
  const second = await recordLegacySkinHoldings(asClient(fake), "account-1", validInput(), ACTOR);
  assert.deepEqual(first, second);
  assert.equal(fake.listingSkins.length, 2);
});
