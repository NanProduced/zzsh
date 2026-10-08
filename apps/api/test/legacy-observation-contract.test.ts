import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PublishingAccount, SupplyGateReader } from "../src/supply/publishing";
import {
  recordLegacyObservation,
  resolveLegacyObservationToDraft,
  normalizeLegacyObservationInput,
  legacyResourceBaseQuantity,
  convertLegacyDeltaInventory,
  type LegacyObservationInput,
} from "../src/supply/legacy-observation";

test("legacy resource conversion keeps unknown, zero, ammunition groups and insurance generations separate", () => {
  assert.deepEqual(legacyResourceBaseQuantity("level6_bullet_num","2"),{quantity:"120",unit:"ROUND"});
  for(const field of ["awm_bullet_num","barrett_bullet_num"]) assert.deepEqual(legacyResourceBaseQuantity(field,"2"),{quantity:"2",unit:"ROUND"});
  assert.deepEqual(legacyResourceBaseQuantity("coffee_num","0"),{quantity:"0",unit:"PIECE"});
  assert.deepEqual(legacyResourceBaseQuantity("coffee_num",null),{quantity:null,unit:"PIECE"});
  assert.deepEqual(legacyResourceBaseQuantity("top_insure_card_num","3"),{quantity:"3",unit:"UNKNOWN"});
  assert.deepEqual(legacyResourceBaseQuantity("top_insure_card_num","0"),{quantity:"0",unit:"UNKNOWN"});
  assert.deepEqual(legacyResourceBaseQuantity("top_insure_card_num","3","DAY"),{quantity:"3",unit:"DAY"});
  assert.deepEqual(legacyResourceBaseQuantity("top_insure_card_num","3","CARD_COUNT"),{quantity:"3",unit:"PIECE"});
  for(const value of ["-5","1.5","01",1.5]) assert.throws(()=>legacyResourceBaseQuantity("level6_bullet_num",value));
  assert.deepEqual(legacyResourceBaseQuantity("level6_bullet_num","2"),legacyResourceBaseQuantity("level6_bullet_num","2"));
});

test("restored account resources bind exact catalog identities, preserve old DAY and never take the new card identity",()=>{
  const row={haff:"60000000",level6_bullet_num:"2",awm_bullet_num:"3",barrett_bullet_num:"4",level6_armor_num:"0",level6_helmet_num:null,coffee_num:"1",top_insure_card_num:"3"};
  const source={sourceSystem:"legacy_mysql_restore",sourceEntity:"la_rental_accounts",legacyId:"account-1",row};
  const catalog=[['haff_base','HAFF_BASE'],['level6_round','ROUND'],['awm_round','ROUND'],['df_billable_barrett_bullet','ROUND'],['level6_armor','PIECE'],['level6_helmet','PIECE'],['coffee','PIECE'],['df_billable_top_insure_card','DAY'],['top_insure_card_piece','PIECE']].map(([code,unit])=>({id:code!,code:code!,unit:unit!,quantityScale:0}));
  const result=convertLegacyDeltaInventory(source,catalog);
  assert.deepEqual(result.pending,[]);
  const quantity=(id:string)=>result.inventory.find(item=>item.itemId===id)?.quantity;
  assert.equal(quantity('level6_round'),'120');assert.equal(quantity('df_billable_barrett_bullet'),'4');
  assert.equal(quantity('level6_armor'),'0');assert.equal(quantity('level6_helmet'),null);
  assert.equal(quantity('df_billable_top_insure_card'),'3');assert.equal(quantity('top_insure_card_piece'),undefined);
  assert.deepEqual(convertLegacyDeltaInventory(source,catalog),result);
  const missing={...source,row:{...row}};delete (missing.row as Partial<typeof row>).barrett_bullet_num;
  assert.equal(convertLegacyDeltaInventory(missing,catalog).pending[0]?.reason,'SOURCE_FIELD_MISSING');
  assert.equal(convertLegacyDeltaInventory(source,catalog.filter(item=>item.code!=='df_billable_top_insure_card')).pending[0]?.reason,'CATALOG_ITEM_MISSING');
  assert.equal(convertLegacyDeltaInventory(source,catalog.map(item=>item.code==='df_billable_top_insure_card'?{...item,unit:'PIECE'}:item)).pending[0]?.reason,'CATALOG_UNIT_MISMATCH');
  assert.throws(()=>convertLegacyDeltaInventory({...source,sourceEntity:'la_order'},catalog));
});

const DIGEST = "a".repeat(64);
const ACTOR = { id: "admin-1", sessionId: "session-1", requestId: "request-1" };
const FREE_GATE: SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "fixture:free" });

function declaration() {
  return {
    title: "历史来源候选",
    description: "保留来源说明",
    attributes: {
      safe_box_code: "box-a",
      vit_level: 6,
      bear_level: 6,
      secret_kd: "1.25",
      rentalPricing: { rentalMode: "custom" as const, ownerRatioB: "46" },
    },
    skins: ["skin-a"],
    entitlements: [
      { entitlementId: "ent-a", value: true, expiresAt: null, expiryKnowledge: "UNKNOWN" as const },
    ],
    mediaBindings: [{ assetId: "asset-a", position: 0 }],
    termOptionCode: "daily-10m",
    pricingOptionCode: "",
  };
}

function input(overrides: Partial<LegacyObservationInput> = {}): LegacyObservationInput {
  return {
    sourceSystem: "legacy_mysql_restore",
    sourceEntity: "la_rental_accounts",
    legacyId: "source-1",
    evidenceRef: "real-source-4/restricted/source-owner-proof.json",
    sourceDigest: DIGEST,
    inventory: [
      { itemId: "item-z", quantity: null },
      { itemId: "item-a", quantity: "0" },
    ],
    declaration: declaration(),
    ...overrides,
  };
}

function resolution(overrides: Record<string, unknown> = {}) {
  return {
    sourceSystem: "legacy_mysql_restore",
    sourceEntity: "la_rental_accounts",
    legacyId: "source-1",
    sourceDigest: DIGEST,
    expectedObservationVersionId: "observation_1",
    expectedOwnerUserId: "user-1",
    expectedGameId: "game-delta",
    ...overrides,
  };
}

function account(id = "account-1", owner = "user-1"): PublishingAccount {
  return {
    id,
    owner_user_id: owner,
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

type Version = {
  id: string;
  account_id: string;
  sequence: string;
  origin: string;
  review_state: string;
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  term_option_code: string;
  pricing_option_code: string;
  schema_version: number;
};

type ChildRow = Record<string, unknown> & { version_id: string };

class FakeClient {
  readonly accounts = new Map<string, PublishingAccount>([["account-1", account()]]);
  readonly maps = new Map<string, { source_digest: string; account_id: string; version_id: string; evidence_ref: string }>();
  readonly versions = new Map<string, Version>();
  readonly children = new Map<string, ChildRow[]>();
  readonly idempotency = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>();
  readonly queries: string[] = [];
  nativeInsertBindings: unknown[] | undefined;
  permission = true;
  scope = true;
  failNextIdempotencyRead = false;
  failNextLegacyMapRead = false;

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.includes("idempotency_record") && sql.startsWith("SELECT")) {
      if (this.failNextIdempotencyRead) {
        this.failNextIdempotencyRead = false;
        throw new Error("simulated UNKNOWN idempotency read");
      }
      const row = this.idempotency.get(`${values[0]}|${values[1]}`);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("admin_security")) {
      return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false } as T], rowCount: 1 };
    }
    if (sql.includes('SELECT "suspended" FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false } as T], rowCount: 1 };
    if (sql.includes("user_identity_state")) return { rows: [], rowCount: 0 };
    if (sql.includes("game_service_operation")) return { rows: [{ id: "service-1", gameId: "game-delta", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1", supported: true } as T], rowCount: 1 };
    if (sql.includes("role_permissions") || sql.includes("admin_user_permission")) {
      return { rows: this.permission ? [{ permissionCode: "supply.catalog.manage" } as T] : [], rowCount: this.permission ? 1 : 0 };
    }
    if (sql.includes("admin_supply_scope")) return { rows: this.scope ? [{ one: 1 } as T] : [], rowCount: this.scope ? 1 : 0 };
    if (sql.includes("SELECT id FROM zzsh_auth_user")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT id FROM zzsh_supply.game")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM zzsh_supply.rental_account") && sql.includes("WHERE id=$1")) {
      const row = this.accounts.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM zzsh_supply.legacy_supply_map")) {
      if (this.failNextLegacyMapRead) {
        this.failNextLegacyMapRead = false;
        throw new Error("simulated committed-write read failure");
      }
      const key = `${values[0]}|${values[1]}|${values[2]}`;
      const row = this.maps.get(key);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id,account_id,sequence,origin,review_state")) {
      const row = this.versions.get(String(values[0]));
      return { rows: row && row.account_id === values[1] ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id,origin,review_state FROM zzsh_supply.listing_version")) {
      const row = [...this.versions.values()].find((candidate) => candidate.account_id === values[0] && candidate.sequence === values[1]);
      return { rows: row ? [{ id: row.id, origin: row.origin, review_state: row.review_state } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT item_id AS "itemId"')) {
      const rows = (this.children.get("inventory_line") ?? []).filter((row) => row.version_id === String(values[0]));
      return { rows: rows.map(({ version_id: _versionId, item_id: itemId, quantity }) => ({ itemId, quantity }) as T), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT skin_id AS "skinId"')) {
      const rows = (this.children.get("listing_skin") ?? []).filter((row) => row.version_id === String(values[0]));
      return { rows: rows.map(({ version_id: _versionId, skin_id: skinId }) => ({ skinId }) as T), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT entitlement_id AS "entitlementId"')) {
      const rows = (this.children.get("listing_entitlement") ?? []).filter((row) => row.version_id === String(values[0]));
      return {
        rows: rows.map(({ version_id: _versionId, entitlement_id: entitlementId, value, expires_at: expiresAt, expiry_knowledge: expiryKnowledge }) => ({ entitlementId, value, expiresAt, expiryKnowledge }) as T),
        rowCount: rows.length,
      };
    }
    if (sql.startsWith('SELECT asset_id AS "assetId"')) {
      const rows = (this.children.get("listing_media") ?? []).filter((row) => row.version_id === String(values[0]));
      return { rows: rows.map(({ version_id: _versionId, asset_id: assetId, position }) => ({ assetId, position }) as T), rowCount: rows.length };
    }
    if (sql.includes("COALESCE(MAX(sequence)")) return { rows: [{ next: "2" } as T], rowCount: 1 };
    if (sql.startsWith("INSERT INTO zzsh_supply.listing_version")) {
      if (sql.includes("'NATIVE'")) {
        const id = String(values[0]);
        this.nativeInsertBindings = [...values];
        const sequence = String(values[1]);
        const oldId = String(values[2]);
        const accountId = String(values[3]);
        const old = this.versions.get(oldId);
        this.versions.set(id, { ...old!, id, account_id: accountId, sequence, origin: "NATIVE", review_state: "DRAFT" });
      } else {
        const id = String(values[0]);
        const accountId = String(values[1]);
        const description = values[3] == null ? null : String(values[3]);
        this.versions.set(id, { id, account_id: accountId, sequence: "1", origin: "LEGACY_OBSERVATION", review_state: "DRAFT", title: String(values[2]), description, attributes: values[4] as Record<string, unknown>, term_option_code: String(values[5]), pricing_option_code: String(values[6]), schema_version: Number(values[7]) });
      }
      return { rows: [], rowCount: 1 };
    }
    for (const table of ["inventory_line", "listing_skin", "listing_entitlement", "listing_media"] as const) {
      if (sql.startsWith(`INSERT INTO zzsh_supply.${table}(`) && !sql.includes("SELECT $1")) {
        const fields = sql.slice(`INSERT INTO zzsh_supply.${table}(`.length).split(")")[0]!.split(",");
        const row: ChildRow = { version_id: String(values[0]) };
        fields.forEach((field, index) => {
          const value = values[index];
          row[field] = field === "value" && typeof value === "string" ? JSON.parse(value) : value;
        });
        const rows = this.children.get(table) ?? [];
        rows.push(row);
        this.children.set(table, rows);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith(`INSERT INTO zzsh_supply.${table}(`) && sql.includes("SELECT $1")) {
        const sourceId = String(values[1]);
        const rows = this.children.get(table) ?? [];
        rows.push(...rows.filter((row) => row.version_id === sourceId).map((row) => ({ ...row, version_id: String(values[0]) })));
        this.children.set(table, rows);
        return { rows: [], rowCount: 1 };
      }
    }
    if (sql.startsWith("UPDATE zzsh_supply.listing_version SET review_state")) {
      const row = this.versions.get(String(values[0]));
      if (row) row.review_state = "IMPORTED_UNVERIFIED";
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO zzsh_supply.legacy_supply_map")) {
      const sourceSystem = String(values[0]);
      const sourceEntity = String(values[1]);
      const legacyId = String(values[2]);
      const accountId = String(values[3]);
      const versionId = String(values[4]);
      const evidenceRef = String(values[5]);
      const sourceDigest = String(values[6]);
      this.maps.set(`${sourceSystem}|${sourceEntity}|${legacyId}`, { source_digest: sourceDigest, account_id: accountId, version_id: versionId, evidence_ref: evidenceRef });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE zzsh_supply.rental_account")) {
      const accountId = String(values[0]);
      const versionId = String(values[1]);
      const row = this.accounts.get(accountId)!;
      row.current_version_id = versionId;
      row.legacy_hold = sql.includes("legacy_hold='NONE'") ? "NONE" : "UNRESOLVED";
      row.revision = String(Number(row.revision) + 1);
      return { rows: sql.includes("RETURNING") ? [{ id: accountId } as T] : [], rowCount: 1 };
    }
    if (sql.includes("audit_event")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO \"zzsh_supply\".\"idempotency_record\"")) {
      this.idempotency.set(`${values[0]}|${values[1]}`, { requestFingerprint: String(values[2]), responseStatus: Number(values[3]), responseBody: JSON.parse(String(values[4])), publishRequired: Boolean(values[5]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${sql}`);
  }
}

function asClient(fake: FakeClient) {
  return fake as unknown as import("pg").PoolClient;
}

test("complete observation normalizes target fields, keeps null distinct from zero, and is stable", () => {
  const first = normalizeLegacyObservationInput(input());
  const second = normalizeLegacyObservationInput(input({ inventory: [...input().inventory].reverse() }));
  assert.deepEqual(first, second);
  assert.equal(first.inventory.find((item) => item.itemId === "item-a")?.quantity, "0");
  assert.equal(first.inventory.find((item) => item.itemId === "item-z")?.quantity, null);
  assert.equal(first.declaration?.attributes.secret_kd, "1.25");
  const rentalPricing = first.declaration?.attributes.rentalPricing;
  assert.equal(typeof rentalPricing === "object" && rentalPricing !== null && "rentalMode" in rentalPricing, true);
});

test("legacy normalizer rejects illegal quantity, attributes, money-like ratio, and duplicate child", () => {
  assert.throws(() => normalizeLegacyObservationInput(input({ inventory: [{ itemId: "item-a", quantity: "1".repeat(25) }] })));
  assert.throws(() => normalizeLegacyObservationInput(input({ declaration: { ...declaration(), attributes: { ...declaration().attributes, unknown: true } } })));
  assert.throws(() => normalizeLegacyObservationInput(input({ declaration: { ...declaration(), attributes: { ...declaration().attributes, rentalPricing: { rentalMode: "custom", ownerRatioB: "NaN" } } } })));
  assert.throws(() => normalizeLegacyObservationInput(input({ declaration: { ...declaration(), skins: ["skin-a", "skin-a"] } })));
  assert.throws(() => normalizeLegacyObservationInput(input({ declaration: { ...declaration(), mediaBindings: [{ assetId: "asset-a", position: 0 }, { assetId: "asset-b", position: 0 }] } })));
});

test("inventory-only observation remains compatible and creates exactly one observation", async () => {
  const fake = new FakeClient();
  const old = input({ declaration: undefined, inventory: [{ itemId: "item-a", quantity: null }] });
  const first = await recordLegacyObservation(asClient(fake), "account-1", old, ACTOR);
  const second = await recordLegacyObservation(asClient(fake), "account-1", old, ACTOR);
  assert.equal(first, second);
  assert.equal(fake.versions.size, 1);
  assert.equal(fake.maps.size, 1);
  assert.equal(fake.accounts.get("account-1")?.legacy_hold, "UNRESOLVED");
});

test("same source replay is stable; changed content, digest, or target conflicts", async () => {
  const fake = new FakeClient();
  const original = input({ declaration: undefined });
  await recordLegacyObservation(asClient(fake), "account-1", original, ACTOR);
  await assert.rejects(() => recordLegacyObservation(asClient(fake), "account-1", { ...original, inventory: [{ itemId: "item-a", quantity: "1" }] }, ACTOR));
  await assert.rejects(() => recordLegacyObservation(asClient(fake), "account-1", { ...original, sourceDigest: "b".repeat(64) }, ACTOR));
  fake.accounts.set("account-2", account("account-2", "user-2"));
  await assert.rejects(() => recordLegacyObservation(asClient(fake), "account-2", original, ACTOR));
});

test("same source and digest only replays equivalent normalized content across admins", async () => {
  const fake = new FakeClient();
  const original = input();
  const first = await recordLegacyObservation(asClient(fake), "account-1", original, ACTOR);
  const otherAdmin = { ...ACTOR, id: "admin-2", requestId: "request-2" };
  assert.equal(await recordLegacyObservation(asClient(fake), "account-1", original, otherAdmin), first);
  await assert.rejects(() => recordLegacyObservation(asClient(fake), "account-1", {
    ...original,
    declaration: { ...declaration(), title: "跨管理员变更" },
  }, otherAdmin), /content conflicts/);
  assert.equal(fake.versions.size, 1);
});

test("same-body replay ignores media binding object key order", async () => {
  const fake = new FakeClient();
  const reordered = input({
    declaration: {
      ...declaration(),
      mediaBindings: [{ position: 0, assetId: "asset-a" }],
    },
  });
  const first = await recordLegacyObservation(asClient(fake), "account-1", reordered, ACTOR);
  assert.equal(await recordLegacyObservation(asClient(fake), "account-1", reordered, ACTOR), first);
});

test("same-body replay ignores entitlement object key order", async () => {
  const fake = new FakeClient();
  const reordered = input({
    declaration: {
      ...declaration(),
      entitlements: [{
        expiryKnowledge: "UNKNOWN" as const,
        expiresAt: null,
        value: true,
        entitlementId: "ent-a",
      }],
    },
  });
  const first = await recordLegacyObservation(asClient(fake), "account-1", reordered, ACTOR);
  assert.equal(await recordLegacyObservation(asClient(fake), "account-1", reordered, ACTOR), first);
});

test("permission and scope are checked before a write", async () => {
  const noPermission = new FakeClient();
  noPermission.permission = false;
  await assert.rejects(() => recordLegacyObservation(asClient(noPermission), "account-1", input(), ACTOR), /Permission required/);
  assert.equal(noPermission.versions.size, 0);
  const noScope = new FakeClient();
  noScope.scope = false;
  await assert.rejects(() => recordLegacyObservation(asClient(noScope), "account-1", input(), ACTOR));
  assert.equal(noScope.versions.size, 0);
});

test("resolver uses the legal target account, creates one native draft, and replays without a second draft", async () => {
  const fake = new FakeClient();
  const observed = await recordLegacyObservation(asClient(fake), "account-1", input(), ACTOR);
  const first = await resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, FREE_GATE);
  const second = await resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, FREE_GATE);
  assert.equal(first.status, "DRAFT");
  assert.deepEqual(second, first);
  assert.equal(fake.versions.size, 2);
  assert.equal(fake.accounts.get("account-1")?.legacy_hold, "NONE");
  assert.equal(fake.accounts.get("account-1")?.current_version_id, first.versionId);
  assert.equal(fake.queries.filter((sql) => sql.startsWith("INSERT INTO zzsh_supply.listing_version")).length, 2);
  assert.deepEqual(fake.nativeInsertBindings, [first.versionId, "2", observed, "account-1"]);
  assert.match(fake.queries.find((sql) => sql.includes("'NATIVE'"))!, /SELECT \$1,account_id,\$2/);
  const observedVersion = fake.versions.get(observed)!;
  const draftVersion = fake.versions.get(first.versionId)!;
  assert.deepEqual({ title: draftVersion.title, description: draftVersion.description, attributes: draftVersion.attributes, term: draftVersion.term_option_code, pricing: draftVersion.pricing_option_code, schema: draftVersion.schema_version }, { title: observedVersion.title, description: observedVersion.description, attributes: observedVersion.attributes, term: observedVersion.term_option_code, pricing: observedVersion.pricing_option_code, schema: observedVersion.schema_version });
  for (const table of ["inventory_line", "listing_skin", "listing_entitlement", "listing_media"]) {
    const rows = fake.children.get(table) ?? [];
    assert.deepEqual(rows.filter((row) => row.version_id === first.versionId).map(({ version_id: _versionId, ...row }) => row), rows.filter((row) => row.version_id === observed).map(({ version_id: _versionId, ...row }) => row));
  }
});

test("cached resolver replay rechecks the current account version and legacy hold", async () => {
  const fake = new FakeClient();
  const observed = await recordLegacyObservation(asClient(fake), "account-1", input(), ACTOR);
  const first = await resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, FREE_GATE);
  const accountRow = fake.accounts.get("account-1")!;
  fake.versions.set("listing-later", { ...fake.versions.get(first.versionId)!, id: "listing-later", sequence: "3", origin: "NATIVE", review_state: "DRAFT" });
  accountRow.current_version_id = "listing-later";
  accountRow.legacy_hold = "NONE";
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, FREE_GATE), /version changed/);
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), { ...ACTOR, id: "admin-2", requestId: "request-2" }, FREE_GATE), /version changed/);
  accountRow.current_version_id = first.versionId;
  accountRow.legacy_hold = "UNRESOLVED";
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, FREE_GATE), /Legacy hold/);
});

test("resolver rejects wrong owner, wrong account version, and wrong observation version", async () => {
  const wrongOwner = new FakeClient();
  const wrongOwnerObserved = await recordLegacyObservation(asClient(wrongOwner), "account-1", input(), ACTOR);
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(wrongOwner), "account-1", resolution({ expectedObservationVersionId: wrongOwnerObserved, expectedOwnerUserId: "user-other" }), ACTOR, FREE_GATE));
  assert.equal(wrongOwner.versions.size, 1);

  const changed = new FakeClient();
  const changedObserved = await recordLegacyObservation(asClient(changed), "account-1", input(), ACTOR);
  changed.accounts.get("account-1")!.current_version_id = "native-existing";
  changed.accounts.get("account-1")!.legacy_hold = "UNRESOLVED";
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(changed), "account-1", resolution({ expectedObservationVersionId: changedObserved }), ACTOR, FREE_GATE));
  assert.equal(changed.versions.size, 1);

  const wrongVersion = new FakeClient();
  await recordLegacyObservation(asClient(wrongVersion), "account-1", input(), ACTOR);
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(wrongVersion), "account-1", resolution({ expectedObservationVersionId: "observation-other" }), ACTOR, FREE_GATE));
  assert.equal(wrongVersion.versions.size, 1);
});

test("resolver preserves existing active-service and occupancy guards", async () => {
  const fake = new FakeClient();
  const observed = await recordLegacyObservation(asClient(fake), "account-1", input(), ACTOR);
  const occupied: SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "OCCUPIED", reference: "fixture:occupied" });
  await assert.rejects(() => resolveLegacyObservationToDraft(asClient(fake), "account-1", resolution({ expectedObservationVersionId: observed }), ACTOR, occupied));
  assert.equal(fake.versions.size, 1);
  assert.equal(fake.accounts.get("account-1")?.legacy_hold, "UNRESOLVED");
});

test("replay reauthorizes after revocation and recovers UNKNOWN/read failure with the original intent", async () => {
  const unknown = new FakeClient();
  unknown.failNextIdempotencyRead = true;
  await assert.rejects(() => recordLegacyObservation(asClient(unknown), "account-1", input(), ACTOR), /UNKNOWN idempotency read/);
  assert.equal(unknown.versions.size, 0);
  const observed = await recordLegacyObservation(asClient(unknown), "account-1", input(), ACTOR);
  unknown.permission = false;
  await assert.rejects(() => recordLegacyObservation(asClient(unknown), "account-1", input(), ACTOR), /Permission required/);
  assert.equal(unknown.versions.size, 1);

  const readFailure = new FakeClient();
  const committed = await recordLegacyObservation(asClient(readFailure), "account-1", input(), ACTOR);
  readFailure.failNextLegacyMapRead = true;
  await assert.rejects(() => recordLegacyObservation(asClient(readFailure), "account-1", input(), ACTOR), /committed-write read failure/);
  assert.equal(await recordLegacyObservation(asClient(readFailure), "account-1", input(), ACTOR), committed);
  assert.equal(readFailure.versions.size, 1);
  assert.equal(observed.length > 0, true);
});
