import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import type { PoolClient } from "pg";
import * as adminAuthorization from "../src/auth/admin-authorization";
import * as adminScope from "../src/auth/admin-scope";
import * as authSecurity from "../src/auth/auth-security";
import * as userIdentity from "../src/auth/user-identity";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { projectFrozenInventory, projectOrderTerms, projectOrderTeamMembers, readOrderTeamAccess, terminalSendWindow, type OrderTeamActor, type OrderTeamMemberRow } from "../src/im/order-team-access";

test("order member avatars use managed paths and never resurrect legacy external images", () => {
  const base = { party: "BUYER", state: "JOINED", platform_subject_id: "user_1", identity_kind: "USER", realm: "user", account_id: "im_user_1", status: "READY", identity_marker: "fixture", name: "User" } as const;
  for (const [image, expected] of [["/api/v1/profile/avatars/user/user_1/2", "/api/v1/profile/avatars/user/user_1/2"], ["https://legacy.invalid/avatar.png", null], ["/api/v1/profile/avatars/user/../2", null], [null, null]] as const) {
    const result = projectOrderTeamMembers([{ ...base, avatar: image } as OrderTeamMemberRow], null, "user");
    assert.equal(result[0]?.avatar, expected);
  }
  const admin = projectOrderTeamMembers([{ ...base, party: "STAFF", realm: "admin", identity_kind: "ADMIN", avatar: "/api/v1/profile/avatars/admin/admin_1/1" } as OrderTeamMemberRow], null, "admin");
  assert.equal(admin[0]?.avatar, "/api/v1/profile/avatars/admin/admin_1/1");
});

test("frozen inventory projection whitelists order snapshot lines and never invents stock", () => {
  const snapshot = {
    lines: [
      { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", buyerAmount: { currency: "CNY", unit: "yuan", amount: "9.99", scale: 2 } },
      { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT" },
    ],
  };
  const projected = projectFrozenInventory(snapshot, new Map([["item_haff", "哈夫币"]]));
  assert.deepEqual(projected, [
    { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
    { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT", name: null },
  ]);
  assert.equal(JSON.stringify(projected).includes("9.99"), false, "no buyer/owner amounts leak into the inventory projection");
  assert.equal(JSON.stringify(projected).includes("buyerAmount"), false);
});

test("frozen inventory projection rejects malformed or unknown lines instead of guessing", () => {
  assert.deepEqual(projectFrozenInventory(null, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: "not-an-array" }, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: [null, { itemId: "only-id" }, { itemId: "bad id", quantity: "1", unit: "ROUND", pricingKind: "PER_UNIT" }, { itemId: "ok", quantity: "-1", unit: "ROUND", pricingKind: "PER_UNIT" }, { itemId: "ok2", quantity: "1.5", unit: "ROUND", pricingKind: "PER_UNIT" }] }, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: [] }, new Map()), []);
});

const HOUR = 60 * 60 * 1000;
const APP_ID = "app_order_team_projection";
const ORDER_ID = "order_projection_1";
const RENTER = "user_renter_projection";
const OWNER = "user_owner_projection";
const STAFF = "admin_staff_projection";
const userActor: OrderTeamActor = { realm: "user", userId: RENTER, sessionId: "user_session_projection" };
const adminActor: OrderTeamActor = { realm: "admin", userId: STAFF, sessionId: "admin_session_projection" };

function identity(realm: "user" | "admin", kind: "USER" | "ADMIN", subject: string) {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm, kind, platformSubjectId: subject };
  return { accountId: deriveYunxinAccountId(key), marker: buildYunxinIdentityMarker(key) };
}
function member(party: string, realm: "user" | "admin", kind: "USER" | "ADMIN", subject: string) {
  const { accountId, marker } = identity(realm, kind, subject);
  return { party, state: "JOINED", platform_subject_id: subject, identity_kind: kind, realm, account_id: accountId, status: "READY", identity_marker: marker, name: subject, avatar: null };
}
const MEMBERS = [member("RENTER", "user", "USER", RENTER), member("OWNER", "user", "USER", OWNER), member("STAFF", "admin", "ADMIN", STAFF)];

type Fixture = {
  orderStatus: string; postedAt?: Date | string | null; cancelledAt?: Date | string | null;
  teamState?: "READY" | "CREATING" | "PENDING" | "NEEDS_REVIEW" | null; provisionState?: string | null;
  termSeconds?: string | number | null;
  opening?: { id: string; status: "DRAFT" | "CONFIRMED"; confirmedAt?: Date | string | null } | null;
  acks?: Array<"RENTER" | "OWNER">;
  intakeOpen?: boolean; currentSettlement?: boolean;
  quoteSnapshot?: unknown; itemNames?: Array<{ id: string; name: string }>;
  stageCards?: Array<Record<string, unknown>>;
};
function client(fixture: Fixture): PoolClient {
  const teamState = fixture.teamState === undefined ? "READY" : fixture.teamState;
  const row = {
    app_id: teamState === null ? null : APP_ID, team_id: teamState === null ? null : "team_projection_1",
    team_name: teamState === null ? null : "三角洲行动|订单:ZZPROJECT", team_state: teamState,
    renter_user_id: RENTER, owner_user_id: OWNER, game_id: "game_projection", display_no: "ZZPROJECT",
    order_status: fixture.orderStatus, order_cancelled_at: fixture.cancelledAt ?? null,
    settlement_posted_at: fixture.postedAt ?? null, title: "三角洲账号", account_id: "account_projection",
    term_seconds: fixture.termSeconds === undefined ? "2592000" : fixture.termSeconds,
    opening_id: fixture.opening?.id ?? null, opening_status: fixture.opening?.status ?? null,
    opening_confirmed_at: fixture.opening?.confirmedAt ?? null,
    intake_open: fixture.intakeOpen ?? false, settlement_current: fixture.currentSettlement ?? false,
    quote_snapshot: fixture.quoteSnapshot ?? null, game_name: "三角洲行动", provision_state: fixture.provisionState ?? null, assigned_admin_id: null,
    escalation_responsible_admin_id: null, escalation_first_response_at: null, escalation_remind_due_at: null,
    escalation_add_round: null, escalation_state_projection: null,
  };
  return { async query(sql: string) {
    if (sql.includes("FROM zzsh_order.rental_order o JOIN zzsh_supply.game game")) return { rows: [row] };
    if (sql.includes("FROM zzsh_order.im_order_member mm")) return { rows: MEMBERS };
    if (sql.includes("FROM zzsh_order.rental_opening_ack")) return { rows: (fixture.acks ?? []).map(party => ({ party })) };
    if (sql.includes("FROM zzsh_supply.billable_item")) return { rows: fixture.itemNames ?? [] };
    if (sql.includes("FROM zzsh_order.im_order_stage_card sc")) return { rows: fixture.stageCards ?? [] };
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
}
function mockUserContext(t: TestContext) {
  t.mock.method(userIdentity, "assertUserContextInTransaction", async () => {});
}
function mockAdminContext(t: TestContext, permissions: string[]) {
  t.mock.method(authSecurity, "assertAdminContextInTransaction", async () => {});
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: true, passwordChangeRequired: false, permissions: new Set(permissions) }));
  t.mock.method(adminScope, "readAdminGameScope", async () => ({ mode: "ALL_GAMES", gameIds: [] }));
}
const forbidden = (error: unknown) => (error as { status?: number }).status === 403;

test("COMPLETED 71h after posting still lets both sides send, with the exact sendUntil projection", async t => {
  mockUserContext(t);
  const postedAt = new Date(Date.now() - 71 * HOUR);
  const view = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), userActor, ORDER_ID);
  assert.equal(view.orderStatus, "COMPLETED");
  assert.equal(view.canRead, true);
  assert.equal(view.canSend, true);
  assert.equal(view.orderEndedAt, postedAt.toISOString());
  assert.equal(view.sendUntil, new Date(postedAt.getTime() + 72 * HOUR).toISOString());
});

test("COMPLETED 73h after posting stays readable but send is denied with 403", async t => {
  mockUserContext(t);
  const postedAt = new Date(Date.now() - 73 * HOUR);
  const view = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), { ...userActor, userId: OWNER }, ORDER_ID);
  assert.equal(view.canRead, true);
  assert.equal(view.canSend, false);
  assert.equal(view.sendUntil, new Date(postedAt.getTime() + 72 * HOUR).toISOString());
  await assert.rejects(readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), userActor, ORDER_ID, "send"), forbidden);
});

test("CANCELLED uses cancelled_at for the window and turns send into 403 after 72h", async t => {
  mockUserContext(t);
  const inside = new Date(Date.now() - 71 * HOUR);
  const open = await readOrderTeamAccess(client({ orderStatus: "CANCELLED", cancelledAt: inside }), userActor, ORDER_ID);
  assert.equal(open.canRead, true);
  assert.equal(open.canSend, true);
  assert.equal(open.orderEndedAt, inside.toISOString());
  assert.equal(open.sendUntil, new Date(inside.getTime() + 72 * HOUR).toISOString());
  const outside = new Date(Date.now() - 73 * HOUR);
  const expired = await readOrderTeamAccess(client({ orderStatus: "CANCELLED", cancelledAt: outside.toISOString() }), userActor, ORDER_ID);
  assert.equal(expired.canRead, true);
  assert.equal(expired.canSend, false);
  assert.equal(expired.sendUntil, new Date(outside.getTime() + 72 * HOUR).toISOString());
  await assert.rejects(readOrderTeamAccess(client({ orderStatus: "CANCELLED", cancelledAt: outside }), userActor, ORDER_ID, "send"), forbidden);
});

test("terminal orders without their end timestamp fail closed for send but remain readable", async t => {
  mockUserContext(t);
  for (const fixture of [{ orderStatus: "COMPLETED" }, { orderStatus: "CANCELLED" }] as Fixture[]) {
    const view = await readOrderTeamAccess(client(fixture), userActor, ORDER_ID);
    assert.equal(view.canRead, true);
    assert.equal(view.canSend, false);
    assert.equal(view.orderEndedAt, null);
    assert.equal(view.sendUntil, null);
    await assert.rejects(readOrderTeamAccess(client(fixture), userActor, ORDER_ID, "send"), forbidden);
  }
});

test("active orders project no end window and keep the existing send permission", async t => {
  mockUserContext(t);
  const view = await readOrderTeamAccess(client({ orderStatus: "PAID" }), userActor, ORDER_ID);
  assert.equal(view.canRead, true);
  assert.equal(view.canSend, true);
  assert.equal(view.orderEndedAt, null);
  assert.equal(view.sendUntil, null);
});

test("admin send permission still stacks with the 72h window", async t => {
  mockAdminContext(t, ["im.support.read"]);
  const postedAt = new Date(Date.now() - 1 * HOUR);
  const noAccept = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), adminActor, ORDER_ID);
  assert.equal(noAccept.canRead, true);
  assert.equal(noAccept.canSend, false);
  await assert.rejects(readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), adminActor, ORDER_ID, "send"), forbidden);
  t.mock.restoreAll();
  mockAdminContext(t, ["im.support.read", "im.support.accept"]);
  const accepted = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), adminActor, ORDER_ID);
  assert.equal(accepted.canSend, true);
  const expired = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt: new Date(Date.now() - 73 * HOUR) }), adminActor, ORDER_ID);
  assert.equal(expired.canSend, false);
});

const TERM_SECONDS = 7 * 24 * 60 * 60;

test("pre-team stages project PENDING_PAYMENT, WAITING_STAFF, and TEAM_PENDING", async t => {
  mockUserContext(t);
  const unpaid = await readOrderTeamAccess(client({ orderStatus: "PENDING_PAYMENT", teamState: null }), userActor, ORDER_ID);
  assert.equal(unpaid.stage, "PENDING_PAYMENT");
  assert.equal(unpaid.openingState, "NONE");
  assert.equal(unpaid.endState, "NONE");
  assert.equal(unpaid.rentalStartedAt, null);
  assert.deepEqual(unpaid.openingAcks, { renter: false, owner: false });
  const unassigned = await readOrderTeamAccess(client({ orderStatus: "PAID", teamState: null }), userActor, ORDER_ID);
  assert.equal(unassigned.stage, "WAITING_STAFF");
  const queued = await readOrderTeamAccess(client({ orderStatus: "PAID", provisionState: "WAITING" }), userActor, ORDER_ID);
  assert.equal(queued.stage, "WAITING_STAFF");
  const building = await readOrderTeamAccess(client({ orderStatus: "PAID", teamState: "CREATING", provisionState: "ASSIGNED" }), userActor, ORDER_ID);
  assert.equal(building.stage, "TEAM_PENDING");
  assert.equal(building.canRead, false);
});

test("a READY team without any opening stays in OPENING_CONFIRM", async t => {
  mockUserContext(t);
  const view = await readOrderTeamAccess(client({ orderStatus: "PAID" }), userActor, ORDER_ID);
  assert.equal(view.stage, "OPENING_CONFIRM");
  assert.equal(view.openingState, "NONE");
  assert.equal(view.rentalStartedAt, null);
  assert.equal(view.dueAt, null);
  assert.deepEqual(view.openingAcks, { renter: false, owner: false });
});

test("opening drafts, partial acks, and confirmation drive openingState plus rental dates", async t => {
  mockUserContext(t);
  const draft = await readOrderTeamAccess(client({ orderStatus: "PAID", opening: { id: "opening_1", status: "DRAFT", confirmedAt: null } }), userActor, ORDER_ID);
  assert.equal(draft.stage, "OPENING_CONFIRM");
  assert.equal(draft.openingState, "DRAFT");
  assert.deepEqual(draft.openingAcks, { renter: false, owner: false });
  assert.equal(draft.rentalStartedAt, null);
  assert.equal(draft.dueAt, null);

  const partial = await readOrderTeamAccess(client({ orderStatus: "PAID", opening: { id: "opening_1", status: "DRAFT" }, acks: ["RENTER"] }), userActor, ORDER_ID);
  assert.equal(partial.stage, "OPENING_CONFIRM");
  assert.equal(partial.openingState, "PARTIAL");
  assert.deepEqual(partial.openingAcks, { renter: true, owner: false });

  const confirmedAt = new Date(Date.now() - 5 * HOUR);
  const confirmed = await readOrderTeamAccess(client({
    orderStatus: "PAID", termSeconds: TERM_SECONDS,
    opening: { id: "opening_1", status: "CONFIRMED", confirmedAt }, acks: ["RENTER", "OWNER"],
  }), userActor, ORDER_ID);
  assert.equal(confirmed.stage, "RENTING");
  assert.equal(confirmed.openingState, "CONFIRMED");
  assert.deepEqual(confirmed.openingAcks, { renter: true, owner: true });
  assert.equal(confirmed.rentalStartedAt, confirmedAt.toISOString());
  assert.equal(confirmed.dueAt, new Date(confirmedAt.getTime() + TERM_SECONDS * 1000).toISOString());
  assert.equal(confirmed.canSend, true);
});

test("an open intake or an unposted settlement version projects ENDING", async t => {
  mockUserContext(t);
  const confirmedAt = new Date(Date.now() - 1 * HOUR);
  const base: Fixture = {
    orderStatus: "PAID", termSeconds: TERM_SECONDS,
    opening: { id: "opening_1", status: "CONFIRMED", confirmedAt }, acks: ["RENTER", "OWNER"],
  };
  const intake = await readOrderTeamAccess(client({ ...base, intakeOpen: true }), userActor, ORDER_ID);
  assert.equal(intake.stage, "ENDING");
  assert.equal(intake.endState, "REQUESTED");
  const version = await readOrderTeamAccess(client({ ...base, currentSettlement: true }), userActor, ORDER_ID);
  assert.equal(version.stage, "ENDING");
  assert.equal(version.endState, "REQUESTED");
});

test("posting completes the projection: SETTLED with a POSTED end state and an intact 72h window", async t => {
  mockUserContext(t);
  const postedAt = new Date(Date.now() - 2 * HOUR);
  const view = await readOrderTeamAccess(client({ orderStatus: "COMPLETED", postedAt }), userActor, ORDER_ID);
  assert.equal(view.stage, "SETTLED");
  assert.equal(view.endState, "POSTED");
  assert.equal(view.canRead, true);
  assert.equal(view.canSend, true);
  assert.equal(view.orderEndedAt, postedAt.toISOString());
  assert.equal(view.sendUntil, new Date(postedAt.getTime() + 72 * HOUR).toISOString());
});

test("cancelled orders project CANCELLED without rental dates", async t => {
  mockUserContext(t);
  const cancelledAt = new Date(Date.now() - 1 * HOUR);
  const view = await readOrderTeamAccess(client({ orderStatus: "CANCELLED", cancelledAt }), userActor, ORDER_ID);
  assert.equal(view.stage, "CANCELLED");
  assert.equal(view.endState, "NONE");
  assert.equal(view.rentalStartedAt, null);
  assert.equal(view.dueAt, null);
  assert.equal(view.canSend, true);
});

const TERMS_HASH = "quote-hash-terms-1";
const money = (amount: string, scale: 2 | 8) => ({ currency: "CNY", unit: "yuan", amount, scale });
const TERMS_QUOTE = {
  schemaVersion: 2, currency: "CNY", priceVersionId: "price_terms", ruleReleaseId: null, mode: "SPREAD",
  lines: [
    { itemId: "item_haff", quantity: "50000000", unit: "HAFF_BASE", unitQuantity: "1000000", pricingKind: "HAFF_RATIO",
      buyerUnitAmount: money("5.20000000", 8), ownerUnitAmount: money("4.80000000", 8),
      buyerAmount: money("260.00", 2), ownerAmount: money("240.00", 2), platformAmount: money("20.00", 2) },
    { itemId: "item_ammo", quantity: "120", unit: "ROUND", unitQuantity: "1", pricingKind: "FIXED_UNIT",
      buyerUnitAmount: money("0.12000000", 8), ownerUnitAmount: money("0.10000000", 8),
      buyerAmount: money("14.40", 2), ownerAmount: money("12.00", 2), platformAmount: money("2.40", 2) },
  ],
  resourceTotal: money("274.40", 2), ownerTotal: money("252.00", 2), platformFullProfit: money("22.40", 2),
  tenantDeposit: money("30.00", 2), publisherBailRequirement: money("300.00", 2),
  termSeconds: "2592000", expiryDisclosures: [], unitAmountsInformational: true, roundingPolicy: "HALF_UP_CENT_V1",
  contentHash: TERMS_HASH,
};
const TERMS_NAMES = new Map([["item_haff", "哈夫币"], ["item_ammo", "巴雷特子弹"]]);
const TERMS_ITEM_ROWS = [...TERMS_NAMES].map(([id, name]) => ({ id, name }));
test("order terms recognize only the specifically marked legacy v3 source", () => {
  const legacy = { ...TERMS_QUOTE, schemaVersion: 3, quoteSource: "LEGACY_QUOTED", legacyQuote: { schema: "legacy-listed-quote-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts" } };
  assert.equal(projectOrderTerms(legacy, TERMS_NAMES, "RENTER").basis, "QUOTE");
  assert.equal(projectOrderTerms({ ...legacy, quoteSource: "OTHER" }, TERMS_NAMES, "RENTER").basis, "UNKNOWN");
  assert.equal(projectOrderTerms({ ...legacy, legacyQuote: { ...legacy.legacyQuote, sourceSystem: "native" } }, TERMS_NAMES, "RENTER").basis, "UNKNOWN");
});
function termsFixture(quoteSnapshot: unknown): Fixture {
  return { orderStatus: "PAID", quoteSnapshot, itemNames: TERMS_ITEM_ROWS };
}

test("renter and owner terms carry only their own side and never the other party's amounts", () => {
  const renter = projectOrderTerms(TERMS_QUOTE, TERMS_NAMES, "RENTER");
  assert.equal(renter.viewerParty, "RENTER");
  assert.equal(renter.basis, "QUOTE");
  assert.equal(renter.currency, "CNY");
  assert.equal(renter.scale, 2);
  assert.equal(renter.version, TERMS_HASH);
  assert.equal(renter.rentalAmount, "27440");
  assert.equal(renter.depositAmount, "3000");
  assert.equal(renter.paidTotal, "30440");
  assert.deepEqual(renter.lines.map(line => [line.itemId, line.name, line.quantity, line.unitPrice, line.amount]), [
    ["item_haff", "哈夫币", "50000000", "520", "26000"],
    ["item_ammo", "巴雷特子弹", "120", "12", "1440"],
  ]);
  const renterJson = JSON.stringify(renter);
  for (const key of ["staff", "buyerUnitPrice", "ownerUnitPrice", "buyerAmount", "ownerAmount", "platformContribution"]) {
    assert.equal(renterJson.includes(key), false, `renter JSON must not contain ${key}`);
  }
  for (const otherSide of ["25200", "30000", "55200", "2240", "24000", "1200", "480"]) {
    assert.equal(renterJson.includes(otherSide), false, `renter JSON must not contain owner amount ${otherSide}`);
  }
  assert.equal(Object.hasOwn(renter, "staff"), false);
  assert.deepEqual(Object.keys(renter.lines[0]!).sort(), ["amount", "itemId", "name", "quantity", "unitPrice"]);

  const owner = projectOrderTerms(TERMS_QUOTE, TERMS_NAMES, "OWNER");
  assert.equal(owner.viewerParty, "OWNER");
  assert.equal(owner.basis, "QUOTE");
  assert.equal(owner.version, TERMS_HASH);
  assert.equal(owner.rentalAmount, "25200");
  assert.equal(owner.depositAmount, "30000");
  assert.equal(owner.paidTotal, "55200");
  assert.deepEqual(owner.lines.map(line => [line.itemId, line.name, line.quantity, line.unitPrice, line.amount]), [
    ["item_haff", "哈夫币", "50000000", "480", "24000"],
    ["item_ammo", "巴雷特子弹", "120", "10", "1200"],
  ]);
  const ownerJson = JSON.stringify(owner);
  for (const key of ["staff", "buyerUnitPrice", "ownerUnitPrice", "buyerAmount", "ownerAmount", "platformContribution"]) {
    assert.equal(ownerJson.includes(key), false, `owner JSON must not contain ${key}`);
  }
  for (const otherSide of ["27440", "30440", "2240", "26000", "1440"]) {
    assert.equal(ownerJson.includes(otherSide), false, `owner JSON must not contain renter amount ${otherSide}`);
  }
  assert.equal(Object.hasOwn(owner, "staff"), false);
  assert.deepEqual(Object.keys(owner.lines[0]!).sort(), ["amount", "itemId", "name", "quantity", "unitPrice"]);

  const digestOnly = projectOrderTerms({ ...TERMS_QUOTE, contentHash: undefined, confirmationDigest: "digest-terms-1" }, TERMS_NAMES, "RENTER");
  assert.equal(digestOnly.basis, "QUOTE");
  assert.equal(digestOnly.version, "digest-terms-1", "a confirmation quote digest is the fallback terms version");
});

test("staff terms expose both sides, per-line spread, and the platform summary", () => {
  const staff = projectOrderTerms(TERMS_QUOTE, TERMS_NAMES, "STAFF");
  assert.equal(staff.viewerParty, "STAFF");
  assert.equal(staff.basis, "QUOTE");
  assert.equal(staff.version, TERMS_HASH);
  assert.equal(staff.rentalAmount, null, "staff has no single viewer side");
  assert.equal(staff.depositAmount, null);
  assert.equal(staff.paidTotal, null);
  assert.deepEqual(staff.staff, {
    buyerRentalAmount: "27440", ownerRentalAmount: "25200", buyerTotal: "30440", ownerTotal: "55200", platformContribution: "2240",
  });
  assert.deepEqual(staff.lines.map(line => [line.itemId, line.unitPrice, line.amount, line.buyerUnitPrice, line.ownerUnitPrice, line.buyerAmount, line.ownerAmount, line.platformContribution]), [
    ["item_haff", null, null, "520", "480", "26000", "24000", "2000"],
    ["item_ammo", null, null, "12", "10", "1440", "1200", "240"],
  ]);
  assert.deepEqual(staff.lines[0]!.name, "哈夫币");
  assert.deepEqual(staff.lines[1]!.quantity, "120");
});

test("terms without a readable double-sided quote stay UNKNOWN with null amounts, never zero", () => {
  const missing = projectOrderTerms(null, new Map(), "RENTER");
  assert.equal(missing.basis, "UNKNOWN");
  assert.equal(missing.version, null);
  assert.equal(missing.rentalAmount, null);
  assert.equal(missing.depositAmount, null);
  assert.equal(missing.paidTotal, null);
  assert.deepEqual(missing.lines, []);

  const brokenLine = {
    ...TERMS_QUOTE,
    lines: [{ ...TERMS_QUOTE.lines[1]!, ownerUnitAmount: undefined }],
    resourceTotal: money("14.40", 2), ownerTotal: money("12.00", 2), platformFullProfit: money("2.40", 2),
  };
  const broken = projectOrderTerms(brokenLine, TERMS_NAMES, "OWNER");
  assert.equal(broken.basis, "UNKNOWN");
  assert.equal(broken.version, TERMS_HASH);
  assert.equal(broken.rentalAmount, null);
  assert.equal(broken.depositAmount, null);
  assert.equal(broken.paidTotal, null);
  assert.deepEqual(broken.lines.map(line => [line.itemId, line.name, line.quantity, line.unitPrice, line.amount]), [
    ["item_ammo", "巴雷特子弹", "120", null, null],
  ]);
  const brokenJson = JSON.stringify(broken);
  assert.equal(brokenJson.includes("\"0\""), false, "missing basis must not be guessed as zero");

  const tampered = {
    ...TERMS_QUOTE,
    lines: [{ ...TERMS_QUOTE.lines[0]!, platformAmount: money("99.99", 2) }, TERMS_QUOTE.lines[1]!],
  };
  const mismatched = projectOrderTerms(tampered, TERMS_NAMES, "STAFF");
  assert.equal(mismatched.basis, "UNKNOWN", "a platform amount that does not equal buyer minus owner is not a reliable split");
  assert.equal(mismatched.staff!.platformContribution, null);
  assert.equal(mismatched.lines[0]!.buyerAmount, null);
  assert.equal(mismatched.lines[0]!.ownerAmount, null);

  const wrongCurrency = projectOrderTerms({ ...TERMS_QUOTE, currency: "USD" }, TERMS_NAMES, "RENTER");
  assert.equal(wrongCurrency.basis, "UNKNOWN");
  assert.equal(wrongCurrency.rentalAmount, null);
});

test("order team summary supplies role-scoped terms to the renter, owner, and staff viewers", async t => {
  mockUserContext(t);
  const renterView = await readOrderTeamAccess(client(termsFixture(TERMS_QUOTE)), userActor, ORDER_ID);
  const renterTerms = renterView.terms as Record<string, any>;
  assert.equal(renterTerms.viewerParty, "RENTER");
  assert.equal(renterTerms.basis, "QUOTE");
  assert.equal(renterTerms.rentalAmount, "27440");
  assert.equal(renterTerms.depositAmount, "3000");
  assert.equal(renterTerms.paidTotal, "30440");
  assert.equal(JSON.stringify(renterTerms).includes("staff"), false);
  assert.equal(JSON.stringify(renterTerms).includes("platformContribution"), false);
  assert.equal(JSON.stringify(renterTerms).includes("25200"), false);
  assert.equal(JSON.stringify(renterTerms).includes("30000"), false);
  assert.equal(renterTerms.lines[0].name, "哈夫币");
  assert.equal(renterView.stage, "OPENING_CONFIRM", "terms do not alter stage");
  assert.equal(renterView.canSend, true, "terms do not alter send permission");

  const ownerView = await readOrderTeamAccess(client(termsFixture(TERMS_QUOTE)), { ...userActor, userId: OWNER }, ORDER_ID);
  const ownerTerms = ownerView.terms as Record<string, any>;
  assert.equal(ownerTerms.viewerParty, "OWNER");
  assert.equal(ownerTerms.rentalAmount, "25200");
  assert.equal(ownerTerms.depositAmount, "30000");
  assert.equal(ownerTerms.paidTotal, "55200");
  assert.equal(ownerTerms.lines[0].unitPrice, "480");
  assert.equal(JSON.stringify(ownerTerms).includes("staff"), false);
  assert.equal(JSON.stringify(ownerTerms).includes("27440"), false);
  assert.equal(JSON.stringify(ownerTerms).includes("30440"), false);
  assert.equal(JSON.stringify(ownerTerms).includes("2240"), false);

  t.mock.restoreAll();
  mockAdminContext(t, ["im.support.read"]);
  const staffView = await readOrderTeamAccess(client(termsFixture(TERMS_QUOTE)), adminActor, ORDER_ID);
  const staffTerms = staffView.terms as Record<string, any>;
  assert.equal(staffTerms.viewerParty, "STAFF");
  assert.equal(staffTerms.basis, "QUOTE");
  assert.deepEqual(staffTerms.staff, {
    buyerRentalAmount: "27440", ownerRentalAmount: "25200", buyerTotal: "30440", ownerTotal: "55200", platformContribution: "2240",
  });
  assert.deepEqual(staffTerms.lines[0], {
    itemId: "item_haff", name: "哈夫币", quantity: "50000000", unitPrice: null, amount: null,
    buyerUnitPrice: "520", ownerUnitPrice: "480", buyerAmount: "26000", ownerAmount: "24000", platformContribution: "2000",
  });
  assert.equal(staffTerms.lines[1].platformContribution, "240");
});

test("order team summary reports UNKNOWN terms when the frozen quote is missing or one-sided", async t => {
  mockUserContext(t);
  const absent = await readOrderTeamAccess(client({ orderStatus: "PAID" }), userActor, ORDER_ID);
  assert.deepEqual(absent.terms, {
    viewerParty: "RENTER", basis: "UNKNOWN", currency: "CNY", scale: 2,
    version: null, rentalAmount: null, depositAmount: null, paidTotal: null, lines: [],
  });
  assert.equal(absent.canRead, true);
  assert.equal(absent.canSend, true);

  const oneSided = {
    ...TERMS_QUOTE,
    lines: [{ ...TERMS_QUOTE.lines[0]!, ownerAmount: undefined }, TERMS_QUOTE.lines[1]!],
  };
  const view = await readOrderTeamAccess(client(termsFixture(oneSided)), userActor, ORDER_ID);
  const terms = view.terms as Record<string, any>;
  assert.equal(terms.basis, "UNKNOWN");
  assert.equal(terms.rentalAmount, null);
  assert.equal(terms.depositAmount, null);
  assert.equal(terms.paidTotal, null);
  assert.equal(terms.lines[0].unitPrice, null);
  assert.equal(terms.lines[0].amount, null);
  assert.equal(terms.lines[0].name, "哈夫币");
  assert.equal(JSON.stringify(terms).includes("0."), false);
  assert.equal(JSON.stringify(terms).includes("\"0\""), false);
});

test("prestart termination keeps chat open until the refund is fully written off", () => {
  const now = Date.parse("2026-10-29T00:00:00.000Z");
  const pending = terminalSendWindow({
    orderStatus: "CANCELLED", cancelReason: "PRESTART_TERMINATED", cancelledAt: "2026-10-28T00:00:00.000Z",
    settlementPostedAt: null, refundCompletedAt: null, now,
  });
  assert.deepEqual(pending, {
    orderEndedAt: "2026-10-28T00:00:00.000Z", sendUntil: null, refundPending: true,
    refundCompletedAt: null, terminalSendAllowed: true,
  }, "no write-off yet: keep communication open instead of archiving from cancelledAt");

  const recent = terminalSendWindow({
    orderStatus: "CANCELLED", cancelReason: "PRESTART_TERMINATED", cancelledAt: "2026-10-20T00:00:00.000Z",
    settlementPostedAt: null, refundCompletedAt: "2026-10-28T23:00:00.000Z", now,
  });
  assert.equal(recent.refundPending, false);
  assert.equal(recent.sendUntil, "2026-10-31T23:00:00.000Z");
  assert.equal(recent.terminalSendAllowed, true);

  const expired = terminalSendWindow({
    orderStatus: "CANCELLED", cancelReason: "PRESTART_TERMINATED", cancelledAt: "2026-10-20T00:00:00.000Z",
    settlementPostedAt: null, refundCompletedAt: "2026-10-25T00:00:00.000Z", now,
  });
  assert.equal(expired.terminalSendAllowed, false);

  const normal = terminalSendWindow({
    orderStatus: "CANCELLED", cancelReason: "USER", cancelledAt: "2026-10-25T00:00:00.000Z",
    settlementPostedAt: null, refundCompletedAt: null, now,
  });
  assert.equal(normal.terminalSendAllowed, false, "a normal cancellation still closes after its own 72h");

  const completed = terminalSendWindow({
    orderStatus: "COMPLETED", cancelReason: null, cancelledAt: "2026-10-20T00:00:00.000Z",
    settlementPostedAt: "2026-10-28T23:00:00.000Z", refundCompletedAt: null, now,
  });
  assert.equal(completed.sendUntil, "2026-10-31T23:00:00.000Z", "completed orders keep using posted_at");
});

test("the order team detail carries the stage-card ledger with Chinese skip reasons", async t => {
  mockUserContext(t);
  const view = await readOrderTeamAccess(client({
    orderStatus: "CANCELLED", cancelledAt: new Date(Date.now() - 1 * HOUR),
    stageCards: [
      { orderId: ORDER_ID, kind: "ORDER_OPENING", state: "SKIPPED", attemptCount: 1, failureClass: "STAGE_SUPERSEDED", updatedAt: new Date().toISOString(), displayNo: "ZZPROJECT", orderStatus: "CANCELLED" },
      { orderId: ORDER_ID, kind: "ORDER_WELCOME", state: "SENT", attemptCount: 1, sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
  }), userActor, ORDER_ID);
  const cards = view.stageCards as Array<Record<string, unknown>>;
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.kindLabel, "开租确认");
  assert.equal(cards[0]!.failureLabel, "订单已结束，前序阶段卡不再补发", "a skipped card explains itself instead of disappearing");
  assert.equal(cards[0]!.retryable, false);
  assert.equal(cards[0]!.needsAttention, true);
  assert.equal(cards[1]!.state, "SENT");
  assert.equal(cards[1]!.failureLabel, null);
  assert.equal(cards[1]!.needsAttention, false);
  assert.equal(view.canSend, true, "the stage-card ledger never changes the send permission");
});
