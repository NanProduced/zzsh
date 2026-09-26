// TR-B3A: real PostgreSQL, cookie sessions, and controlled payment. No browser page run.
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

import { withTransaction } from "../src/auth/security-core";
import { dispatchPaidOrders } from "../src/im/order-dispatch";
import { advanceOrderTeam, type OrderTeamOptions } from "../src/im/order-team";
import { ImIdentityProvisioner, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { confirmOrderPayment, createControlledPaymentSource, type PaymentInput } from "../src/order/payment-confirmation";
import { issuePersonalConfirmation, type ConfirmationFunding } from "../src/order/personal-confirmation";
import { createPersonalReservation } from "../src/order/personal-order";
import { computeSyntheticFullPayout, settlementSurfaceOpen } from "../src/order/settlement-record";
import { readOrderOccupancy } from "../src/order/order";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { CUSTOMER_TIERS, type CustomerTier } from "../src/supply/delta-rental";
import { validateFundingPolicy, validateOwnerDepositDeclaration } from "../src/supply/funding-policy";
import { seedIdentity } from "./im-test-fixtures";
import { OrderTeamTransport, fakeIdentityAccounts } from "./order-team-fixtures";
import { compatRule } from "./pricing-compat-fixture";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";

type Base = Parameters<typeof runPaymentAcceptance>[1];
type Jar = { header: () => string; update: (response: Response) => void };
type Staff = { id: string; username: string; jar: Jar };
type RequestFn = (base: string, path: string, body: Record<string, unknown> | undefined, jar: { header: () => string; update: (response: Response) => void }, origin: string, method?: string, headers?: Record<string, string>) => Promise<{ response: Response; body: Record<string, any> | null }>;
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const FUNDING: ConfirmationFunding = {
  version: "fixture:v1", sourceRef: "fixture:isolated-authority", baseDepositCents: "30000", publisherBailRequirementCents: "0",
  fullPayoutSelected: false, fullPayoutPolicyRef: "fixture:none", fullPayoutFeeCents: "0", vipWaiver: false, svipWaiver: false,
};

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => hasKeyDeep(entry, key));
}

function assertNoSettlementInternals(value: unknown): void {
  for (const field of [
    "platformContribution", "platformContributionCents", "platformHaffSpread", "platformItemSpread", "platformMakeup", "platformFee",
    "ledgerEntries", "accountCode", "debitCents", "creditCents", "counterpartyUserId", "sourcePaymentConfirmationId",
    "fundingSourceRef", "fundingPolicyRef", "paymentConfirmationId", "approvalRequestId", "approval", "requestedBy",
    "approvedBy", "approvalPayloadHash", "approvalExpiresAt",
  ]) assert.equal(hasKeyDeep(value, field), false, `settlement response exposed ${field}`);
}

function cloneJson(value: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function setJsonPath(root: Record<string, any>, path: readonly string[], value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string, any>;
  current[path[path.length - 1]!] = value;
}

function getJsonPath(root: Record<string, any>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) current = (current as Record<string, unknown>)[segment];
  return current;
}

function deleteJsonPath(root: Record<string, any>, path: readonly string[]): void {
  let current = root;
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string, any>;
  delete current[path[path.length - 1]!];
}

function assertThrows(action: () => unknown, message: string): void {
  let thrown = false;
  try {
    action();
  } catch {
    thrown = true;
  }
  assert.equal(thrown, true, message);
}

async function assertStrictFundingPolicyVectors(pool: Pool, accountId: string): Promise<void> {
  const row = (await pool.query<{ policy: Record<string, any> | null }>(
    `SELECT p.funding_policy AS policy
       FROM zzsh_supply.rental_account a
       JOIN zzsh_supply.game g ON g.id=a.game_id
       JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE a.id=$1`, [accountId],
  )).rows[0];
  assert.ok(row?.policy, "formal policy fixture must exist");
  const base = cloneJson(row.policy);
  assert.doesNotThrow(() => validateFundingPolicy(base));
  const validSql = (await pool.query<{ valid: boolean }>(
    `SELECT zzsh_supply.valid_funding_policy($1::jsonb) AS valid`, [base],
  )).rows[0]?.valid;
  assert.equal(validSql, true, "TS and SQL must accept the same baseline policy");

  type Kind = "string" | "cents" | "boolean";
  const fields: Array<{ label: string; path: string[]; kind: Kind }> = [
    { label: "policy.schema", path: ["schema"], kind: "string" },
    { label: "policy.policyVersion", path: ["policyVersion"], kind: "string" },
    { label: "policy.recommendation.schema", path: ["recommendation", "schema"], kind: "string" },
    { label: "policy.recommendation.algorithm", path: ["recommendation", "algorithm"], kind: "string" },
    { label: "policy.recommendation.version", path: ["recommendation", "version"], kind: "string" },
    { label: "policy.recommendation.currency", path: ["recommendation", "currency"], kind: "string" },
    { label: "policy.recommendation.unit", path: ["recommendation", "unit"], kind: "string" },
    { label: "policy.inputSpec.schema", path: ["recommendation", "inputSpec", "schema"], kind: "string" },
    { label: "policy.inputSpec.currency", path: ["recommendation", "inputSpec", "currency"], kind: "string" },
    { label: "policy.inputSpec.unit", path: ["recommendation", "inputSpec", "unit"], kind: "string" },
    ...["safeBoxCode", "vitality", "bear", "dive", "skinIds"].map((field) => ({
      label: `policy.attributeFields.${field}`, path: ["recommendation", "inputSpec", "attributeFields", field], kind: "string" as const,
    })),
    { label: "policy.ownerDepositRules.schema", path: ["ownerDepositRules", "schema"], kind: "string" },
    { label: "policy.ownerDepositRules.currency", path: ["ownerDepositRules", "currency"], kind: "string" },
    { label: "policy.ownerDepositRules.unit", path: ["ownerDepositRules", "unit"], kind: "string" },
    { label: "policy.guaranteeRequirement.schema", path: ["guaranteeRequirement", "schema"], kind: "string" },
    { label: "policy.guaranteeRequirement.version", path: ["guaranteeRequirement", "version"], kind: "string" },
    { label: "policy.guaranteeRequirement.scope", path: ["guaranteeRequirement", "scope"], kind: "string" },
    { label: "policy.guaranteeRequirement.currency", path: ["guaranteeRequirement", "currency"], kind: "string" },
    { label: "policy.guaranteeRequirement.unit", path: ["guaranteeRequirement", "unit"], kind: "string" },
    { label: "policy.guaranteeRequirement.mode", path: ["guaranteeRequirement", "mode"], kind: "string" },
    { label: "policy.proofValidity.schema", path: ["proofValidity", "schema"], kind: "string" },
    { label: "policy.proofValidity.satisfiedMode", path: ["proofValidity", "satisfiedMode"], kind: "string" },
    { label: "policy.fullPayoutPolicyRef", path: ["fullPayoutPolicyRef"], kind: "string" },
    { label: "policy.fullPayoutPolicyVersion", path: ["fullPayoutPolicyVersion"], kind: "string" },
    { label: "policy.disclosureVersion", path: ["disclosureVersion"], kind: "string" },
    { label: "policy.vipWaiver", path: ["vipWaiver"], kind: "boolean" },
    { label: "policy.svipWaiver", path: ["svipWaiver"], kind: "boolean" },
    { label: "policy.ownerDepositRules.normal.zeroAllowed", path: ["ownerDepositRules", "normal", "zeroAllowed"], kind: "boolean" },
    { label: "policy.ownerDepositRules.fullPayoutSelected.zeroAllowed", path: ["ownerDepositRules", "fullPayoutSelected", "zeroAllowed"], kind: "boolean" },
    { label: "policy.recommendation.parameters.upperLimitCents", path: ["recommendation", "parameters", "upperLimitCents"], kind: "cents" },
    { label: "policy.recommendation.parameters.vitalityAtLeast7Cents", path: ["recommendation", "parameters", "vitalityAtLeast7Cents"], kind: "cents" },
    { label: "policy.recommendation.parameters.bearAtLeast7Cents", path: ["recommendation", "parameters", "bearAtLeast7Cents"], kind: "cents" },
    { label: "policy.recommendation.parameters.diveAtLeast3Cents", path: ["recommendation", "parameters", "diveAtLeast3Cents"], kind: "cents" },
    { label: "policy.recommendation.parameters.rounding.unitCents", path: ["recommendation", "parameters", "rounding", "unitCents"], kind: "cents" },
    { label: "policy.recommendation.parameters.rounding.zeroFallbackCents", path: ["recommendation", "parameters", "rounding", "zeroFallbackCents"], kind: "cents" },
    { label: "policy.ownerDepositRules.capCents", path: ["ownerDepositRules", "capCents"], kind: "cents" },
    { label: "policy.ownerDepositRules.normal.minCents", path: ["ownerDepositRules", "normal", "minCents"], kind: "cents" },
    { label: "policy.ownerDepositRules.fullPayoutSelected.minCents", path: ["ownerDepositRules", "fullPayoutSelected", "minCents"], kind: "cents" },
    { label: "policy.guaranteeRequirement.requiredCents", path: ["guaranteeRequirement", "requiredCents"], kind: "cents" },
    { label: "policy.proofValidity.satisfiedDays", path: ["proofValidity", "satisfiedDays"], kind: "cents" },
  ];
  const safeBoxCode = Object.keys(base.recommendation.parameters.safeBoxWeightsByCode)[0];
  assert.ok(safeBoxCode, "formal policy fixture must contain a safe-box weight");
  fields.push({ label: `policy.safeBoxWeightsByCode.${safeBoxCode}`, path: ["recommendation", "parameters", "safeBoxWeightsByCode", safeBoxCode], kind: "cents" });
  for (const group of ["LEGACY_GOLD", "LEGACY_AGENT", "LEGACY_KNIFE", "LEGACY_WEAPON"]) {
    fields.push(
      { label: `policy.skinWeights.${group}.firstCents`, path: ["recommendation", "parameters", "skinWeights", group, "firstCents"], kind: "cents" },
      { label: `policy.skinWeights.${group}.subsequentCents`, path: ["recommendation", "parameters", "skinWeights", group, "subsequentCents"], kind: "cents" },
    );
  }

  const variants = (kind: Kind): Array<{ label: string; value?: unknown; missing?: true }> => {
    if (kind === "boolean") return [
      { label: "wrong-string", value: "false" }, { label: "number", value: 1 }, { label: "null", value: null },
      { label: "object", value: {} }, { label: "array", value: [] }, { label: "missing", missing: true },
    ];
    return [
      { label: "wrong-string", value: kind === "cents" ? "1.5" : "not valid" }, { label: "number", value: 1 }, { label: "null", value: null },
      { label: "boolean", value: true }, { label: "object", value: {} }, { label: "array", value: [] }, { label: "missing", missing: true },
    ];
  };
  const variantsForField = (field: { label: string; path: string[]; kind: Kind }, root: Record<string, any>) => {
    const result = variants(field.kind);
    if (field.label === "policy.guaranteeRequirement.mode") {
      result.push(
        { label: "array-not-required", value: ["NOT_REQUIRED"] },
        { label: "array-fixed-cents", value: ["FIXED_CENTS"] },
      );
    }
    const paddedFields = new Set([
      "policy.policyVersion", "policy.fullPayoutPolicyRef", "policy.fullPayoutPolicyVersion", "policy.disclosureVersion", "declaration.declarationVersion",
    ]);
    if (paddedFields.has(field.label)) {
      const original = String(getJsonPath(root, field.path));
      result.push({ label: "padded-before", value: ` ${original}` }, { label: "padded-after", value: `${original} ` });
    }
    return result;
  };
  for (const field of fields) {
    for (const variant of variantsForField(field, base)) {
      const candidate = cloneJson(base);
      if (variant.missing) deleteJsonPath(candidate, field.path);
      else setJsonPath(candidate, field.path, variant.value);
      assertThrows(() => validateFundingPolicy(candidate), `${field.label}/${variant.label}: TS must reject`);
      const accepted = (await pool.query<{ valid: boolean }>(
        `SELECT zzsh_supply.valid_funding_policy($1::jsonb) AS valid`, [candidate],
      )).rows[0]?.valid;
      assert.equal(accepted, false, `${field.label}/${variant.label}: SQL must reject`);
    }
  }

  const declarationBase = { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "trc1-imp1-declaration-v1" };
  assert.ok(validateOwnerDepositDeclaration(declarationBase));
  assert.equal((await pool.query<{ valid: boolean }>(
    `SELECT zzsh_supply.valid_owner_deposit_declaration($1::jsonb) AS valid`, [declarationBase],
  )).rows[0]?.valid, true);
  const declarationFields: Array<{ label: string; path: string[]; kind: Kind }> = [
    { label: "declaration.schema", path: ["schema"], kind: "string" },
    { label: "declaration.amountCents", path: ["amountCents"], kind: "cents" },
    { label: "declaration.declarationVersion", path: ["declarationVersion"], kind: "string" },
  ];
  for (const field of declarationFields) {
    for (const variant of variantsForField(field, declarationBase)) {
      const candidate = cloneJson(declarationBase);
      if (variant.missing) deleteJsonPath(candidate, field.path);
      else setJsonPath(candidate, field.path, variant.value);
      assertThrows(() => validateOwnerDepositDeclaration(candidate), `${field.label}/${variant.label}: TS must reject`);
      const accepted = (await pool.query<{ valid: boolean }>(
        `SELECT zzsh_supply.valid_owner_deposit_declaration($1::jsonb) AS valid`, [candidate],
      )).rows[0]?.valid;
      assert.equal(accepted, false, `${field.label}/${variant.label}: SQL must reject`);
    }
  }
}

async function withPostingInsertBarrier<T>(
  pool: Pool,
  action: () => Promise<T>,
  duringInsert: (client: import("pg").PoolClient, postingId: string) => Promise<void>,
): Promise<T> {
  const originalConnect = pool.connect;
  let resolveReached!: (postingId: string) => void;
  let rejectReached!: (error: unknown) => void;
  let armed = true;
  const reached = new Promise<string>((resolve, reject) => { resolveReached = resolve; rejectReached = reject; });
  const watchdog = setTimeout(() => rejectReached(new Error("settlement posting insert barrier was not reached")), 15_000);
  (pool as any).connect = (...args: unknown[]) => {
    if (args.length > 0) return (originalConnect as any).apply(pool, args);
    return (originalConnect as any).call(pool).then((client: import("pg").PoolClient) => new Proxy(client, {
      get(target, property) {
        if (property === "query") return async (...queryArgs: any[]) => {
          const result = await (target.query as any)(...queryArgs);
          const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
          if (armed && typeof sql === "string" && sql.includes("INSERT INTO zzsh_order.settlement_posting (")) {
            armed = false;
            const postingId = String(queryArgs[1]?.[0]);
            try {
              await duringInsert(target, postingId);
              resolveReached(postingId);
            } catch (error) {
              rejectReached(error);
              throw error;
            }
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
  };
  const pending = action();
  void pending.then(() => { if (armed) rejectReached(new Error("settlement action finished before posting insert")); }, rejectReached);
  try {
    await reached;
    return await pending;
  } finally {
    clearTimeout(watchdog);
    (pool as any).connect = originalConnect;
  }
}

export async function runSettlementAcceptance(t: TestContext, o: Base & {
  base: string; buyer: Jar; buyerEmail: string; owner: Jar; boss: Staff; createStaff: (name: string, permissions: string[]) => Promise<Staff>;
  publishApproved: (owner: any, label: string, depositCents: string | null, includeSettlementPiece?: boolean, fullPayoutSelected?: boolean,
    rentalPricing?: { rentalMode: "ordinary" | "custom" | "fast"; ownerRatioB?: string }, pricingOptionCode?: string, formalFunding?: boolean) => Promise<{ accountId: string; versionId: string; releaseId: string; listingHash?: string }>;
  request: any; runtimeUser: string; staged: boolean; upgrade: () => Promise<void>;
  createFormalApp: () => Promise<{ app: { close: () => Promise<void> }; base: string }>;
  createFormalRelease: (mode?: "NOT_REQUIRED" | "SATISFIED") => Promise<void>;
}): Promise<void> {
  const { pool, migrationPool, ownerPool } = o;
  assert.equal(settlementSurfaceOpen(true), true);
  assert.equal(settlementSurfaceOpen(false), false);
  assert.throws(() => computeSyntheticFullPayout("FORMAL_ORDER", { orderId: "x" } as never), /SYNTHETIC_FULL_PAYOUT/);
  assert.equal(computeSyntheticFullPayout("SYNTHETIC_FULL_PAYOUT", { orderId: "synthetic" } as never).ok, false);
  const key = () => ({ "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}` });
  const post = (path: string, body: Record<string, unknown> | undefined, jar: Jar, origin = USER_ORIGIN, headers?: Record<string, string>, method?: string): Promise<{ response: Response; body: Record<string, any> | null }> =>
    o.request(o.base, path, body, jar, origin, method ?? (body === undefined ? "GET" : "POST"), headers ?? (body === undefined ? {} : key()));
  const migrations = async () => (await migrationPool.query(`SELECT hash, created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
  const before = await migrations();
  const retained = (await pool.query(`SELECT o.id, o.status, o.quote_snapshot, o.paid_confirmation_id, p.amount_cents::text AS amount, p.disposition
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id = o.paid_confirmation_id
    WHERE o.status = 'PAID' ORDER BY o.created_at LIMIT 1`)).rows[0];
  assert.ok(retained, "a controlled PAID order must already exist before 0046");
  if (o.staged) {
    assert.equal(before.length, 46, "staged run keeps the 0-45 baseline until retained facts exist");
    await o.upgrade();
  }
  await o.upgrade();
  const migrationFileHash = (tag: string) => createHash("sha256").update(readFileSync(resolve(__dirname, "../../migrations/business", `${tag}.sql`))).digest("hex");
  const after = await migrations();
  assert.equal(after.length, 55);
  assert.equal(after[46]!.hash, migrationFileHash("0046_order_settlement_confirmation"));
  assert.equal(after[46]!.created_at, "1789490015000");
  assert.equal(after[47]!.hash, migrationFileHash("0047_order_settlement_intake"));
  assert.equal(after[47]!.created_at, "1789490016000");
  assert.equal(after[48]!.hash, migrationFileHash("0048_order_settlement_posting"));
  assert.equal(after[48]!.created_at, "1789490017000");
  assert.equal(after[49]!.hash, migrationFileHash("0049_order_settlement_posting_guards"));
  assert.equal(after[49]!.created_at, "1789490018000");
  assert.equal(after[50]!.hash, migrationFileHash("0050_order_personal_quote_v2_guard"));
  assert.equal(after[50]!.created_at, "1789490019000");
  assert.equal(after[51]!.hash, migrationFileHash("0051_order_personal_quote_v2_guard_fix"));
  assert.equal(after[51]!.created_at, "1789490020000");
  assert.equal(after[52]!.hash, migrationFileHash("0052_supply_direct_publication"));
  assert.equal(after[52]!.created_at, "1789490021000");
  assert.equal(after[53]!.hash, migrationFileHash("0053_supply_funding_authority"));
  assert.equal(after[53]!.created_at, "1789490022000");
  assert.equal(after[54]!.hash, migrationFileHash("0054_supply_funding_guard_correction"));
  assert.equal(after[54]!.created_at, "1789490023000");
  if (!o.staged) assert.equal(before.length, 55, "the post-application settlement run must start at 55 migrations");
  console.log("trade settlement migration replay", JSON.stringify({ beforeCount: before.length, afterCount: after.length,
    firstApplication: o.staged ? null : "0054 already recorded by the controlled migration runner", replay: !o.staged && before.length === 55 && after.length === 55 }));
  if (o.staged) assert.notDeepEqual(before, after);
  const retainedAfter = (await pool.query(`SELECT o.id, o.status, o.quote_snapshot, o.paid_confirmation_id, p.amount_cents::text AS amount, p.disposition
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id = o.paid_confirmation_id WHERE o.id = $1`, [retained.id])).rows[0];
  assert.deepEqual(retainedAfter, retained);
  const privileges = (await pool.query(`SELECT
    has_table_privilege(current_user, 'zzsh_order.settlement_decision', 'DELETE') AS "deleteDecision",
    has_table_privilege(current_user, 'zzsh_order.settlement_version', 'UPDATE') AS "updateVersion",
    has_column_privilege(current_user, 'zzsh_order.settlement_version', 'superseded_at', 'UPDATE') AS "supersede",
    has_column_privilege(current_user, 'zzsh_order.rental_opening', 'lines', 'UPDATE') AS "rewriteLines",
    has_column_privilege(current_user, 'zzsh_order.rental_opening', 'status', 'UPDATE') AS "confirmOpening"`)).rows[0];
  assert.deepEqual(privileges, { deleteDecision: false, updateVersion: false, supersede: true, rewriteLines: false, confirmOpening: true });
  const intakePrivileges = (await pool.query(`SELECT
    has_column_privilege(current_user, 'zzsh_order.settlement_intake', 'lines', 'UPDATE') AS "rewriteIntake",
    has_column_privilege(current_user, 'zzsh_order.settlement_intake', 'status', 'UPDATE') AS "classifyIntake"`)).rows[0];
  assert.deepEqual(intakePrivileges, { rewriteIntake: false, classifyIntake: true });

  const run = randomUUID().replaceAll("-", "").slice(0, 8);
  const appId = `settle_${run}`;
  const staff = await o.createStaff("结算负责客服", ["im.support.read", "im.support.accept", "im.support.presence", "order.settlement.write", "approval.request.create", "supply.quote.internal.read"]);
  const collaborator = await o.createStaff("结算协作客服", ["im.support.read", "order.settlement.write"]);
  const reader = await o.createStaff("结算只读客服", ["im.support.read", "order.read"]);
  const outsider = await o.createStaff("无群结算客服", ["im.support.read", "order.settlement.write"]);
  const ops = await o.createStaff("结算运营", ["approval.request.approve", "approval.request.read", "approval.request.execute"]);
  assert.equal((await post("/api/v1/admin/security/approvals/templates/update", {
    operationCode: "order.settlement.adjust", triggerCondition: "manual-net", candidateUsernames: [ops.username, staff.username],
  }, o.boss.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const gate = async () => ({ publisherBail: "SATISFIED" as const, occupancy: "FREE" as const, reference: "fixture:order-bail" });
  const confirmationKey = { keyId: "trb2test", secret: randomBytes(32).toString("hex") };
  const buyer = (await pool.query<{ id: string; sessionId: string }>(
    `SELECT u.id, s.id AS "sessionId" FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId" = u.id
      WHERE u.email = $1 ORDER BY s."createdAt" DESC LIMIT 1`, [o.buyerEmail])).rows[0]!;
  const membershipPath = `/api/bff/admin/users/${buyer.id}/rental-membership`;
  const setMembershipTier = async (tier: CustomerTier) => {
    const membership = await post(membershipPath, undefined, o.boss.jar, ADMIN_ORIGIN, {}, "GET");
    assert.equal(membership.response.status, 200, JSON.stringify(membership.body));
    const updated = await post(membershipPath, {
      tier, expectedVersion: membership.body!.membership.version, sourceRef: "fixture:trb2", reason: "isolated settlement membership",
    }, o.boss.jar, ADMIN_ORIGIN, key(), "PUT");
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body!.membership.tier, tier);
    return updated.body!.membership;
  };
  await setMembershipTier("STANDARD");
  const makePaid = async (label: string) => {
    const account = await o.publishApproved(o.owner, label, "30000", true);
    const context = { userId: buyer.id, sessionId: buyer.sessionId };
    const options = { key: confirmationKey, gate, fundingReader: async () => FUNDING, holdSeconds: 3600 };
    const issued = await withTransaction(pool, (client) => issuePersonalConfirmation(client, context, account, options));
    const created = await withTransaction(pool, (client) => createPersonalReservation(client, context, issued.confirmationToken, options, `req_${randomUUID()}`));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const orderId = (created.body as { order: { id: string } }).order.id;
    const v1Snapshot = (await pool.query<{ quote: Record<string, any> }>(
      `SELECT quote_snapshot AS quote FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0]!.quote;
    assert.equal(v1Snapshot.personal.schema, "personal-quote-v1");
    assert.equal(Object.hasOwn(v1Snapshot.personal, "quote"), false, "v1 must also keep the normalized quote at the order root");
    assert.equal(v1Snapshot.priceVersionId, v1Snapshot.personal.ruleRefs.priceVersionId);
    const row = (await pool.query(`SELECT display_no, (rental_amount_cents + deposit_amount_cents)::text AS total FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0];
    const input: PaymentInput = { orderId, merchantOrderNo: row.display_no, providerTransactionId: `tx_${randomUUID()}`, amountCents: row.total, currency: "CNY", providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` };
    const fact = createControlledPaymentSource({ config: o.config, resourceSet: o.resourceSet, appId, merchantScopeId: "settle-merchant", allowedOrderIds: [orderId] })(input);
    assert.equal((await withTransaction(pool, (client) => confirmOrderPayment(client, fact))).disposition, "APPLIED");
    return orderId;
  };
  const teamWire = new OrderTeamTransport();
  const teamIdentities = new ImIdentityProvisioner(new YunxinIdentityRepository(pool), fakeIdentityAccounts().api);
  const joinTeam = async (orderId: string) => {
    await dispatchPaidOrders(pool, appId);
    const options: OrderTeamOptions = { pool, appId, provider: teamWire.client, identities: teamIdentities, membersLimit: 200 };
    const teamRow = async () => (await pool.query(`SELECT g.team_state, g.team_failure, op.state, op.failure_class, op.candidate_team_id
      FROM zzsh_order.im_order_group g LEFT JOIN zzsh_order.im_order_operation op ON op.order_id = g.order_id AND op.kind = 'CREATE'
      WHERE g.order_id = $1`, [orderId])).rows[0];
    await advanceOrderTeam(options, orderId);
    if ((await teamRow()).team_state !== "READY") {
      await pool.query(`UPDATE zzsh_iam.im_identity_mapping SET next_retry_at = clock_timestamp() WHERE app_id = $1 AND status = 'PENDING'`, [appId]);
      await advanceOrderTeam(options, orderId);
    }
    const team = await teamRow();
    assert.equal(team.team_state, "READY", JSON.stringify(team));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_opening WHERE order_id = $1`, [orderId])).rows[0].n, 0, "PAID and team creation do not open a rental");
  };
  const addMember = async (orderId: string, adminId: string) => {
    const key: ImIdentityKey = { provider: "yunxin", appId, realm: "admin", kind: "ADMIN", platformSubjectId: adminId };
    if (!(await pool.query(`SELECT 1 FROM zzsh_iam.im_identity_mapping WHERE app_id = $1 AND platform_subject_id = $2 AND identity_kind = 'ADMIN'`, [appId, adminId])).rowCount) {
      await seedIdentity(pool, key, run);
    }
    const mapping = (await pool.query(`SELECT id FROM zzsh_iam.im_identity_mapping WHERE app_id = $1 AND platform_subject_id = $2 AND identity_kind = 'ADMIN'`, [appId, adminId])).rows[0];
    await pool.query(`INSERT INTO zzsh_order.im_order_member(order_id, app_id, identity_id, party, state, joined_at) VALUES ($1,$2,$3,'STAFF','JOINED',clock_timestamp()) ON CONFLICT DO NOTHING`, [orderId, appId, mapping.id]);
  };
  const quoteLines = async (orderId: string) => (await pool.query<{ lines: Array<{ itemId: string; quantity: string }> }>(
    `SELECT quote_snapshot->'lines' AS lines FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0]!.lines;
  const openingBody = async (orderId: string) => ({ lines: (await quoteLines(orderId)).map((line) => ({ itemId: line.itemId, quantity: line.quantity })) });
  const remainingBody = async (orderId: string, remaining: string) => ({ lines: (await quoteLines(orderId)).map((line) => ({ itemId: line.itemId, remainingQuantity: remaining })) });
  const makePaidV2 = async (label: string, selected = true, membershipTier: CustomerTier = "STANDARD") => {
    assert.equal(o.resourceSet, "trade_settlement", "v2 controlled compensation is restricted to the registered settlement resource");
    await setMembershipTier(membershipTier);
    const account = await o.publishApproved(o.owner, label, "30000", true, selected,
      membershipTier === "STANDARD" ? undefined : { rentalMode: "ordinary" }, membershipTier === "STANDARD" ? undefined : "");
    const confirmation = await post("/api/v2/order-confirmations", {
      accountId: account.accountId, versionId: account.versionId, releaseId: account.releaseId,
    }, o.buyer);
    assert.equal(confirmation.response.status, 200, JSON.stringify(confirmation.body));
    assert.equal(confirmation.body!.compensationDisclosure.selected, selected);
    assert.equal(hasKeyDeep(confirmation.body, "sourceRef"), false);
    assertNoSettlementInternals(confirmation.body);
    const created = await post("/api/v2/orders", { confirmationToken: confirmation.body!.confirmationToken }, o.buyer, USER_ORIGIN, key());
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const orderId = created.body!.order.id as string;
    const order = (await pool.query<{ displayNo: string; total: string; depositAmount: string; status: string; quote: Record<string, any>; paidConfirmationId: string | null }>(
      `SELECT display_no AS "displayNo", (rental_amount_cents + deposit_amount_cents)::text AS total,
              deposit_amount_cents::text AS "depositAmount",
              status, quote_snapshot AS quote, paid_confirmation_id AS "paidConfirmationId"
         FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0]!;
    const personal = order.quote.personal;
    assert.equal(order.status, "PENDING_PAYMENT");
    assert.equal(order.depositAmount, "30000", "membership tier must not alter the publisher deposit fixture");
    assert.equal(personal.schema, "personal-quote-v2");
    assert.deepEqual(Object.keys(personal).sort(), [
      "accountId", "fullPayoutDeclaration", "funding", "guarantee", "listingHash", "listingVersionId",
      "membership", "ownerUserId", "ruleRefs", "schema", "userId",
    ]);
    assert.equal(Object.hasOwn(personal, "quote"), false, "v2 keeps the normalized quote at the order snapshot root");
    assert.equal(personal.fullPayoutDeclaration.selected, selected);
    assert.equal(personal.membership.tier, membershipTier, "settlement must use the frozen membership tier");
    assert.equal(personal.listingVersionId, account.versionId);
    assert.equal(personal.listingHash, account.listingHash);
    assert.equal(order.quote.priceVersionId, personal.ruleRefs.priceVersionId);
    assert.equal(order.quote.ruleReleaseId, account.releaseId);
    assert.equal(Object.hasOwn(personal.funding, "schema"), false, "personal.schema is the persisted quote version; funding has no duplicate schema truth");
    assert.equal(Object.hasOwn(personal.funding, "fullPayoutFeeCents"), false, "fee is not pre-deducted or frozen as an amount");
    const input: PaymentInput = {
      orderId, merchantOrderNo: order.displayNo, providerTransactionId: `tx_${randomUUID()}`,
      amountCents: order.total, currency: "CNY", providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}`,
    };
    const fact = createControlledPaymentSource({
      config: o.config, resourceSet: o.resourceSet, appId, merchantScopeId: "settle-merchant", allowedOrderIds: [orderId],
    })(input);
    const applied = await withTransaction(pool, (client) => confirmOrderPayment(client, fact));
    assert.equal(applied.disposition, "APPLIED");
    const paid = (await pool.query<{ paymentId: string; amount: string }>(
      `SELECT p.id AS "paymentId", p.amount_cents::text AS amount FROM zzsh_order.rental_order o
       JOIN zzsh_order.payment_confirmation p ON p.id = o.paid_confirmation_id WHERE o.id = $1`, [orderId])).rows[0]!;
    assert.equal(paid.amount, order.total);
    assert.equal(order.paidConfirmationId, null);
    return { orderId, account, paymentId: paid.paymentId };
  };
  const waiters = async () => Number((await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n);
  const holdOrder = async (orderId: string, start: Array<Promise<unknown>>) => {
    const client = await ownerPool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id = $1 FOR UPDATE`, [orderId]);
      const pending = Promise.all(start);
      const requiredWaiters = start.length;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && await waiters() < requiredWaiters) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(await waiters() >= requiredWaiters, "all competing writes must wait on the order lock");
      await client.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }
  };

  const gameId = (await pool.query(`SELECT id FROM zzsh_supply.game LIMIT 1`)).rows[0].id;
  for (const adminId of [staff.id, collaborator.id, reader.id, outsider.id]) {
    await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id, game_id, granted_by_admin_id) VALUES ($1,$2,$3) ON CONFLICT (admin_user_id, game_id) DO NOTHING`, [adminId, gameId, o.boss.id]);
  }
  await seedIdentity(pool, { provider: "yunxin", appId, realm: "admin", kind: "ADMIN", platformSubjectId: staff.id }, run);
  await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id, admin_user_id, availability, connection_state, last_connected_at) VALUES ($1,$2,'AVAILABLE','CONNECTED',clock_timestamp())`, [appId, staff.id]);

  const successAudits = async (orderId: string, action: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = $2 AND outcome = 'SUCCESS'`,
    [orderId, action],
  )).rows[0].n);
  const settlementState = async (orderId: string) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_intake WHERE order_id = $1) AS intakes,
    (SELECT count(*)::int FROM zzsh_order.settlement_version WHERE order_id = $1) AS versions,
    (SELECT count(*)::int FROM zzsh_order.settlement_decision d JOIN zzsh_order.settlement_version v ON v.id = d.settlement_version_id WHERE v.order_id = $1) AS decisions,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action LIKE 'order.settlement.%' AND outcome = 'SUCCESS') AS "settlementAudits",
    (SELECT count(*)::int FROM zzsh_iam.approval_request WHERE operation_code = 'order.settlement.adjust') AS "adjustmentApprovals",
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action = 'approval.request.created' AND details->>'operationCode' = 'order.settlement.adjust' AND outcome = 'SUCCESS') AS "adjustmentAudits",
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.settlement_posting p ON p.id = e.posting_id WHERE p.order_id = $1) AS ledgerEntries`, [orderId])).rows[0];
  const settleV2 = async (label: string, branch: "NORMAL" | "TENANT_EARLY" | "OWNER_EARLY" | "OWNER_ZERO_EARLY", membershipTier: CustomerTier = "STANDARD") => {
    const created = await makePaidV2(label, true, membershipTier);
    const orderId = created.orderId;
    await joinTeam(orderId);
    await addMember(orderId, staff.id);
    const openingBodyValue = await openingBody(orderId);
    assert.equal((await post(`/api/v1/admin/orders/${orderId}/openings`, openingBodyValue, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
    const opening = (await post(`/api/v1/orders/${orderId}/settlement`, undefined, o.buyer)).body!.openings[0];
    for (const jar of [o.buyer, o.owner]) {
      const confirmed = await post(`/api/v1/orders/${orderId}/openings/${opening.id}/confirm`, { versionNo: opening.versionNo }, jar, USER_ORIGIN, key());
      assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    }
    const haff = opening.lines.find((line: any) => line.pricingKind === "HAFF_RATIO");
    assert.ok(haff && BigInt(haff.quantity) > 1n);
    const isEarly = branch !== "NORMAL";
    const consumedHaff = branch === "OWNER_ZERO_EARLY" ? 0n : isEarly ? BigInt(haff.quantity) / 2n : BigInt(haff.quantity);
    const remaining = { lines: opening.lines.map((line: any) => ({
      itemId: line.itemId,
      remainingQuantity: line.pricingKind === "HAFF_RATIO" ? (BigInt(line.quantity) - consumedHaff).toString()
        : branch === "TENANT_EARLY" || branch === "OWNER_ZERO_EARLY" ? line.quantity : "0",
    })) };
    let postingResponse: { response: Response; body: Record<string, any> | null };
    let settlementVersionId: string;
    let versionHash: string;
    if (!isEarly) {
      const preview = await post(`/api/v1/orders/${orderId}/settlement-preview`, remaining, o.buyer);
      assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
      const submission = await post(`/api/v1/orders/${orderId}/settlements`, { ...remaining, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
      assert.equal(submission.response.status, 200, JSON.stringify(submission.body));
      settlementVersionId = submission.body!.settlement.id;
      versionHash = submission.body!.settlement.versionHash;
      postingResponse = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
        action: "CONFIRM", versionHash,
      }, o.owner, USER_ORIGIN, key());
    } else {
      const applicant = branch === "TENANT_EARLY" ? o.buyer : o.owner;
      const applicationPreview = await post(`/api/v1/orders/${orderId}/settlement-preview`, remaining, applicant);
      assert.equal(applicationPreview.response.status, 200, JSON.stringify(applicationPreview.body));
      assert.ok(applicationPreview.body!.reasons.includes("EARLY_REASON_REQUIRED"));
      const intake = await post(`/api/v1/orders/${orderId}/settlements`, {
        ...remaining, acceptedHash: applicationPreview.body!.versionHash,
      }, applicant, USER_ORIGIN, key());
      assert.equal(intake.response.status, 200, JSON.stringify(intake.body));
      assert.equal(intake.body!.currentRequest.status, "OPEN");
      const endReason = branch === "TENANT_EARLY" ? "TENANT_VOLUNTARY_EARLY" : "OWNER_OR_ACCOUNT_EARLY";
      const staffPreview = await post(`/api/v1/admin/orders/${orderId}/settlement-preview`, { ...remaining, endReason }, staff.jar, ADMIN_ORIGIN);
      assert.equal(staffPreview.response.status, 200, JSON.stringify(staffPreview.body));
      const classified = await post(`/api/v1/admin/orders/${orderId}/settlements/classify`, {
        ...remaining, endReason, acceptedHash: staffPreview.body!.versionHash,
      }, staff.jar, ADMIN_ORIGIN, key());
      assert.equal(classified.response.status, 200, JSON.stringify(classified.body));
      assert.equal(classified.body!.intakes.at(-1).status, "CLASSIFIED");
      settlementVersionId = classified.body!.settlement.id;
      versionHash = classified.body!.settlement.versionHash;
      for (const jar of [o.buyer, o.owner]) {
        const confirmed = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
          action: "CONFIRM", versionHash,
        }, jar, USER_ORIGIN, key());
        assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
      }
      const pending = await post(`/api/v1/orders/${orderId}/settlement`, undefined, o.buyer);
      assert.equal(pending.body!.ready, false);
      assert.ok(pending.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
      postingResponse = await post(`/api/v1/admin/orders/${orderId}/settlements/${settlementVersionId}/review`, { versionHash }, staff.jar, ADMIN_ORIGIN, key());
    }
    assert.equal(postingResponse.response.status, 200, JSON.stringify(postingResponse.body));
    const posted = (await pool.query<{ status: string; fee: string; paymentId: string; paidPaymentId: string; payer: string; rate: string; feeBase: string; ownerNet: string; refund: string; platform: string; refundDueAt: string; postedAt: string }>(
      `SELECT o.status, p.compensation_fee_cents::text AS fee, p.payment_confirmation_id AS "paymentId",
              o.paid_confirmation_id AS "paidPaymentId", v.computation#>>'{amounts,feePayer}' AS payer,
              v.computation#>>'{amounts,feeRate}' AS rate, v.computation#>>'{amounts,feeBase,amount}' AS "feeBase",
              p.owner_net_cents::text AS "ownerNet", p.renter_refund_cents::text AS refund,
              p.platform_contribution_cents::text AS platform, p.refund_due_at::text AS "refundDueAt", p.posted_at::text AS "postedAt"
         FROM zzsh_order.rental_order o JOIN zzsh_order.settlement_posting p ON p.order_id=o.id
         JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id WHERE o.id=$1`, [orderId])).rows[0]!;
    assert.equal(posted.status, "COMPLETED");
    assert.equal(posted.paymentId, posted.paidPaymentId);
    assert.equal(posted.rate, "0.08");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id=$1`, [orderId])).rows[0].n, 1);
    const feeEntries = await pool.query<{ credit: string; details: Record<string, unknown> }>(
      `SELECT credit_cents::text AS credit, details FROM zzsh_order.settlement_ledger_entry
        WHERE posting_id=(SELECT id FROM zzsh_order.settlement_posting WHERE order_id=$1) AND account_code='PLATFORM_COMPENSATION_FEE'`, [orderId]);
    const expectedPayer = branch === "TENANT_EARLY" ? "RENTER" : "OWNER";
    assert.equal(posted.payer, expectedPayer);
    const expected = {
      NORMAL: { fee: "1080", feeBase: "135.00", ownerNet: "12420", refund: "30000", platform: "4580" },
      TENANT_EARLY: { fee: "1080", feeBase: "135.00", ownerNet: "6000", refund: "36920", platform: "4080" },
      OWNER_EARLY: { fee: "600", feeBase: "75.00", ownerNet: "6900", refund: "37500", platform: "2600" },
      OWNER_ZERO_EARLY: { fee: "0", feeBase: "0.00", ownerNet: "0", refund: "47000", platform: "0" },
    }[branch];
    assert.deepEqual({ fee: posted.fee, feeBase: posted.feeBase, ownerNet: posted.ownerNet, refund: posted.refund, platform: posted.platform }, expected,
      `${branch} must retain the fixed fixture amounts and fee base`);
    if (branch === "OWNER_ZERO_EARLY") {
      assert.equal(posted.fee, "0");
      assert.equal(posted.feeBase, "0.00");
      assert.equal(feeEntries.rowCount, 0, "selected but no consumed owner base produces no fee entry");
    } else {
      assert.ok(BigInt(posted.fee) > 0n, `${branch} must post a nonzero 8% fee`);
      assert.equal(feeEntries.rowCount, 1, "one nonzero fee creates exactly one classification entry");
      assert.equal(feeEntries.rows[0]!.credit, posted.fee);
      assert.equal(feeEntries.rows[0]!.details.rate, "0.08");
      assert.equal(feeEntries.rows[0]!.details.payer, expectedPayer);
    }
    const ledger = (await pool.query<{ debit: string; credit: string; sourceCount: number }>(
      `SELECT sum(debit_cents)::text AS debit, sum(credit_cents)::text AS credit,
              count(*) FILTER (WHERE account_code='CAPTURED_PAYMENT_SOURCE' AND source_payment_confirmation_id=$2)::int AS "sourceCount"
         FROM zzsh_order.settlement_ledger_entry WHERE posting_id=(SELECT id FROM zzsh_order.settlement_posting WHERE order_id=$1)`,
      [orderId, posted.paidPaymentId])).rows[0]!;
    assert.equal(ledger.debit, ledger.credit);
    assert.equal(ledger.sourceCount, 1);
    console.log("trb3b1 controlled posting", JSON.stringify({ branch, orderId, feeCents: posted.fee, payer: posted.payer, feeBase: posted.feeBase, status: posted.status }));
    return { orderId, feeCents: posted.fee, payer: posted.payer };
  };
  const settleSelectedManual = async (branch: "NORMAL" | "TENANT_EARLY") => {
    const created = await makePaidV2(`TR-GUARD-2 R2 ${branch} selected manual`, true, "STANDARD");
    const orderId = created.orderId;
    await joinTeam(orderId);
    await addMember(orderId, staff.id);
    const openingBodyValue = await openingBody(orderId);
    assert.equal((await post(`/api/v1/admin/orders/${orderId}/openings`, openingBodyValue, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
    const opening = (await post(`/api/v1/orders/${orderId}/settlement`, undefined, o.buyer)).body!.openings[0];
    for (const jar of [o.buyer, o.owner]) {
      const confirmed = await post(`/api/v1/orders/${orderId}/openings/${opening.id}/confirm`, { versionNo: opening.versionNo }, jar, USER_ORIGIN, key());
      assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    }
    const haff = opening.lines.find((line: any) => line.pricingKind === "HAFF_RATIO");
    assert.ok(haff && BigInt(haff.quantity) > 1n);
    const isEarly = branch === "TENANT_EARLY";
    const consumedHaff = isEarly ? BigInt(haff.quantity) / 2n : BigInt(haff.quantity);
    const remaining = { lines: opening.lines.map((line: any) => ({
      itemId: line.itemId,
      remainingQuantity: line.pricingKind === "HAFF_RATIO" ? (BigInt(line.quantity) - consumedHaff).toString()
        : isEarly ? line.quantity : "0",
    })) };
    const expected = isEarly
      ? { systemOwner: "6000", systemRefund: "36920", finalOwner: "5900", finalRefund: "36920", fee: "1080", feeBase: "135.00", payer: "RENTER", adjustment: "100", platform: "4180" }
      : { systemOwner: "12420", systemRefund: "30000", finalOwner: "12300", finalRefund: "30000", fee: "1080", feeBase: "135.00", payer: "OWNER", adjustment: "120", platform: "4700" };
    const assertPreview = (body: Record<string, any>) => {
      assert.equal(body.amounts.ownerNet, `${expected.systemOwner.slice(0, -2)}.${expected.systemOwner.slice(-2)}`);
      assert.equal(body.amounts.renterRefund, `${expected.systemRefund.slice(0, -2)}.${expected.systemRefund.slice(-2)}`);
      assert.equal(body.amounts.feeAmount, `${expected.fee.slice(0, -2)}.${expected.fee.slice(-2)}`);
      assert.equal(body.amounts.feeBase, expected.feeBase);
      assert.equal(body.amounts.feePayer, expected.payer);
    };
    let settlementVersionId: string;
    let versionHash: string;
    let endReason: "TENANT_VOLUNTARY_EARLY" | null = null;
    if (!isEarly) {
      const preview = await post(`/api/v1/orders/${orderId}/settlement-preview`, remaining, o.buyer);
      assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
      assertPreview(preview.body!);
      const submission = await post(`/api/v1/orders/${orderId}/settlements`, { ...remaining, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
      assert.equal(submission.response.status, 200, JSON.stringify(submission.body));
      settlementVersionId = submission.body!.settlement.id;
      versionHash = submission.body!.settlement.versionHash;
    } else {
      const applicationPreview = await post(`/api/v1/orders/${orderId}/settlement-preview`, remaining, o.buyer);
      assert.equal(applicationPreview.response.status, 200, JSON.stringify(applicationPreview.body));
      assert.ok(applicationPreview.body!.reasons.includes("EARLY_REASON_REQUIRED"));
      const intake = await post(`/api/v1/orders/${orderId}/settlements`, {
        ...remaining, acceptedHash: applicationPreview.body!.versionHash,
      }, o.buyer, USER_ORIGIN, key());
      assert.equal(intake.response.status, 200, JSON.stringify(intake.body));
      assert.equal(intake.body!.currentRequest.status, "OPEN");
      endReason = "TENANT_VOLUNTARY_EARLY";
      const staffPreview = await post(`/api/v1/admin/orders/${orderId}/settlement-preview`, { ...remaining, endReason }, staff.jar, ADMIN_ORIGIN);
      assert.equal(staffPreview.response.status, 200, JSON.stringify(staffPreview.body));
      assertPreview(staffPreview.body!);
      const classified = await post(`/api/v1/admin/orders/${orderId}/settlements/classify`, {
        ...remaining, endReason, acceptedHash: staffPreview.body!.versionHash,
      }, staff.jar, ADMIN_ORIGIN, key());
      assert.equal(classified.response.status, 200, JSON.stringify(classified.body));
      assert.equal(classified.body!.intakes.at(-1).status, "CLASSIFIED");
      settlementVersionId = classified.body!.settlement.id;
      versionHash = classified.body!.settlement.versionHash;
    }
    const adjustmentPreview = await post(`/api/v1/admin/orders/${orderId}/settlement-preview`, {
      ...remaining, ...(endReason ? { endReason } : {}), proposedOwnerNet: isEarly ? "59.00" : "123.00",
      proposedRenterRefund: isEarly ? "369.20" : "300.00", reason: `R2 ${branch} final operator net`,
    }, staff.jar, ADMIN_ORIGIN);
    assert.equal(adjustmentPreview.response.status, 200, JSON.stringify(adjustmentPreview.body));
    assertPreview(adjustmentPreview.body!);
    const adjusted = await post(`/api/v1/admin/orders/${orderId}/settlements/adjustments`, {
      ...remaining, ...(endReason ? { endReason } : {}), proposedOwnerNet: isEarly ? "59.00" : "123.00",
      proposedRenterRefund: isEarly ? "369.20" : "300.00", reason: `R2 ${branch} final operator net`,
      acceptedHash: adjustmentPreview.body!.versionHash,
    }, staff.jar, ADMIN_ORIGIN, key());
    assert.equal(adjusted.response.status, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body!.ready, false);
    settlementVersionId = adjusted.body!.settlement.id;
    versionHash = adjusted.body!.settlement.versionHash;
    const version = (await pool.query<{ approvalRequestId: string; versionHash: string; kind: string }>(
      `SELECT approval_request_id AS "approvalRequestId", version_hash AS "versionHash", kind
         FROM zzsh_order.settlement_version WHERE id = $1`, [settlementVersionId])).rows[0]!;
    assert.equal(version.kind, "MANUAL_ADJUSTMENT");
    assert.equal(version.versionHash, versionHash);
    const approval = (await pool.query<{ status: string; requestedBy: string; payloadHash: string }>(
      `SELECT status, requested_by AS "requestedBy", operation_payload_hash AS "payloadHash"
         FROM zzsh_iam.approval_request WHERE id = $1`, [version.approvalRequestId])).rows[0]!;
    assert.equal(approval.status, "PENDING");
    assert.equal(approval.requestedBy, staff.id);
    assert.equal(approval.payloadHash, versionHash, "approval and manual version must bind the same payload");
    const noApproval = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
      action: "CONFIRM", versionHash,
    }, o.buyer, USER_ORIGIN, key());
    assert.equal(noApproval.response.status, 409);
    assert.equal(noApproval.body!.reasons?.[0], "OPS_APPROVAL_MISSING");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1`, [settlementVersionId])).rows[0].n, 0);
    assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", {
      requestId: version.approvalRequestId, decision: "APPROVE", reason: `R2 ${branch} 非自审批准`,
    }, staff.jar, ADMIN_ORIGIN, key())).response.status, 403);
    assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", {
      requestId: version.approvalRequestId, decision: "APPROVE", reason: `R2 ${branch} 非自审批准`,
    }, ops.jar, ADMIN_ORIGIN, key())).response.status, 200);
    assert.equal((await pool.query(`SELECT status FROM zzsh_iam.approval_request WHERE id = $1`, [version.approvalRequestId])).rows[0].status, "APPROVED");
    let posted: { response: Response; body: Record<string, any> | null };
    if (!isEarly) {
      const renterConfirm = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
        action: "CONFIRM", versionHash,
      }, o.buyer, USER_ORIGIN, key());
      assert.equal(renterConfirm.response.status, 200, JSON.stringify(renterConfirm.body));
      assert.equal(renterConfirm.body!.ready, false);
      const ownerKey = key();
      posted = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
        action: "CONFIRM", versionHash,
      }, o.owner, USER_ORIGIN, ownerKey);
      assert.equal(posted.response.status, 200, JSON.stringify(posted.body));
      assert.deepEqual((await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
        action: "CONFIRM", versionHash,
      }, o.owner, USER_ORIGIN, ownerKey)).body, posted.body, "same-key replay must not post twice");
    } else {
      for (const jar of [o.buyer, o.owner]) {
        const confirmed = await post(`/api/v1/orders/${orderId}/settlements/${settlementVersionId}/decision`, {
          action: "CONFIRM", versionHash,
        }, jar, USER_ORIGIN, key());
        assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
        assert.equal(confirmed.body!.ready, false);
      }
      const pending = await post(`/api/v1/orders/${orderId}/settlement`, undefined, o.buyer);
      assert.equal(pending.body!.ready, false);
      assert.ok(pending.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
      const reviewKey = key();
      posted = await post(`/api/v1/admin/orders/${orderId}/settlements/${settlementVersionId}/review`, { versionHash }, staff.jar, ADMIN_ORIGIN, reviewKey);
      assert.equal(posted.response.status, 200, JSON.stringify(posted.body));
      assert.deepEqual((await post(`/api/v1/admin/orders/${orderId}/settlements/${settlementVersionId}/review`, { versionHash }, staff.jar, ADMIN_ORIGIN, reviewKey)).body,
        posted.body, "same-key support review replay must not post twice");
    }
    assert.equal(posted.body!.ready, true);
    assert.equal(posted.body!.orderStatus, "COMPLETED");
    const row = (await pool.query<{ status: string; captured: string; systemOwner: string; owner: string; systemRefund: string; refund: string; platform: string; fee: string; feeBase: string; payer: string; depositRefund: string }>(
      `SELECT o.status, p.captured_cents::text AS captured, p.system_owner_net_cents::text AS "systemOwner",
              p.owner_net_cents::text AS owner, p.system_renter_refund_cents::text AS "systemRefund",
              p.renter_refund_cents::text AS refund, p.platform_contribution_cents::text AS platform,
              p.compensation_fee_cents::text AS fee, v.computation#>>'{amounts,feeBase,amount}' AS "feeBase",
              v.computation#>>'{amounts,feePayer}' AS payer, v.computation#>>'{amounts,depositRefund,amount}' AS "depositRefund"
         FROM zzsh_order.rental_order o JOIN zzsh_order.settlement_posting p ON p.order_id = o.id
         JOIN zzsh_order.settlement_version v ON v.id = p.settlement_version_id WHERE o.id = $1`, [orderId])).rows[0]!;
    assert.equal(row.status, "COMPLETED");
    assert.deepEqual({ captured: row.captured, systemOwner: row.systemOwner, owner: row.owner, systemRefund: row.systemRefund,
      refund: row.refund, platform: row.platform, fee: row.fee, feeBase: row.feeBase, payer: row.payer, depositRefund: row.depositRefund },
      { captured: "47000", systemOwner: expected.systemOwner, owner: expected.finalOwner, systemRefund: expected.systemRefund,
        refund: expected.finalRefund, platform: expected.platform, fee: expected.fee, feeBase: expected.feeBase, payer: expected.payer, depositRefund: "300.00" });
    const ledger = (await pool.query<{ accountCode: string; debit: string; credit: string; entries: number }>(
      `SELECT account_code AS "accountCode", sum(debit_cents)::text AS debit, sum(credit_cents)::text AS credit, count(*)::int AS entries
         FROM zzsh_order.settlement_ledger_entry WHERE posting_id = (SELECT id FROM zzsh_order.settlement_posting WHERE order_id = $1)
        GROUP BY account_code ORDER BY account_code`, [orderId])).rows;
    const byCode = (code: string) => ledger.find((entry) => entry.accountCode === code)!;
    assert.equal(ledger.reduce((sum, entry) => sum + BigInt(entry.debit), 0n), ledger.reduce((sum, entry) => sum + BigInt(entry.credit), 0n));
    assert.equal(byCode("OWNER_AVAILABLE").credit, expected.finalOwner);
    assert.equal(byCode("RENTER_REFUND_PAYABLE").credit, expected.finalRefund);
    assert.equal(byCode("PLATFORM_MANUAL_NET_ADJUSTMENT").credit, expected.adjustment);
    assert.equal(byCode("PLATFORM_COMPENSATION_FEE").credit, expected.fee);
    assert.equal(byCode("CAPTURED_PAYMENT_SOURCE").debit, "47000");
    const feeEntry = (await pool.query<{ credit: string; details: Record<string, any> }>(
      `SELECT credit_cents::text AS credit, details FROM zzsh_order.settlement_ledger_entry
        WHERE posting_id = (SELECT id FROM zzsh_order.settlement_posting WHERE order_id = $1) AND account_code = 'PLATFORM_COMPENSATION_FEE'`, [orderId])).rows;
    assert.equal(feeEntry.length, 1);
    assert.deepEqual({ credit: feeEntry[0]!.credit, rate: feeEntry[0]!.details.rate, payer: feeEntry[0]!.details.payer, base: feeEntry[0]!.details.base.amount },
      { credit: expected.fee, rate: "0.08", payer: expected.payer, base: expected.feeBase });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id = $1`, [orderId])).rows[0].n, 1);
    console.log("trg2 R2 selected manual", JSON.stringify({ branch, orderId, settlementVersionId, feeCents: expected.fee,
      feeBase: expected.feeBase, payer: expected.payer, ownerAvailableCents: expected.finalOwner, renterRefundCents: expected.finalRefund,
      manualAdjustmentCents: expected.adjustment, platformContributionCents: expected.platform }));
  };
  const assertV2GuardInsert = async (label: string, mutate: (snapshot: Record<string, any>) => void, expectRejected = true) => {
    const base = (await pool.query<{
      accountId: string; listingVersionId: string; ownerUserId: string; renterUserId: string; gameId: string;
      releaseId: string; contentHash: string; termOptionCode: string; rentalAmount: string; depositAmount: string;
      currency: string; termSeconds: string; quote: Record<string, any>; title: string;
    }>(`SELECT account_id AS "accountId", listing_version_id AS "listingVersionId", owner_user_id AS "ownerUserId",
             renter_user_id AS "renterUserId", game_id AS "gameId", rule_release_id AS "releaseId", content_hash AS "contentHash",
             term_option_code AS "termOptionCode", rental_amount_cents::text AS "rentalAmount", deposit_amount_cents::text AS "depositAmount",
             currency, term_seconds::text AS "termSeconds", quote_snapshot AS quote, title
        FROM zzsh_order.rental_order WHERE id = $1`, [v2Normal.orderId])).rows[0]!;
    const confirmationId = randomUUID();
    const snapshot = JSON.parse(JSON.stringify(base.quote)) as Record<string, any>;
    snapshot.confirmationId = confirmationId;
    snapshot.confirmationDigest = "ab".repeat(32);
    snapshot.confirmationExpiresAt = String(Math.floor(Date.now() / 1000) + 3600);
    mutate(snapshot);
    const beforeGuardRows = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE id LIKE 'guard_v2_%'`)).rows[0]!.n;
    const client = await pool.connect();
    let rejected = false;
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO zzsh_order.rental_order
        (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash,
         term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until, confirmation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_PAYMENT',$11,$12,$13,$14,$15::jsonb,$16,clock_timestamp() + interval '1 hour',$17)`, [
        `guard_v2_${randomUUID().replaceAll("-", "")}`, `ZZ-GUARD-${randomUUID().replaceAll("-", "")}`,
        base.accountId, base.listingVersionId, base.ownerUserId, base.renterUserId, base.gameId, base.releaseId, base.contentHash,
        base.termOptionCode, base.rentalAmount, base.depositAmount, base.currency, base.termSeconds, JSON.stringify(snapshot), base.title, confirmationId,
      ]);
    } catch (error) {
      rejected = true;
      assert.equal(expectRejected, true, `${label} unchanged control must be accepted before testing mutations`);
      assert.equal((error as { code?: string }).code, "40001", `${label} must be rejected by the personal snapshot guard`);
      assert.match((error as { where?: string }).where ?? "", /guard_personal_order/, `${label} must fail in the intended personal snapshot guard`);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    assert.equal(rejected, expectRejected, `${label} produced an unexpected guard result`);
    const afterGuardRows = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE id LIKE 'guard_v2_%'`)).rows[0]!.n;
    assert.equal(afterGuardRows, beforeGuardRows, `${label} must leave no persisted order side effect`);
  };
  const v2Normal = await settleV2("B3B1 v2正常号主承担", "NORMAL");
  await setMembershipTier("STANDARD");
  await assertV2GuardInsert("unchanged v2 snapshot control", () => undefined, false);
  const v2GuardNegativeCases: Array<[string, (snapshot: Record<string, any>) => void]> = [
    ["schema null", (snapshot: Record<string, any>) => { snapshot.personal.schema = null; }],
    ["unknown schema", (snapshot: Record<string, any>) => { snapshot.personal.schema = "personal-quote-v3"; }],
    ["owner binding mismatch", (snapshot: Record<string, any>) => { snapshot.personal.ownerUserId = "wrong-owner"; }],
    ["account binding mismatch", (snapshot: Record<string, any>) => { snapshot.personal.accountId = "wrong-account"; }],
    ["listing version binding mismatch", (snapshot: Record<string, any>) => { snapshot.personal.listingVersionId = "wrong-version"; }],
    ["listing hash binding mismatch", (snapshot: Record<string, any>) => { snapshot.personal.listingHash = "00".repeat(32); }],
    ["root quote price binding mismatch", (snapshot: Record<string, any>) => { snapshot.priceVersionId = "wrong-price"; }],
    ["root quote term wrong type", (snapshot: Record<string, any>) => { snapshot.termSeconds = Number(snapshot.termSeconds); }],
    ["duplicate nested quote", (snapshot: Record<string, any>) => { snapshot.personal.quote = { priceVersionId: snapshot.priceVersionId }; }],
    ["declaration missing", (snapshot: Record<string, any>) => { delete snapshot.personal.fullPayoutDeclaration; }],
    ["declaration selected null", (snapshot: Record<string, any>) => { snapshot.personal.fullPayoutDeclaration.selected = null; }],
    ["membership sourceRef null", (snapshot: Record<string, any>) => { snapshot.personal.membership.sourceRef = null; }],
    ["membership tier unknown", (snapshot: Record<string, any>) => { snapshot.personal.membership.tier = "UNKNOWN"; }],
    ["policy version missing", (snapshot: Record<string, any>) => { delete snapshot.personal.funding.fullPayoutPolicyVersion; }],
    ["policy version null", (snapshot: Record<string, any>) => { snapshot.personal.funding.fullPayoutPolicyVersion = null; }],
    ["funding base deposit wrong type", (snapshot: Record<string, any>) => { snapshot.personal.funding.baseDepositCents = 30000; }],
    ["legacy fee field", (snapshot: Record<string, any>) => { snapshot.personal.funding.fullPayoutFeeCents = "0"; }],
    ["rule references null", (snapshot: Record<string, any>) => { snapshot.personal.ruleRefs = null; }],
    ["rule release binding mismatch", (snapshot: Record<string, any>) => { snapshot.personal.ruleRefs.releaseId = "wrong-release"; }],
    ["confirmation expired", (snapshot: Record<string, any>) => { snapshot.confirmationExpiresAt = String(Math.floor(Date.now() / 1000) - 1); }],
  ];
  for (const [label, mutate] of v2GuardNegativeCases) {
    await assertV2GuardInsert(label, mutate);
  }
  const duplicateBase = (await pool.query<{ accountId: string; listingVersionId: string; ownerUserId: string; renterUserId: string; gameId: string; releaseId: string; contentHash: string; termOptionCode: string; rentalAmount: string; depositAmount: string; currency: string; termSeconds: string; quote: Record<string, any>; title: string; confirmationId: string }>(
    `SELECT account_id AS "accountId", listing_version_id AS "listingVersionId", owner_user_id AS "ownerUserId", renter_user_id AS "renterUserId",
            game_id AS "gameId", rule_release_id AS "releaseId", content_hash AS "contentHash", term_option_code AS "termOptionCode",
            rental_amount_cents::text AS "rentalAmount", deposit_amount_cents::text AS "depositAmount", currency, term_seconds::text AS "termSeconds",
            quote_snapshot AS quote, title, confirmation_id AS "confirmationId"
       FROM zzsh_order.rental_order WHERE id = $1`, [v2Normal.orderId])).rows[0]!;
  const duplicateClient = await pool.connect();
  let duplicateRejected = false;
  try {
    await duplicateClient.query("BEGIN");
    await duplicateClient.query(`INSERT INTO zzsh_order.rental_order
      (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash,
       term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until, confirmation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_PAYMENT',$11,$12,$13,$14,$15::jsonb,$16,clock_timestamp() + interval '1 hour',$17)`, [
      `guard_duplicate_${randomUUID().replaceAll("-", "")}`, `ZZ-GUARD-DUP-${randomUUID().replaceAll("-", "")}`,
      duplicateBase.accountId, duplicateBase.listingVersionId, duplicateBase.ownerUserId, duplicateBase.renterUserId, duplicateBase.gameId,
      duplicateBase.releaseId, duplicateBase.contentHash, duplicateBase.termOptionCode, duplicateBase.rentalAmount, duplicateBase.depositAmount,
      duplicateBase.currency, duplicateBase.termSeconds, JSON.stringify(duplicateBase.quote), duplicateBase.title, duplicateBase.confirmationId,
    ]);
  } catch (error) {
    duplicateRejected = true;
    assert.equal((error as { code?: string; constraint?: string }).code, "23505");
    assert.equal((error as { constraint?: string }).constraint, "rental_order_confirmation_unique");
  } finally {
    await duplicateClient.query("ROLLBACK").catch(() => undefined);
    duplicateClient.release();
  }
  assert.equal(duplicateRejected, true, "a consumed confirmation must remain single-use");
  const immutableClient = await pool.connect();
  let immutableRejected = false;
  try {
    await immutableClient.query("BEGIN");
    await immutableClient.query(`UPDATE zzsh_order.rental_order SET quote_snapshot = jsonb_set(quote_snapshot, '{personal,listingHash}', '"00"') WHERE id = $1`, [v2Normal.orderId]);
  } catch (error) {
    immutableRejected = true;
    assert.equal((error as { code?: string }).code, "40001");
  } finally {
    await immutableClient.query("ROLLBACK").catch(() => undefined);
    immutableClient.release();
  }
  assert.equal(immutableRejected, true, "a persisted v2 snapshot must remain immutable");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE id LIKE 'guard_v2_%' OR id LIKE 'guard_duplicate_%'`)).rows[0].n, 0);
  console.log("trb3b1 v2 guard negatives", JSON.stringify({ rejectedCases: v2GuardNegativeCases.length, duplicateConfirmationRejected: duplicateRejected, immutableSnapshotRejected: immutableRejected }));
  const v2TenantEarly = await settleV2("B3B1 v2租客自愿提前", "TENANT_EARLY");
  const v2OwnerEarly = await settleV2("B3B1 v2号主提前承担", "OWNER_EARLY");
  const v2ZeroFee = await settleV2("B3B1 v2已选但零实耗", "OWNER_ZERO_EARLY");
  assert.ok(BigInt(v2Normal.feeCents) > 0n && BigInt(v2TenantEarly.feeCents) > 0n && BigInt(v2OwnerEarly.feeCents) > 0n);
  assert.equal(v2ZeroFee.feeCents, "0");
  await settleSelectedManual("NORMAL");
  await settleSelectedManual("TENANT_EARLY");
  await setMembershipTier("STANDARD");
  const normalId = await makePaid("结算正常");
  await joinTeam(normalId);
  const actorGate = await ownerPool.connect();
  let actorGateOpen = false;
  try {
    await actorGate.query("BEGIN");
    await actorGate.query(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id = $1 FOR UPDATE`, [staff.id]);
    const pendingReview = post(`/api/v1/admin/orders/${normalId}/settlements/settle_missing/review`, { versionHash: "ab".repeat(32) }, staff.jar, ADMIN_ORIGIN, key());
    const actorDeadline = Date.now() + 5_000;
    while (Date.now() < actorDeadline && await waiters() < 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(await waiters() >= 1, "staff review must wait on the admin lock before party user locks");
    await actorGate.query(`SELECT id FROM zzsh_auth_user."user" WHERE id = $1 FOR UPDATE`, [buyer.id]);
    await actorGate.query("COMMIT");
    actorGateOpen = true;
    assert.equal((await pendingReview).response.status, 409);
  } finally {
    if (!actorGateOpen) await actorGate.query("ROLLBACK");
    actorGate.release();
  }
  await addMember(normalId, collaborator.id);
  await addMember(normalId, reader.id);
  const lines = await openingBody(normalId);
  const hidden = process.env.ZZSH_SETTLEMENT_RECORDING;
  delete process.env.ZZSH_SETTLEMENT_RECORDING;
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, staff.jar, ADMIN_ORIGIN, key())).response.status, 404);
  process.env.ZZSH_SETTLEMENT_RECORDING = hidden;

  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, { lines: lines.lines.map((line) => ({ ...line, quantity: "1" })) }, staff.jar, ADMIN_ORIGIN, key())).body?.reasons?.[0], "OPENING_QUANTITY_MISMATCH");
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, outsider.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, reader.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/settlement`, undefined, reader.jar, ADMIN_ORIGIN)).response.status, 200);
  const stranger: Jar = (() => {
    const values = new Map<string, string>();
    return {
      header: () => [...values].map(([name, value]) => `${name}=${value}`).join("; "),
      update(response) {
        for (const raw of response.headers.getSetCookie()) {
          const [pair, ...attributes] = raw.split(";");
          const separator = pair?.indexOf("=") ?? -1;
          if (!pair || separator < 1) continue;
          const name = pair.slice(0, separator).trim();
          if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) values.delete(name);
          else values.set(name, pair.slice(separator + 1).trim());
        }
      },
    };
  })();
  const signed = await o.request(o.base, "/api/auth/user/sign-up/email", { email: `settle-${run}@example.invalid`, password: "Sup3rSecret#Order", name: "无关用户", username: `settle_${run}` }, stranger, USER_ORIGIN, "POST");
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body));
  const unrelated = await post(`/api/v1/orders/${normalId}/settlement`, undefined, stranger);
  assert.equal(unrelated.response.status, 404, JSON.stringify(unrelated.body));

  const first = await post(`/api/v1/admin/orders/${normalId}/openings`, lines, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  const second = await post(`/api/v1/admin/orders/${normalId}/openings`, lines, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  const seen = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
  const openings = seen.body!.openings as Array<{ id: string; versionNo: number; quoteDigest: string; paymentDigest: string; lines: Array<{ itemId: string; quantity: string; unit: string; pricingKind: string }> }>;
  const stale = openings.find((row) => row.versionNo === 1)!;
  const current = openings.find((row) => row.versionNo === 2)!;
  assert.equal(current.lines.length, lines.lines.length);
  assert.ok(current.lines.every((line) => line.quantity.length > 0 && line.unit.length > 0 && line.pricingKind.length > 0));
  assert.match(current.quoteDigest, /^[0-9a-f]{64}$/);
  assert.match(current.paymentDigest, /^[0-9a-f]{64}$/);
  const sameKey = key();
  const replay = await Promise.all([
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.buyer, USER_ORIGIN, sameKey),
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.buyer, USER_ORIGIN, sameKey),
  ]);
  assert.equal(replay[0]!.response.status, 200);
  assert.deepEqual(replay[0]!.body, replay[1]!.body);
  assert.equal((await post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 1 }, o.buyer, USER_ORIGIN, sameKey)).body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
  const concurrentOpen = await holdOrder(normalId, [
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.owner, USER_ORIGIN, key()),
    post(`/api/v1/orders/${normalId}/openings/${stale.id}/confirm`, { versionNo: 1 }, o.owner, USER_ORIGIN, key()),
  ]);
  assert.equal((concurrentOpen as Array<{ response: { status: number }; body: any }>).filter((row) => row.response.status === 200).length, 1);
  const opened = (await pool.query(`SELECT status, confirmed_at IS NOT NULL AS confirmed FROM zzsh_order.rental_opening WHERE order_id = $1 AND status = 'CONFIRMED'`, [normalId])).rows;
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.confirmed, true);
  assert.equal((await post(`/api/v1/orders/${normalId}/openings/${stale.id}/confirm`, { versionNo: 1 }, o.buyer, USER_ORIGIN, key())).body?.reasons?.[0], "STALE_OPENING");

  const remain = await remainingBody(normalId, "0");
  const preview = await post(`/api/v1/orders/${normalId}/settlement-preview`, remain, o.buyer);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body!.postingAuthorized, false);
  assert.equal(preview.body!.feeDeducted, false);
  assert.equal(preview.body!.early, false);
  assertNoSettlementInternals(preview.body);
  assert.equal(typeof preview.body!.amounts.haffConsumedBuyer, "string");
  assert.equal(typeof preview.body!.amounts.renterRefund, "string");
  const submittedKeys = [key(), key()];
  const submittedPair = await holdOrder(normalId, [
    post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, submittedKeys[0]),
    post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, submittedKeys[1]),
  ]) as Array<{ response: { status: number }; body: any }>;
  const submitted = submittedPair.find((row) => row.response.status === 200);
  assert.ok(submitted, JSON.stringify(submittedPair.map((row) => row.body)));
  const winKey = submittedKeys[submittedPair.findIndex((row) => row.response.status === 200)]!;
  assert.equal(submittedPair.filter((row) => row.response.status === 409).length, 1);
  assert.equal(submittedPair.find((row) => row.response.status === 409)!.body.reasons[0], "SETTLEMENT_HASH_MISMATCH");
  assert.deepEqual((await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, winKey)).body, submitted.body);
  assert.equal(submitted.body!.ready, false);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1 AND superseded_at IS NULL`, [normalId])).rows[0].n, 1);
  const versionId = submitted.body!.settlement.id as string;
  const again = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: "0".repeat(64) }, o.buyer, USER_ORIGIN, key());
  assert.equal(again.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  const noOwnerConfirm = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.owner);
  assert.equal(noOwnerConfirm.body!.ready, false);
  assert.ok(noOwnerConfirm.body!.reasons.includes("OWNER_CONFIRMATION_MISSING"));
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.approval_execution e JOIN zzsh_iam.approval_request r ON r.id = e.request_id WHERE r.operation_code = 'order.settlement.adjust'`)).rows[0].n, 0);
  const covered = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(covered.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  const afterStalePreview = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
  assert.equal(afterStalePreview.body!.ready, false);
  assert.ok(afterStalePreview.body!.reasons.includes("OWNER_CONFIRMATION_MISSING"));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1`, [normalId])).rows[0].n, 1);
  const fresh = await post(`/api/v1/orders/${normalId}/settlement-preview`, remain, o.buyer);
  assert.notEqual(fresh.body!.versionHash, preview.body!.versionHash);
  const renewed = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: fresh.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body));
  assert.notEqual(renewed.body!.settlement.versionHash, preview.body!.versionHash);
  const rejected = await post(`/api/v1/orders/${normalId}/settlements/${renewed.body!.settlement.id}/decision`, { action: "REJECT", versionHash: renewed.body!.settlement.versionHash, reason: "数量有误" }, o.owner, USER_ORIGIN, key());
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
  const traced = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.owner);
  const tracedVersions = traced.body!.versions as Array<{ versionNo: number; supersededAt: string | null; decisions: Array<{ action: string }> }>;
  assert.ok(tracedVersions.some((row) => row.versionNo === 1 && row.supersededAt));
  assert.ok(tracedVersions.some((row) => row.decisions.some((decision) => decision.action === "REJECT")));

  const earlyId = await makePaid("结算提前");
  await joinTeam(earlyId);
  await addMember(earlyId, collaborator.id);
  await addMember(earlyId, reader.id);
  const earlyLines = await openingBody(earlyId);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/openings`, earlyLines, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const earlySeen = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.owner);
  const earlyOpening = (earlySeen.body!.openings as Array<{ id: string; versionNo: number; lines: Array<{ itemId: string; quantity: string; pricingKind: string }> }>).find((row) => row.versionNo === 1)!;
  await post(`/api/v1/orders/${earlyId}/openings/${earlyOpening.id}/confirm`, { versionNo: earlyOpening.versionNo }, o.buyer, USER_ORIGIN, key());
  await post(`/api/v1/orders/${earlyId}/openings/${earlyOpening.id}/confirm`, { versionNo: earlyOpening.versionNo }, o.owner, USER_ORIGIN, key());
  const earlyRemain = { lines: earlyOpening.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.quantity })) };
  const haffLine = earlyOpening.lines.find((line) => line.pricingKind === "HAFF_RATIO");
  assert.ok(haffLine);
  assert.ok(BigInt(haffLine.quantity) > 1n);
  const normalRemain = { lines: earlyOpening.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.itemId === haffLine.itemId ? "0" : line.quantity })) };
  const normalPreviewBeforeIntake = await post(`/api/v1/orders/${earlyId}/settlement-preview`, normalRemain, o.buyer);
  assert.equal(normalPreviewBeforeIntake.body!.early, false);
  assertNoSettlementInternals(normalPreviewBeforeIntake.body);
  const earlyPreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.equal(earlyPreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  assert.match(earlyPreview.body!.versionHash, /^[0-9a-f]{64}$/);
  assertNoSettlementInternals(earlyPreview.body);
  const oldStaffPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...earlyRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, staff.jar, ADMIN_ORIGIN);
  assert.equal(oldStaffPreview.response.status, 200, JSON.stringify(oldStaffPreview.body));
  const intakeRequests = [
    { party: "RENTER" as const, jar: o.buyer, requestKey: key() },
    { party: "OWNER" as const, jar: o.owner, requestKey: key() },
  ];
  const competingIntakes = await holdOrder(earlyId, intakeRequests.map(({ jar, requestKey }) =>
    post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, jar, USER_ORIGIN, requestKey),
  )) as Array<{ response: Response; body: Record<string, any> }>;
  assert.equal(competingIntakes.filter((row) => row.response.status === 200).length, 1);
  assert.equal(competingIntakes.filter((row) => row.response.status === 409).length, 1);
  assert.equal(competingIntakes.find((row) => row.response.status === 409)!.body.reasons[0], "SETTLEMENT_HASH_MISMATCH");
  const intakeWinnerIndex = competingIntakes.findIndex((row) => row.response.status === 200);
  const winningRequest = intakeRequests[intakeWinnerIndex]!;
  const intakeKey = winningRequest.requestKey;
  const intake = competingIntakes[intakeWinnerIndex]!;
  assert.equal(intake.response.status, 200, JSON.stringify(intake.body));
  assert.equal(intake.body!.settlement, null);
  assert.equal(intake.body!.ready, false);
  assert.deepEqual(intake.body!.currentRequest, { kind: "INTAKE", id: intake.body!.intakes.at(-1).id, versionNo: 1, status: "OPEN" });
  assert.equal(intake.body!.intakes.at(-1).status, "OPEN");
  assert.equal(intake.body!.intakes.at(-1).initiatorParty, winningRequest.party);
  const stableEarlyRemain = earlyRemain.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.remainingQuantity })).sort((a, b) => a.itemId.localeCompare(b.itemId));
  assert.deepEqual(intake.body!.intakes.at(-1).lines, stableEarlyRemain);
  const stateWithOpenIntake = await settlementState(earlyId);
  assert.deepEqual(stateWithOpenIntake, { intakes: 1, versions: 0, decisions: 0, settlementAudits: 1, adjustmentApprovals: 2, adjustmentAudits: 2, postings: 0, ledgerentries: 0 });
  const staleParty = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  const staleNormal = await post(`/api/v1/orders/${earlyId}/settlements`, { ...normalRemain, acceptedHash: normalPreviewBeforeIntake.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  const staleStaff = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...earlyRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: oldStaffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  for (const stale of [staleParty, staleNormal, staleStaff]) {
    assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  }
  assert.deepEqual(await settlementState(earlyId), stateWithOpenIntake);
  assert.deepEqual((await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body, intake.body);
  const differentBody = { ...earlyRemain, lines: earlyRemain.lines.map((line, index) => index === 0 ? { ...line, remainingQuantity: line.remainingQuantity === "0" ? "1" : "0" } : line) };
  assert.equal((await post(`/api/v1/orders/${earlyId}/settlements`, { ...differentBody, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body!.error.code, "IDEMPOTENCY_KEY_REUSED");

  const sameQuantityPreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.notEqual(sameQuantityPreview.body!.versionHash, earlyPreview.body!.versionHash);
  const replacement = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: sameQuantityPreview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body!.intakes[0].status, "SUPERSEDED");
  assert.equal(replacement.body!.intakes[1].status, "OPEN");
  assert.equal(replacement.body!.intakes[0].lines[0].remainingQuantity, replacement.body!.intakes[1].lines[0].remainingQuantity);
  const replacementState = await settlementState(earlyId);
  const staleAba = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: sameQuantityPreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  assert.equal(staleAba.response.status, 409);
  assert.deepEqual(await settlementState(earlyId), replacementState);
  assert.deepEqual((await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body, intake.body);

  const modifiedQuantity = (BigInt(haffLine.quantity) - 1n).toString();
  const modifiedRemain = { lines: earlyRemain.lines.map((line) => ({ ...line, remainingQuantity: line.itemId === haffLine.itemId ? modifiedQuantity : line.remainingQuantity })) };
  const fixedOpeningLine = earlyOpening.lines.find((line) => line.pricingKind === "FIXED_UNIT")!;
  const partialItemRemaining = (BigInt(fixedOpeningLine.quantity) / 2n).toString();
  assert.ok(BigInt(partialItemRemaining) > 0n && BigInt(partialItemRemaining) < BigInt(fixedOpeningLine.quantity));
  const partialRemain = { lines: modifiedRemain.lines.map((line) => ({
    ...line,
    remainingQuantity: line.itemId === fixedOpeningLine.itemId ? partialItemRemaining : line.remainingQuantity,
  })) };
  const staffPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, staff.jar, ADMIN_ORIGIN);
  assert.equal(staffPreview.response.status, 200, JSON.stringify(staffPreview.body));
  const joinedPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, collaborator.jar, ADMIN_ORIGIN);
  assert.equal(joinedPreview.response.status, 200, JSON.stringify(joinedPreview.body));
  assertNoSettlementInternals(joinedPreview.body);
  assert.ok(joinedPreview.body!.amounts.haffConsumedBuyer);
  const classified = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: staffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(classified.response.status, 200, JSON.stringify(classified.body));
  const earlyVersion = classified.body!.settlement.id as string;
  const earlyHash = classified.body!.settlement.versionHash as string;
  const classifiedIntake = classified.body!.intakes[1];
  assert.equal(classifiedIntake.status, "CLASSIFIED");
  assert.equal(classifiedIntake.settlementVersionId, earlyVersion);
  assert.deepEqual(classified.body!.currentRequest, { kind: "SETTLEMENT_VERSION", id: earlyVersion, versionNo: 1 });
  const settlementSnapshot = (await pool.query(`SELECT input_snapshot AS snapshot FROM zzsh_order.settlement_version WHERE id = $1`, [earlyVersion])).rows[0].snapshot;
  assert.deepEqual(settlementSnapshot.baseIntake, { id: classifiedIntake.id, versionNo: classifiedIntake.versionNo, status: "OPEN", settlementVersionId: null });
  assert.equal(settlementSnapshot.lines.find((line: any) => line.itemId === haffLine.itemId).remainingQuantity, modifiedQuantity);
  const classificationAudit = (await pool.query(`SELECT details FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.submitted' AND outcome = 'SUCCESS' ORDER BY occurred_at DESC LIMIT 1`, [earlyId])).rows[0].details;
  assert.equal(classificationAudit.intakeId, classifiedIntake.id);
  assert.equal(classificationAudit.intakeQuantityModified, true);
  assert.deepEqual(classificationAudit.intakeSourceLines, classifiedIntake.lines);
  assert.deepEqual(classificationAudit.classifiedLines, stableEarlyRemain.map((line) => ({ ...line, remainingQuantity: line.itemId === haffLine.itemId ? modifiedQuantity : line.remainingQuantity })));
  const stateAfterClassify = await settlementState(earlyId);
  const staleClassify = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: staffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(staleClassify.response.status, 409);
  assert.deepEqual(await settlementState(earlyId), stateAfterClassify);
  const reviewsBefore = await successAudits(earlyId, "order.settlement.reviewed");
  const prematureReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(prematureReview.body!.reasons?.[0], "PARTY_CONFIRMATION_MISSING");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND action = 'REVIEW'`, [earlyVersion])).rows[0].n, 0);
  assert.equal(await successAudits(earlyId, "order.settlement.reviewed"), reviewsBefore);
  const both = await holdOrder(earlyId, [
    post(`/api/v1/orders/${earlyId}/settlements/${earlyVersion}/decision`, { action: "CONFIRM", versionHash: earlyHash }, o.buyer, USER_ORIGIN, key()),
    post(`/api/v1/orders/${earlyId}/settlements/${earlyVersion}/decision`, { action: "CONFIRM", versionHash: earlyHash }, o.owner, USER_ORIGIN, key()),
  ]);
  for (const row of both as Array<{ response: { status: number }; body: any }>) assert.equal(row.response.status, 200, JSON.stringify(row.body));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1 AND superseded_at IS NULL`, [earlyId])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND action = 'CONFIRM'`, [earlyVersion])).rows[0].n, 2);
  const beforeReview = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  assert.equal(beforeReview.body!.ready, false);
  assert.ok(beforeReview.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
  const stateBeforePendingIntake = await settlementState(earlyId);
  const nextIntakePreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.equal(nextIntakePreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  const pendingIntake = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: nextIntakePreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  assert.equal(pendingIntake.response.status, 200, JSON.stringify(pendingIntake.body));
  assert.equal(pendingIntake.body!.ready, false);
  assert.ok(pendingIntake.body!.reasons.includes("SETTLEMENT_INTAKE_PENDING"));
  assert.equal(pendingIntake.body!.settlement, null);
  assert.deepEqual(pendingIntake.body!.currentRequest, {
    kind: "INTAKE", id: pendingIntake.body!.intakes.at(-1).id, versionNo: 3, status: "OPEN",
  });
  assert.equal(pendingIntake.body!.orderStatus, "PAID");
  assert.equal(pendingIntake.body!.posting, null);
  assert.equal(pendingIntake.body!.postingAuthorized, false);
  assert.equal(pendingIntake.body!.feeDeducted, false);
  const retainedReadyVersion = pendingIntake.body!.versions.find((version: any) => version.id === earlyVersion);
  assert.equal(retainedReadyVersion.supersededAt, null);
  assert.equal(retainedReadyVersion.decisions.length, 2);
  const stateAfterPendingIntake = await settlementState(earlyId);
  assert.equal(stateAfterPendingIntake.versions, stateBeforePendingIntake.versions);
  assert.equal(stateAfterPendingIntake.decisions, stateBeforePendingIntake.decisions);
  assert.equal(stateAfterPendingIntake.intakes, stateBeforePendingIntake.intakes + 1);
  const blockedReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(blockedReview.response.status, 409);
  assert.equal(blockedReview.body!.reasons?.[0], "SETTLEMENT_INTAKE_PENDING");
  assert.deepEqual(await settlementState(earlyId), stateAfterPendingIntake);

  const reclassPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, {
    ...partialRemain, endReason: "TENANT_VOLUNTARY_EARLY",
  }, staff.jar, ADMIN_ORIGIN);
  const reclassified = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, {
    ...partialRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: reclassPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(reclassified.response.status, 200, JSON.stringify(reclassified.body));
  const postingVersion = reclassified.body!.settlement.id as string;
  const postingHash = reclassified.body!.settlement.versionHash as string;
  assert.equal(reclassified.body!.settlement.versionNo, 2);
  assert.equal(reclassified.body!.intakes.at(-1).status, "CLASSIFIED");
  assert.equal(reclassified.body!.intakes.at(-1).settlementVersionId, postingVersion);
  assert.ok((await pool.query(`SELECT superseded_at FROM zzsh_order.settlement_version WHERE id = $1`, [earlyVersion])).rows[0].superseded_at);
  const staleReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(staleReview.response.status, 409);
  assert.equal(staleReview.body!.reasons?.[0], "STALE_VERSION");
  const postedConfirms = await holdOrder(earlyId, [
    post(`/api/v1/orders/${earlyId}/settlements/${postingVersion}/decision`, { action: "CONFIRM", versionHash: postingHash }, o.buyer, USER_ORIGIN, key()),
    post(`/api/v1/orders/${earlyId}/settlements/${postingVersion}/decision`, { action: "CONFIRM", versionHash: postingHash }, o.owner, USER_ORIGIN, key()),
  ]);
  for (const row of postedConfirms as Array<{ response: { status: number }; body: any }>) assert.equal(row.response.status, 200, JSON.stringify(row.body));
  const afterBothPostedConfirms = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  assert.equal(afterBothPostedConfirms.body!.ready, false);
  assert.ok(afterBothPostedConfirms.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
  assert.equal(afterBothPostedConfirms.body!.posting, null);
  const reviewStateBeforeFailure = await settlementState(earlyId);
  assert.ok(/^[a-z][a-z0-9_]*$/.test(o.runtimeUser));
  const reviewKey = key();
  await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`);
  const rolledBackReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, collaborator.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(rolledBackReview.response.status, 500);
  assert.deepEqual(await settlementState(earlyId), reviewStateBeforeFailure);
  await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`);
  const reviewed = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, staff.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body!.ready, true);
  assert.equal(reviewed.body!.orderStatus, "COMPLETED");
  assert.equal(reviewed.body!.postingAuthorized, true);
  assert.equal(reviewed.body!.feeDeducted, false);
  assert.equal(reviewed.body!.posting.early, true);
  assert.ok(BigInt(String(reviewed.body!.posting.amounts.unusedItemRefund).replace(".", "")) > 0n);
  assert.equal((await pool.query(`SELECT extract(epoch FROM (refund_due_at - posted_at))::int AS seconds FROM zzsh_order.settlement_posting WHERE order_id = $1`, [earlyId])).rows[0].seconds, 604800);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'OWNER_AVAILABLE' AND credit_cents > 0`, [reviewed.body!.posting.id])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id = $1`, [earlyId])).rows[0].n, 1);
  assert.ok(reviewed.body!.posting.ledgerEntries.length > 0);
  assert.equal(typeof reviewed.body!.posting.platformContributionCents, "string");
  assert.equal(reviewed.body!.versions.find((version: any) => version.id === postingVersion).inputSnapshot.fundingSourceRef, FUNDING.sourceRef);
  const internalRead = await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, staff.jar, ADMIN_ORIGIN);
  assert.equal(internalRead.response.status, 200);
  assert.ok(internalRead.body!.posting.ledgerEntries.length > 0);
  assert.equal(typeof internalRead.body!.posting.platformContributionCents, "string");
  const privilegedReceiptCounts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $2) AS entries,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.posted' AND outcome = 'SUCCESS') AS "postedAudits"`, [earlyId, reviewed.body!.posting.id])).rows[0];
  await pool.query(`DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id = $1 AND permission_code = 'supply.quote.internal.read'`, [staff.id]);
  const revokedReplay = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, staff.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(revokedReplay.response.status, 200, JSON.stringify(revokedReplay.body));
  assertNoSettlementInternals(revokedReplay.body);
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $2) AS entries,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.posted' AND outcome = 'SUCCESS') AS "postedAudits"`, [earlyId, reviewed.body!.posting.id])).rows[0], privilegedReceiptCounts);
  const readerView = await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, reader.jar, ADMIN_ORIGIN);
  assert.equal(readerView.response.status, 200, JSON.stringify(readerView.body));
  assertNoSettlementInternals(readerView.body);
  assert.equal(typeof readerView.body!.posting.owner.availableCents, "string");
  assert.ok(readerView.body!.versions.some((version: any) => version.inputSnapshot.amounts.renterRefund));
  const buyerView = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  const ownerView = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.owner);
  assert.equal(buyerView.response.status, 200);
  assert.equal(ownerView.response.status, 200);
  for (const partyView of [buyerView, ownerView]) {
    assertNoSettlementInternals(partyView.body);
    assert.equal(typeof partyView.body!.posting.owner.availableCents, "string");
    assert.equal(typeof partyView.body!.posting.refund.payableCents, "string");
    assert.ok(partyView.body!.versions.some((version: any) => version.computation.amounts.haffConsumedBuyer));
  }

  const adjustPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额",
  }, staff.jar, ADMIN_ORIGIN);
  assert.equal(adjustPreview.response.status, 200, JSON.stringify(adjustPreview.body));
  const earlyApplication = { lines: lines.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.quantity })) };
  const earlyApplicationPreview = await post(`/api/v1/orders/${normalId}/settlement-preview`, earlyApplication, o.buyer);
  assert.equal(earlyApplicationPreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  const earlyApplicationResult = await post(`/api/v1/orders/${normalId}/settlements`, { ...earlyApplication, acceptedHash: earlyApplicationPreview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(earlyApplicationResult.response.status, 200, JSON.stringify(earlyApplicationResult.body));
  const adjustmentBaseline = await settlementState(normalId);
  const staleAdjustment = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额", acceptedHash: adjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(staleAdjustment.response.status, 409);
  assert.equal(staleAdjustment.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  assert.deepEqual(await settlementState(normalId), adjustmentBaseline);
  const freshAdjustPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额",
  }, staff.jar, ADMIN_ORIGIN);
  assert.notEqual(freshAdjustPreview.body!.versionHash, adjustPreview.body!.versionHash);
  const tooMuch = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "999999.00", proposedRenterRefund: "999999.00", reason: "超出实收", acceptedHash: freshAdjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(tooMuch.body!.reasons?.[0], "FUNDING_SOURCE_REQUIRED");
  const adjusted = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额", acceptedHash: freshAdjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(adjusted.response.status, 200, JSON.stringify(adjusted.body));
  assert.equal(adjusted.body!.ready, false);
  assertNoSettlementInternals(adjusted.body);
  const adjustmentRecord = (await pool.query<{ approvalRequestId: string; inputSnapshot: Record<string, any> }>(
    `SELECT approval_request_id AS "approvalRequestId", input_snapshot AS "inputSnapshot"
       FROM zzsh_order.settlement_version WHERE id = $1`, [adjusted.body!.settlement.id],
  )).rows[0]!;
  assert.equal(adjustmentRecord.inputSnapshot.fundingSourceRef, "fixture:isolated-authority");
  const approvalId = adjustmentRecord.approvalRequestId;
  assert.equal(adjustmentRecord.inputSnapshot.baseIntake.id, earlyApplicationResult.body!.intakes.at(-1).id);
  assert.equal(adjusted.body!.intakes.at(-1).status, "CLASSIFIED");
  assert.equal(adjusted.body!.intakes.at(-1).settlementVersionId, adjusted.body!.settlement.id);
  const adjustmentAudit = (await pool.query(`SELECT details FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.adjusted' AND outcome = 'SUCCESS' ORDER BY occurred_at DESC LIMIT 1`, [normalId])).rows[0].details;
  assert.equal(adjustmentAudit.intakeId, earlyApplicationResult.body!.intakes.at(-1).id);
  assert.equal(adjustmentAudit.intakeQuantityModified, true);
  const adjustedHashEarly = adjusted.body!.settlement.versionHash as string;
  const adjustedIdEarly = adjusted.body!.settlement.id as string;
  const staleOldDecision = await post(`/api/v1/orders/${normalId}/settlements/${renewed.body!.settlement.id}/decision`, {
    action: "CONFIRM", versionHash: renewed.body!.settlement.versionHash,
  }, o.owner, USER_ORIGIN, key());
  assert.equal(staleOldDecision.response.status, 409);
  assert.equal(staleOldDecision.body!.reasons?.[0], "STALE_VERSION");
  await assert.rejects(pool.query(
    `INSERT INTO zzsh_order.settlement_decision(id, settlement_version_id, version_hash, basis_hash, party, action, subject_id)
     VALUES ($1,$2,$3,$3,'RENTER','CONFIRM',$4)`,
    [`sdec_${randomUUID().replaceAll("-", "")}`, renewed.body!.settlement.id, renewed.body!.settlement.versionHash, buyer.id],
  ), (error: { code?: string }) => error.code === "40001");
  const decidesBefore = await successAudits(normalId, "order.settlement.decided");
  const prematureKey = key();
  const prematureConfirm = await post(`/api/v1/orders/${normalId}/settlements/${adjustedIdEarly}/decision`, { action: "CONFIRM", versionHash: adjustedHashEarly }, o.buyer, USER_ORIGIN, prematureKey);
  assert.equal(prematureConfirm.body!.reasons?.[0], "OPS_APPROVAL_MISSING");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1`, [adjustedIdEarly])).rows[0].n, 0);
  assert.equal(await successAudits(normalId, "order.settlement.decided"), decidesBefore);
  assert.equal((await pool.query(`SELECT response_status AS status FROM zzsh_supply.idempotency_record WHERE key = $1`, [prematureKey["idempotency-key"]])).rows[0].status, 409);
  assert.equal((await post(`/api/v1/orders/${normalId}/settlements/${adjustedIdEarly}/decision`, { action: "CONFIRM", versionHash: adjustedHashEarly }, o.buyer, USER_ORIGIN, prematureKey)).body!.reasons?.[0], "OPS_APPROVAL_MISSING");
  assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", { requestId: approvalId, decision: "APPROVE", reason: "自审" }, staff.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", { requestId: approvalId, decision: "APPROVE", reason: "同意净额" }, ops.jar, ADMIN_ORIGIN, key())).response.status, 200);
  assert.equal((await post("/api/v1/admin/security/approvals/requests/execute", { requestId: approvalId }, ops.jar, ADMIN_ORIGIN, key())).response.status, 409);
  assert.equal((await pool.query(`SELECT status FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].status, "APPROVED");
  const adjustedHash = adjusted.body!.settlement.versionHash as string;
  const adjustedId = adjusted.body!.settlement.id as string;
  await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, { action: "CONFIRM", versionHash: adjustedHash }, o.buyer, USER_ORIGIN, key());
  const manualConfirmKey = key();
  // Controlled expiry fixture: IAM status may remain APPROVED until its next action.
  const approvalDeadline = (await pool.query(`SELECT expires_at::text AS deadline FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].deadline;
  const beforeExpiryPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "2.00", proposedRenterRefund: "1.00", reason: "审批有效期回归",
  }, staff.jar, ADMIN_ORIGIN);
  assert.equal(beforeExpiryPreview.response.status, 200);
  const beforeExpiryState = await settlementState(normalId);
  await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [approvalId]);
  try {
    const expiredView = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
    assert.equal(expiredView.body!.ready, false);
    assert.ok(expiredView.body!.reasons.includes("OPS_APPROVAL_EXPIRED"));
    const expiredConfirmKey = key();
    const expiredConfirm = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, { action: "CONFIRM", versionHash: adjustedHash }, o.owner, USER_ORIGIN, expiredConfirmKey);
    assert.equal(expiredConfirm.response.status, 409);
    assert.equal(expiredConfirm.body!.reasons?.[0], "OPS_APPROVAL_EXPIRED");
    const staleExpiryPreview = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
      ...remain, proposedOwnerNet: "2.00", proposedRenterRefund: "1.00", reason: "审批有效期回归", acceptedHash: beforeExpiryPreview.body!.versionHash,
    }, staff.jar, ADMIN_ORIGIN, key());
    assert.equal(staleExpiryPreview.response.status, 409);
    assert.equal(staleExpiryPreview.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
    assert.deepEqual(await settlementState(normalId), beforeExpiryState);
    assert.equal((await pool.query(`SELECT status FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].status, "APPROVED");
  } finally {
    await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = $2::timestamptz WHERE id = $1`, [approvalId, approvalDeadline]);
  }
  assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.ready, false);
  const beforePostingState = await settlementState(normalId);
  await migrationPool.query(`REVOKE INSERT ON zzsh_order.settlement_ledger_entry FROM "${o.runtimeUser}"`);
  const failedPost = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  assert.equal(failedPost.response.status, 500);
  assert.deepEqual(await settlementState(normalId), beforePostingState);
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
  await migrationPool.query(`GRANT INSERT ON zzsh_order.settlement_ledger_entry TO "${o.runtimeUser}"`);
  const confirmManual = () => post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  const insertRuntimeLines = async (client: import("pg").PoolClient, postingId: string, rows: Array<{
    lineNo: number; accountCode: string; debit: string; credit: string; counterparty?: string | null; source?: string | null; details?: Record<string, unknown>;
  }>) => {
    const values = rows.flatMap((row) => [
      `sledger_${randomUUID().replaceAll("-", "")}`, postingId, row.lineNo, row.accountCode, row.debit, row.credit,
      row.counterparty ?? null, row.source ?? null, JSON.stringify(row.details ?? {}),
    ]);
    const tuples = rows.map((_, index) => {
      const first = index * 9 + 1;
      return `($${first},$${first + 1},$${first + 2},$${first + 3},$${first + 4},$${first + 5},$${first + 6},$${first + 7},$${first + 8}::jsonb)`;
    });
    await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry
      (id,posting_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
      VALUES ${tuples.join(",")}`, values);
  };
  const assertAssemblyRejected = async (label: string, expectedCode: string,
    inject: (client: import("pg").PoolClient, postingId: string) => Promise<void>) => {
    let sqlState: string | undefined;
    const failed = await withPostingInsertBarrier(pool, confirmManual, async (client, postingId) => {
      try { await inject(client, postingId); } catch (error) { sqlState = (error as { code?: string }).code; }
    });
    assert.equal(sqlState, expectedCode, `${label} runtime insert SQLSTATE`);
    assert.equal(failed.response.status, 500, `${label} must abort the settlement transaction`);
    assert.deepEqual(await settlementState(normalId), beforePostingState, `${label} must leave no partial settlement effects`);
    assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
    console.log("settlement assembly negative", JSON.stringify({ label, sqlState, httpStatus: failed.response.status }));
  };
  const parties = (await pool.query<{ ownerUserId: string; renterUserId: string }>(
    `SELECT owner_user_id AS "ownerUserId", renter_user_id AS "renterUserId" FROM zzsh_order.rental_order WHERE id = $1`, [normalId],
  )).rows[0]!;
  await assertAssemblyRejected("owner counterparty mismatch", "23514", async (client, postingId) => {
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "0", credit: "1", counterparty: parties.renterUserId }]);
  });
  await assertAssemblyRejected("owner account debit direction", "23514", async (client, postingId) => {
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "1", credit: "0", counterparty: parties.ownerUserId }]);
  });
  const otherPaymentId = (await pool.query<{ paidConfirmationId: string }>(
    `SELECT paid_confirmation_id AS "paidConfirmationId" FROM zzsh_order.rental_order WHERE id = $1`, [earlyId],
  )).rows[0]!.paidConfirmationId;
  await assertAssemblyRejected("source payment belongs to another order", "23514", async (client, postingId) => {
    const batch = (await client.query<{ capturedCents: string }>(`SELECT captured_cents::text AS "capturedCents" FROM zzsh_order.settlement_posting WHERE id = $1`, [postingId])).rows[0]!;
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "CAPTURED_PAYMENT_SOURCE", debit: batch.capturedCents, credit: "0", source: otherPaymentId }]);
  });
  const manualPosted = await withPostingInsertBarrier(pool, confirmManual, async (_client, postingId) => {
    const racingClient = await pool.connect();
    try {
      const raceOutcome = await racingClient.query(`INSERT INTO zzsh_order.settlement_ledger_entry
        (id,posting_id,line_no,account_code,debit_cents,credit_cents,details)
        VALUES ($1,$2,900,'PLATFORM_HAFF_SPREAD',0,1,'{}'::jsonb)`, [`sledger_${randomUUID().replaceAll("-", "")}`, postingId])
        .then(() => ({ inserted: true as const }), (error: { code?: string }) => ({ code: error.code, inserted: false as const }));
      assert.equal(raceOutcome.inserted, false);
      assert.equal(raceOutcome.code, "40001", "an append cannot see or join the uncommitted assembling batch");
    } finally {
      racingClient.release();
    }
  });
  assert.equal(manualPosted.response.status, 200, JSON.stringify(manualPosted.body));
  assert.equal(manualPosted.body!.ready, true);
  assert.equal(manualPosted.body!.orderStatus, "COMPLETED");
  assert.equal(manualPosted.body!.postingAuthorized, true);
  assert.equal(manualPosted.body!.posting.manualAdjustment.reason, "人工核对差额");
  assertNoSettlementInternals(manualPosted.body);
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "COMPLETED");
  const normalDue = await pool.query(`SELECT posted_at = refund_due_at AS immediate, captured_cents::text AS captured,
      owner_net_cents::text AS owner, renter_refund_cents::text AS refund, platform_contribution_cents::text AS platform
    FROM zzsh_order.settlement_posting WHERE order_id = $1`, [normalId]);
  assert.equal(normalDue.rows[0]!.immediate, true);
  assert.equal(BigInt(normalDue.rows[0]!.captured), BigInt(normalDue.rows[0]!.owner) + BigInt(normalDue.rows[0]!.refund) + BigInt(normalDue.rows[0]!.platform));
  const batchBalance = await pool.query(`SELECT sum(debit_cents)::text AS debit, sum(credit_cents)::text AS credit
    FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id]);
  assert.equal(batchBalance.rows[0]!.debit, batchBalance.rows[0]!.credit);
  assert.equal((await pool.query(`SELECT sum(credit_cents)::text AS cents FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'OWNER_AVAILABLE'`, [manualPosted.body!.posting.id])).rows[0]!.cents,
    manualPosted.body!.posting.owner.availableCents);
  assert.equal((await pool.query(`SELECT sum(credit_cents)::text AS cents FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'RENTER_REFUND_PAYABLE'`, [manualPosted.body!.posting.id])).rows[0]!.cents,
    manualPosted.body!.posting.refund.payableCents);
  assert.equal(manualPosted.body!.posting.amounts.depositRefund, "300.00");
  assert.equal(manualPosted.body!.posting.amounts.unusedItemRefund, "0.00");
  assert.equal(manualPosted.body!.posting.amounts.unusedHaffRefund, "0.00");
  const sealedCounts = (await pool.query(`SELECT count(*)::int AS entries FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id])).rows[0];
  const assertSealedAppend = async (label: string, rows: Array<{
    lineNo: number; accountCode: string; debit: string; credit: string; counterparty?: string | null; source?: string | null;
  }>) => {
    const client = await pool.connect();
    let sqlState: string | undefined;
    try {
      await client.query("BEGIN");
      try {
        await insertRuntimeLines(client, manualPosted.body!.posting.id, rows);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (error) { sqlState = (error as { code?: string }).code; }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.equal(sqlState, "40001", `${label} append must fail at the database seal`);
    assert.equal((await pool.query(`SELECT count(*)::int AS entries FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id])).rows[0].entries, sealedCounts.entries);
    console.log("sealed posting append rejected", JSON.stringify({ label, sqlState }));
  };
  await assertSealedAppend("same-category balancing pair", [
    { lineNo: 900, accountCode: "PLATFORM_MANUAL_NET_ADJUSTMENT", debit: "0", credit: "100" },
    { lineNo: 901, accountCode: "PLATFORM_MANUAL_NET_ADJUSTMENT", debit: "100", credit: "0" },
  ]);
  await assertSealedAppend("cross-category balancing pair", [
    { lineNo: 900, accountCode: "PLATFORM_HAFF_SPREAD", debit: "0", credit: "100" },
    { lineNo: 901, accountCode: "PLATFORM_ITEM_SPREAD", debit: "100", credit: "0" },
  ]);
  await assertSealedAppend("owner and renter payable append", [
    { lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "0", credit: "1", counterparty: parties.ownerUserId },
    { lineNo: 901, accountCode: "RENTER_REFUND_PAYABLE", debit: "0", credit: "1", counterparty: parties.renterUserId },
  ]);
  assert.deepEqual((await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey)).body, manualPosted.body);
  const otherKeyDuplicate = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, key());
  assert.equal(otherKeyDuplicate.response.status, 409);
  const bodyConflict = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "REJECT", versionHash: adjustedHash, reason: "不同请求体",
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  assert.equal(bodyConflict.response.status, 409);
  assert.equal(bodyConflict.body!.error.code, "IDEMPOTENCY_KEY_REUSED");
  await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [approvalId]);
  try {
    assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.ready, true);
    assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.postingAuthorized, true);
  } finally {
    await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = $2::timestamptz WHERE id = $1`, [approvalId, approvalDeadline]);
  }

  await pool.query(`UPDATE zzsh_iam.admin_security SET status = 'FROZEN' WHERE admin_user_id = $1`, [staff.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, staff.jar, ADMIN_ORIGIN)).response.status, 401);
  await pool.query(`UPDATE zzsh_iam.admin_security SET status = 'ACTIVE' WHERE admin_user_id = $1`, [staff.id]);
  await pool.query(`UPDATE zzsh_auth_admin."session" SET "expiresAt" = clock_timestamp() - interval '1 minute' WHERE "userId" = $1`, [outsider.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/openings`, earlyLines, outsider.jar, ADMIN_ORIGIN, key())).response.status, 401);
  await pool.query(`DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id = $1 AND permission_code = 'order.settlement.write'`, [collaborator.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key())).response.status, 403);

  const concurrentPostId = await makePaid("正常结算并发过账");
  await joinTeam(concurrentPostId);
  await addMember(concurrentPostId, collaborator.id);
  const concurrentOpeningLines = await openingBody(concurrentPostId);
  assert.equal((await post(`/api/v1/admin/orders/${concurrentPostId}/openings`, concurrentOpeningLines, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const concurrentOpening = (await post(`/api/v1/orders/${concurrentPostId}/settlement`, undefined, o.buyer)).body!.openings[0];
  await post(`/api/v1/orders/${concurrentPostId}/openings/${concurrentOpening.id}/confirm`, { versionNo: concurrentOpening.versionNo }, o.buyer, USER_ORIGIN, key());
  await post(`/api/v1/orders/${concurrentPostId}/openings/${concurrentOpening.id}/confirm`, { versionNo: concurrentOpening.versionNo }, o.owner, USER_ORIGIN, key());
  const concurrentRemain = await remainingBody(concurrentPostId, "0");
  const concurrentPreview = await post(`/api/v1/orders/${concurrentPostId}/settlement-preview`, concurrentRemain, o.buyer);
  assert.equal(concurrentPreview.body!.early, false);
  const concurrentSubmission = await post(`/api/v1/orders/${concurrentPostId}/settlements`, {
    ...concurrentRemain, acceptedHash: concurrentPreview.body!.versionHash,
  }, o.buyer, USER_ORIGIN, key());
  assert.equal(concurrentSubmission.response.status, 200, JSON.stringify(concurrentSubmission.body));
  const concurrentVersionId = concurrentSubmission.body!.settlement.id as string;
  const concurrentVersionHash = concurrentSubmission.body!.settlement.versionHash as string;
  const competingConfirmKeys = [key(), key()];
  const competingConfirms = await holdOrder(concurrentPostId, competingConfirmKeys.map((requestKey) =>
    post(`/api/v1/orders/${concurrentPostId}/settlements/${concurrentVersionId}/decision`, {
      action: "CONFIRM", versionHash: concurrentVersionHash,
    }, o.owner, USER_ORIGIN, requestKey)));
  const competingRows = competingConfirms as Array<{ response: { status: number }; body: any }>;
  assert.equal(competingRows.filter((row) => row.response.status === 200).length, 1);
  assert.equal(competingRows.filter((row) => row.response.status === 409).length, 1);
  const winnerIndex = competingRows.findIndex((row) => row.response.status === 200);
  const winningConfirm = competingRows[winnerIndex]!;
  assert.equal(winningConfirm.body!.orderStatus, "COMPLETED");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id = $1`, [concurrentPostId])).rows[0].n, 1);
  assert.deepEqual((await post(`/api/v1/orders/${concurrentPostId}/settlements/${concurrentVersionId}/decision`, {
    action: "CONFIRM", versionHash: concurrentVersionHash,
  }, o.owner, USER_ORIGIN, competingConfirmKeys[winnerIndex]!)).body, winningConfirm.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND party = 'SUPPORT'`, [concurrentVersionId])).rows[0].n, 0);

  const unpostedId = await makePaid("结算未过账占用保留");
  const occupied = await pool.query<{ accountId: string }>(`SELECT account_id AS "accountId" FROM zzsh_order.rental_order WHERE id = $1`, [unpostedId]);
  const released = await pool.query<{ accountId: string }>(`SELECT account_id AS "accountId" FROM zzsh_order.rental_order WHERE id = $1`, [normalId]);
  assert.equal(await withTransaction(pool, (client) => readOrderOccupancy(client, occupied.rows[0]!.accountId)), true);
  assert.equal(await withTransaction(pool, (client) => readOrderOccupancy(client, released.rows[0]!.accountId)), false);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id IN ($1,$2,$3)`, [normalId, earlyId, concurrentPostId])).rows[0].n, 3);
  assert.equal((await pool.query(`SELECT count(DISTINCT payment_confirmation_id)::int AS n FROM zzsh_order.settlement_posting WHERE order_id IN ($1,$2,$3)`, [normalId, earlyId, concurrentPostId])).rows[0].n, 3);
  const reconciliation = await pool.query(`WITH selected AS (
      SELECT p.id, p.captured_cents, p.owner_net_cents, p.renter_refund_cents, p.platform_contribution_cents, p.payment_confirmation_id,
        sum(e.debit_cents) AS debit, sum(e.credit_cents) AS credit,
        sum(e.credit_cents) FILTER (WHERE e.account_code = 'OWNER_AVAILABLE') AS owner_credits,
        sum(e.credit_cents) FILTER (WHERE e.account_code = 'RENTER_REFUND_PAYABLE') AS refund_credits,
        sum(e.credit_cents - e.debit_cents) FILTER (WHERE e.account_code LIKE 'PLATFORM_%') AS platform_net
      FROM zzsh_order.settlement_posting p JOIN zzsh_order.settlement_ledger_entry e ON e.posting_id = p.id
      WHERE p.order_id IN ($1,$2,$3) GROUP BY p.id
    ) SELECT count(*)::int AS batches,
      bool_and(captured_cents = owner_net_cents + renter_refund_cents + platform_contribution_cents) AS allocation_balanced,
      bool_and(debit = credit) AS ledger_balanced,
      bool_and(owner_credits = owner_net_cents AND refund_credits = renter_refund_cents AND platform_net = platform_contribution_cents) AS accounts_reconciled,
      count(DISTINCT payment_confirmation_id)::int AS unique_payments FROM selected`, [normalId, earlyId, concurrentPostId]);
  assert.deepEqual(reconciliation.rows[0], { batches: 3, allocation_balanced: true, ledger_balanced: true, accounts_reconciled: true, unique_payments: 3 });

  // TR-C1-IMP-1: switch one new release to the formal policy producer, append
  // account-level proof through the admin API, then exercise the same DB reader
  // from a second HTTP app. Legacy v1 fixtures above remain on the legacy release.
  await o.createFormalRelease();
  const roleVerifier = await o.createStaff("保证金角色核定员", []);
  const allowVerifier = await o.createStaff("保证金个人允许核定员", ["supply.guarantee.verify"]);
  const denyVerifier = await o.createStaff("保证金拒绝核定员", []);
  const revokeVerifier = await o.createStaff("保证金撤销核定员", ["supply.guarantee.verify", "supply.guarantee.revoke"]);
  for (const verifier of [roleVerifier, allowVerifier, denyVerifier, revokeVerifier]) {
    await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id,game_id,granted_by_admin_id) VALUES ($1,$2,$3)`, [verifier.id, gameId, o.boss.id]);
  }
  const guaranteeRoleId = `role_trc1_r2_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `INSERT INTO zzsh_iam.admin_role (id,code,name,description,status) VALUES ($1,$2,$3,$4,'ACTIVE')`,
    [guaranteeRoleId, guaranteeRoleId, "TR-C1-R2保证金核定角色", "formal correction acceptance role"],
  );
  await pool.query(`INSERT INTO zzsh_iam.admin_role_permission (role_id,permission_code) VALUES ($1,'supply.guarantee.verify')`, [guaranteeRoleId]);
  await pool.query(`INSERT INTO zzsh_iam.admin_user_role (admin_user_id,role_id) VALUES ($1,$2)`, [roleVerifier.id, guaranteeRoleId]);
  await pool.query(`INSERT INTO zzsh_iam.admin_user_role (admin_user_id,role_id) VALUES ($1,$2)`, [denyVerifier.id, guaranteeRoleId]);
  await pool.query(`INSERT INTO zzsh_iam.admin_user_permission (admin_user_id,permission_code,effect) VALUES ($1,'supply.guarantee.verify','DENY')`, [denyVerifier.id]);

  const appendProof = async (
    accountId: string,
    verifier: Staff,
    status: "SATISFIED" | "NOT_REQUIRED" | "REVOKED",
    coveredCents?: string,
    expectedProofVersion = "0",
    expectedStatus = 200,
  ) => {
    const policyRow = (await pool.query<{ policyVersion: string }>(
      `SELECT p.funding_policy->>'policyVersion' AS "policyVersion"
         FROM zzsh_supply.rental_account a JOIN zzsh_supply.game g ON g.id=a.game_id
         JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id
         JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE a.id=$1`, [accountId],
    )).rows[0];
    const result = await post(`/api/bff/admin/supply/accounts/${accountId}/guarantee-proof`, {
      expectedProofVersion, expectedPolicyVersion: policyRow!.policyVersion, status, ...(coveredCents === undefined ? {} : { coveredCents }),
      evidenceRef: `trc1-imp1:${accountId}`, evidenceDigest: "ab".repeat(32), reason: "isolated formal policy proof",
    }, verifier.jar, ADMIN_ORIGIN, key());
    assert.equal(result.response.status, expectedStatus, JSON.stringify(result.body));
    if (expectedStatus !== 200) return undefined;
    return result.body!.proof as { id: string; status: string; versionNo: string; priceVersionId: string; validFrom: string; validUntil: string | null };
  };
  const republishOnCurrentRelease = async (target: { accountId: string }): Promise<{ accountId: string; versionId: string; releaseId: string }> => {
    const source = (await pool.query<{
      accountRevision: string; versionId: string; title: string; description: string | null; attributes: Record<string, unknown>;
      termOptionCode: string; pricingOptionCode: string;
    }>(
      `SELECT a.revision::text AS "accountRevision",v.id AS "versionId",v.title,v.description,v.attributes,
              v.term_option_code AS "termOptionCode",v.pricing_option_code AS "pricingOptionCode"
         FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
        WHERE a.id=$1`, [target.accountId],
    )).rows[0];
    assert.ok(source, "republish source listing must exist");
    const inventory = (await pool.query(`SELECT item_id AS "itemId",quantity::text AS quantity FROM zzsh_supply.inventory_line WHERE version_id=$1 ORDER BY item_id`, [source.versionId])).rows;
    const skins = (await pool.query(`SELECT skin_id AS "skinId" FROM zzsh_supply.listing_skin WHERE version_id=$1 ORDER BY skin_id`, [source.versionId])).rows.map((row) => row.skinId);
    const entitlements = (await pool.query(
      `SELECT entitlement_id AS "entitlementId",value,CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt",expiry_knowledge AS "expiryKnowledge"
         FROM zzsh_supply.listing_entitlement WHERE version_id=$1 ORDER BY entitlement_id`, [source.versionId],
    )).rows;
    const mediaBindings = (await pool.query(
      `SELECT asset_id AS "assetId",position FROM zzsh_supply.listing_media WHERE version_id=$1 ORDER BY position`, [source.versionId],
    )).rows;
    const draft = await o.request(o.base, `/api/v1/supply/accounts/${target.accountId}/drafts`, { expectedRevision: source.accountRevision }, o.owner, USER_ORIGIN, "POST", key());
    assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
    const saved = await o.request(o.base, `/api/v1/supply/accounts/${target.accountId}/draft`, {
      expectedRevision: draft.body!.account.revision,
      title: source.title,
      description: source.description,
      attributes: source.attributes,
      termOptionCode: source.termOptionCode,
      pricingOptionCode: source.pricingOptionCode,
      inventory,
      skins,
      entitlements,
      mediaBindings,
    }, o.owner, USER_ORIGIN, "PUT", key());
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    const quoted = await o.request(o.base, `/api/v1/supply/accounts/${target.accountId}/quote`, { expectedRevision: saved.body!.account.revision }, o.owner, USER_ORIGIN, "POST", key());
    assert.equal(quoted.response.status, 200, JSON.stringify(quoted.body));
    const versionId = quoted.body!.version.id as string;
    const releaseId = quoted.body!.version.releaseId as string;
    const contentHash = quoted.body!.version.contentHash as string;
    const accepted = await o.request(o.base, `/api/v1/supply/accounts/${target.accountId}/accept-rules`, {
      expectedRevision: quoted.body!.account.revision, versionId, releaseId, contentHash,
    }, o.owner, USER_ORIGIN, "POST", key());
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    const submitted = await o.request(o.base, `/api/v1/supply/accounts/${target.accountId}/submit`, {
      expectedRevision: accepted.body!.account.revision, versionId, releaseId, contentHash,
    }, o.owner, USER_ORIGIN, "POST", key());
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
    return { accountId: target.accountId, versionId, releaseId };
  };
  const formalNormal = await o.publishApproved(o.owner, "正式reader普通声明", "30000", true, false, undefined, "standard", true);
  const formalFull = await o.publishApproved(o.owner, "正式reader包赔声明", "30000", true, true, undefined, "standard", true);
  await assertStrictFundingPolicyVectors(pool, formalNormal.accountId);
  const normalProof = await appendProof(formalNormal.accountId, roleVerifier, "NOT_REQUIRED", "0");
  const fullProof = await appendProof(formalFull.accountId, allowVerifier, "NOT_REQUIRED", "0");
  assert.ok(normalProof && fullProof);
  const staleNotRequired = await o.publishApproved(o.owner, "正式reader旧价格无要求", "30000", true, false, undefined, "standard", true);
  const staleNotRequiredProofA = await appendProof(staleNotRequired.accountId, roleVerifier, "NOT_REQUIRED", "0");
  assert.ok(staleNotRequiredProofA);
  const formalDenied = await o.publishApproved(o.owner, "正式reader拒绝核定", "30000", true, false, undefined, "standard", true);
  await appendProof(formalDenied.accountId, denyVerifier, "NOT_REQUIRED", "0", "0", 403);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_supply.account_guarantee_proof WHERE account_id=$1`, [formalDenied.accountId])).rows[0].n, 0);
  const deniedContext = (await pool.query<{ ownerUserId: string; priceVersionId: string; policyVersion: string }>(
    `SELECT a.owner_user_id AS "ownerUserId",r.price_version_id AS "priceVersionId",p.funding_policy->>'policyVersion' AS "policyVersion"
       FROM zzsh_supply.rental_account a JOIN zzsh_supply.game g ON g.id=a.game_id
       JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE a.id=$1`, [formalDenied.accountId],
  )).rows[0]!;
  await assert.rejects(
    () => pool.query(
      `INSERT INTO zzsh_supply.account_guarantee_proof
        (id,account_id,owner_user_id,version_no,price_version_id,policy_version,status,required_cents,covered_cents,evidence_ref,evidence_digest,verified_by_admin_id,valid_from,valid_until,supersedes_id,reason)
       VALUES ($1,$2,$3,1,$4,$5,'NOT_REQUIRED',0,0,$6,$7,$8,clock_timestamp(),NULL,NULL,$9)`,
      [randomUUID(), formalDenied.accountId, deniedContext.ownerUserId, deniedContext.priceVersionId, deniedContext.policyVersion, `trc1-direct-deny:${formalDenied.accountId}`, "cd".repeat(32), denyVerifier.id, "direct trigger denial"],
    ),
    (error: any) => error?.code === "42501",
  );
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_supply.account_guarantee_proof WHERE account_id=$1`, [formalDenied.accountId])).rows[0].n, 0);
  const formal = await o.createFormalApp();
  try {
    const formalPost = (path: string, body: Record<string, unknown> | undefined, jar = o.buyer, origin = USER_ORIGIN, headers?: Record<string, string>) =>
      o.request(formal.base, path, body, jar, origin, body === undefined ? "GET" : "POST", headers ?? (body === undefined ? {} : key()));
    for (const [account, proof, selected] of [[formalNormal, normalProof, false], [formalFull, fullProof, true]] as const) {
      const confirmation = await formalPost("/api/v2/order-confirmations", { accountId: account.accountId, versionId: account.versionId, releaseId: account.releaseId });
      assert.equal(confirmation.response.status, 200, JSON.stringify(confirmation.body));
      assert.equal(confirmation.body!.compensationDisclosure.selected, selected);
      const created = await formalPost("/api/v2/orders", { confirmationToken: confirmation.body!.confirmationToken }, o.buyer, USER_ORIGIN, key());
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      const stored = (await pool.query<{ status: string; personal: Record<string, any> }>(
        `SELECT status, quote_snapshot->'personal' AS personal FROM zzsh_order.rental_order WHERE id=$1`, [created.body!.order.id],
      )).rows[0]!;
      assert.equal(stored.status, "PENDING_PAYMENT");
      assert.equal(stored.personal.schema, "personal-quote-v2");
      assert.equal(stored.personal.fullPayoutDeclaration.selected, selected);
      assert.equal(stored.personal.guarantee.status, "NOT_REQUIRED");
      assert.equal(stored.personal.funding.version, "trc1-imp1-policy-v1");
      assert.match(stored.personal.funding.sourceRef, new RegExp(proof.id));
      assert.equal(Object.hasOwn(stored.personal.funding, "fullPayoutFeeCents"), false);
    }
    const staleNotRequiredConfirmationA = await formalPost("/api/v2/order-confirmations", {
      accountId: staleNotRequired.accountId, versionId: staleNotRequired.versionId, releaseId: staleNotRequired.releaseId,
    });
    assert.equal(staleNotRequiredConfirmationA.response.status, 200, JSON.stringify(staleNotRequiredConfirmationA.body));
    var staleNotRequiredTokenA = staleNotRequiredConfirmationA.body!.confirmationToken as string;
    console.log("trc1 imp1 formal reader", JSON.stringify({ policy: "trc1-imp1-policy-v1", proofs: [normalProof.id, fullProof.id], selected: [false, true], source: "same runtime PoolClient via production reader" }));
  } finally {
    await formal.app.close();
  }

  // A proof is account-scoped but also frozen to the exact sealed price version.
  // Keep this path HTTP-driven: publish a new version after the price switch,
  // then let the production reader reject the old proof without creating an order.
  await o.createFormalRelease();
  const staleNotRequiredB = await republishOnCurrentRelease(staleNotRequired);
  const staleNotRequiredPrice = (await pool.query<{ priceVersionId: string }>(
    `SELECT r.price_version_id AS "priceVersionId" FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_supply.rule_release r ON r.id=v.rule_release_id WHERE a.id=$1`, [staleNotRequired.accountId],
  )).rows[0]!.priceVersionId;
  assert.notEqual(staleNotRequiredProofA.priceVersionId, staleNotRequiredPrice, "the stale proof must be bound to price A while the listing uses price B");
  const staleFormal = await o.createFormalApp();
  try {
    const staleFormalPost = (path: string, body: Record<string, unknown> | undefined, jar = o.buyer, origin = USER_ORIGIN, headers?: Record<string, string>) =>
      o.request(staleFormal.base, path, body, jar, origin, body === undefined ? "GET" : "POST", headers ?? (body === undefined ? {} : key()));
    const staleConfirmationB = await staleFormalPost("/api/v2/order-confirmations", {
      accountId: staleNotRequiredB.accountId, versionId: staleNotRequiredB.versionId, releaseId: staleNotRequiredB.releaseId,
    });
    assert.equal(staleConfirmationB.response.status, 503, JSON.stringify(staleConfirmationB.body));
    assert.equal(staleConfirmationB.body?.error?.code, "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const staleOrdersBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleNotRequired.accountId])).rows[0].n);
    const staleOrder = await staleFormalPost("/api/v2/orders", { confirmationToken: staleNotRequiredTokenA }, o.buyer, USER_ORIGIN, key());
    assert.ok([404, 503].includes(staleOrder.response.status), JSON.stringify(staleOrder.body));
    assert.ok(staleOrder.response.status === 404
      ? staleOrder.body?.error?.code === "NOT_FOUND"
      : staleOrder.body?.error?.code === "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const staleOrdersAfter = Number((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleNotRequired.accountId])).rows[0].n);
    assert.equal(staleOrdersAfter, staleOrdersBefore, "stale confirmation token must not create an order");
    const recoveredProofB = await appendProof(staleNotRequired.accountId, roleVerifier, "NOT_REQUIRED", "0", "1");
    assert.ok(recoveredProofB);
    assert.equal(recoveredProofB.priceVersionId, staleNotRequiredPrice);
    const recoveredConfirmation = await staleFormalPost("/api/v2/order-confirmations", {
      accountId: staleNotRequiredB.accountId, versionId: staleNotRequiredB.versionId, releaseId: staleNotRequiredB.releaseId,
    });
    assert.equal(recoveredConfirmation.response.status, 200, JSON.stringify(recoveredConfirmation.body));
    console.log("trc1 imp1 price binding", JSON.stringify({ mode: "NOT_REQUIRED", priceA: staleNotRequiredProofA.priceVersionId, priceB: staleNotRequiredPrice, staleStatus: staleConfirmationB.response.status, recoveredStatus: recoveredConfirmation.response.status, zeroOrderSideEffect: staleOrdersAfter === staleOrdersBefore }));
  } finally {
    await staleFormal.app.close();
  }

  await o.createFormalRelease("SATISFIED");
  const staleSatisfied = await o.publishApproved(o.owner, "正式reader旧价格满足核定", "30000", true, false, undefined, "standard", true);
  const staleSatisfiedProofA = await appendProof(staleSatisfied.accountId, roleVerifier, "SATISFIED", "30000");
  assert.ok(staleSatisfiedProofA);
  const formalSatisfied = await o.publishApproved(o.owner, "正式reader满足核定", "30000", true, false, undefined, "standard", true);
  const satisfiedProof = await appendProof(formalSatisfied.accountId, roleVerifier, "SATISFIED", "30000");
  assert.ok(satisfiedProof);
  assert.equal(satisfiedProof.status, "SATISFIED");
  assert.equal(satisfiedProof.versionNo, "1");
  assert.ok(satisfiedProof.validUntil && Date.parse(satisfiedProof.validUntil) > Date.now(), "a satisfied proof must have a future database expiry");
  const revokedProof = await appendProof(formalSatisfied.accountId, revokeVerifier, "REVOKED", undefined, "1");
  assert.ok(revokedProof);
  assert.equal(revokedProof.status, "REVOKED");
  assert.equal(revokedProof.versionNo, "2");
  console.log("trc1 imp1 r2 proof authorization", JSON.stringify({ role: roleVerifier.id, userAllow: allowVerifier.id, deny: denyVerifier.id, revoke: revokeVerifier.id, notRequired: [normalProof.id, fullProof.id], satisfied: satisfiedProof.id, revoked: revokedProof.id }));

  const satisfiedAtAApp = await o.createFormalApp();
  let staleSatisfiedTokenA: string;
  try {
    const satisfiedAtAPost = (path: string, body: Record<string, unknown> | undefined, jar = o.buyer, origin = USER_ORIGIN, headers?: Record<string, string>) =>
      o.request(satisfiedAtAApp.base, path, body, jar, origin, body === undefined ? "GET" : "POST", headers ?? (body === undefined ? {} : key()));
    const confirmationA = await satisfiedAtAPost("/api/v2/order-confirmations", {
      accountId: staleSatisfied.accountId, versionId: staleSatisfied.versionId, releaseId: staleSatisfied.releaseId,
    });
    assert.equal(confirmationA.response.status, 200, JSON.stringify(confirmationA.body));
    staleSatisfiedTokenA = confirmationA.body!.confirmationToken as string;
  } finally {
    await satisfiedAtAApp.app.close();
  }

  await o.createFormalRelease("SATISFIED");
  const staleSatisfiedB = await republishOnCurrentRelease(staleSatisfied);
  const staleSatisfiedPrice = (await pool.query<{ priceVersionId: string }>(
    `SELECT r.price_version_id AS "priceVersionId" FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_supply.rule_release r ON r.id=v.rule_release_id WHERE a.id=$1`, [staleSatisfied.accountId],
  )).rows[0]!.priceVersionId;
  assert.notEqual(staleSatisfiedProofA.priceVersionId, staleSatisfiedPrice, "the satisfied proof must be bound to price A while the listing uses price B");
  const satisfiedFormal = await o.createFormalApp();
  try {
    const satisfiedFormalPost = (path: string, body: Record<string, unknown> | undefined, jar = o.buyer, origin = USER_ORIGIN, headers?: Record<string, string>) =>
      o.request(satisfiedFormal.base, path, body, jar, origin, body === undefined ? "GET" : "POST", headers ?? (body === undefined ? {} : key()));
    const staleSatisfiedConfirmation = await satisfiedFormalPost("/api/v2/order-confirmations", {
      accountId: staleSatisfiedB.accountId, versionId: staleSatisfiedB.versionId, releaseId: staleSatisfiedB.releaseId,
    });
    assert.equal(staleSatisfiedConfirmation.response.status, 503, JSON.stringify(staleSatisfiedConfirmation.body));
    assert.equal(staleSatisfiedConfirmation.body?.error?.code, "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const satisfiedOrdersBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleSatisfied.accountId])).rows[0].n);
    const staleSatisfiedOrder = await satisfiedFormalPost("/api/v2/orders", { confirmationToken: staleSatisfiedTokenA }, o.buyer, USER_ORIGIN, key());
    assert.ok([404, 503].includes(staleSatisfiedOrder.response.status), JSON.stringify(staleSatisfiedOrder.body));
    assert.ok(staleSatisfiedOrder.response.status === 404
      ? staleSatisfiedOrder.body?.error?.code === "NOT_FOUND"
      : staleSatisfiedOrder.body?.error?.code === "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const satisfiedOrdersAfter = Number((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleSatisfied.accountId])).rows[0].n);
    assert.equal(satisfiedOrdersAfter, satisfiedOrdersBefore, "stale satisfied confirmation token must not create an order");
    const recoveredSatisfiedProof = await appendProof(staleSatisfied.accountId, roleVerifier, "SATISFIED", "30000", "1");
    assert.ok(recoveredSatisfiedProof);
    assert.equal(recoveredSatisfiedProof.priceVersionId, staleSatisfiedPrice);
    const recoveredSatisfiedConfirmation = await satisfiedFormalPost("/api/v2/order-confirmations", {
      accountId: staleSatisfiedB.accountId, versionId: staleSatisfiedB.versionId, releaseId: staleSatisfiedB.releaseId,
    });
    assert.equal(recoveredSatisfiedConfirmation.response.status, 200, JSON.stringify(recoveredSatisfiedConfirmation.body));
    const beforeRevoke = await satisfiedFormalPost("/api/v2/order-confirmations", {
      accountId: staleSatisfiedB.accountId, versionId: staleSatisfiedB.versionId, releaseId: staleSatisfiedB.releaseId,
    });
    assert.equal(beforeRevoke.response.status, 200, JSON.stringify(beforeRevoke.body));
    const revokedAfterPriceSwitch = await appendProof(staleSatisfied.accountId, revokeVerifier, "REVOKED", undefined, "2");
    assert.ok(revokedAfterPriceSwitch);
    const revokedValidity = (await pool.query<{ valid: boolean }>(
      `SELECT (valid_from <= clock_timestamp() AND (valid_until IS NULL OR clock_timestamp() < valid_until)) AS valid FROM zzsh_supply.account_guarantee_proof WHERE id=$1`, [revokedAfterPriceSwitch.id],
    )).rows[0]!.valid;
    assert.equal(revokedValidity, false, "revocation must be immediately outside the reader validity window");
    const afterRevokeConfirmation = await satisfiedFormalPost("/api/v2/order-confirmations", {
      accountId: staleSatisfiedB.accountId, versionId: staleSatisfiedB.versionId, releaseId: staleSatisfiedB.releaseId,
    });
    assert.equal(afterRevokeConfirmation.response.status, 503, JSON.stringify(afterRevokeConfirmation.body));
    assert.equal(afterRevokeConfirmation.body?.error?.code, "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const beforeRevokeOrder = await satisfiedFormalPost("/api/v2/orders", { confirmationToken: beforeRevoke.body!.confirmationToken }, o.buyer, USER_ORIGIN, key());
    assert.equal(beforeRevokeOrder.response.status, 503, JSON.stringify(beforeRevokeOrder.body));
    assert.equal(beforeRevokeOrder.body?.error?.code, "CONFIRMATION_DEPENDENCY_UNAVAILABLE");
    const afterRevokeOrders = Number((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleSatisfied.accountId])).rows[0].n);
    assert.equal(afterRevokeOrders, satisfiedOrdersBefore, "revoked confirmation token must not create an order");
    console.log("trc1 imp1 price binding", JSON.stringify({ mode: "SATISFIED", priceA: staleSatisfiedProofA.priceVersionId, priceB: staleSatisfiedPrice, staleStatus: staleSatisfiedConfirmation.response.status, recoveredStatus: recoveredSatisfiedConfirmation.response.status, revokedConfirmationStatus: afterRevokeConfirmation.response.status, expiredValidityAfterRevoke: !revokedValidity, zeroOrderSideEffect: afterRevokeOrders === satisfiedOrdersBefore }));
  } finally {
    await satisfiedFormal.app.close();
  }

  // R1 uses the existing compatibility pricing seam only to provide all four frozen membership tiers
  // in the controlled fixture; settlement still runs through the normal confirmation/order/settlement HTTP paths.
  const compatibilityRule = compatRule("50");
  if (!compatibilityRule.compatibility) throw new Error("compatibility fixture is incomplete");
  compatibilityRule.compatibility.ordinary.spreadDelta = "10";
  compatibilityRule.compatibility.ordinary.discounts = Object.fromEntries(CUSTOMER_TIERS.map((tier) => [tier, "0"])) as typeof compatibilityRule.compatibility.ordinary.discounts;
  const billable = (await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM zzsh_supply.billable_item WHERE game_id = $1 AND code = ANY($2::text[])`, [gameId, ["haff_base", "settlement_test_piece"]],
  )).rows;
  const haffItem = billable.find((row) => row.code === "haff_base")?.id;
  const fixedItem = billable.find((row) => row.code === "settlement_test_piece")?.id;
  assert.ok(haffItem && fixedItem);
  const adminCreate = (path: string, body: Record<string, unknown>, method = "POST") => post(path, body, o.boss.jar, ADMIN_ORIGIN, key(), method);
  const priceDraft = await adminCreate("/api/bff/admin/supply/price-drafts", { gameId, mode: "SPREAD" });
  assert.equal(priceDraft.response.status, 200, JSON.stringify(priceDraft.body));
  const termDraft = await adminCreate("/api/bff/admin/supply/term-drafts", { gameId });
  assert.equal(termDraft.response.status, 200, JSON.stringify(termDraft.body));
  const agreementDraft = await adminCreate("/api/bff/admin/supply/agreement-drafts", { gameId, title: "结算兼容会员协议", body: "仅用于受控会员结算兼容验收。" });
  assert.equal(agreementDraft.response.status, 200, JSON.stringify(agreementDraft.body));
  const compatibilityLines = CUSTOMER_TIERS.flatMap((customerTier) => [
    { itemId: haffItem, customerTier, pricingKind: "HAFF_RATIO" },
    { itemId: fixedItem, customerTier, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "2", ownerUnitAmount: "1.5" },
  ]);
  const configuredPrice = await adminCreate(`/api/bff/admin/supply/price-drafts/${priceDraft.body!.id}`, {
    expectedRevision: "1", haffRule: compatibilityRule, roundingPolicy: "HALF_UP_CENT_V1", lines: compatibilityLines,
  }, "PUT");
  assert.equal(configuredPrice.response.status, 200, JSON.stringify(configuredPrice.body));
  const configuredTerm = await adminCreate(`/api/bff/admin/supply/term-drafts/${termDraft.body!.id}`, {
    expectedRevision: "1", options: [{ code: "daily-10m", name: "日消耗 10M", dailyConsumption: "10000000" }],
  }, "PUT");
  assert.equal(configuredTerm.response.status, 200, JSON.stringify(configuredTerm.body));
  assert.equal((await adminCreate(`/api/bff/admin/supply/price-drafts/${priceDraft.body!.id}/seal`, { expectedRevision: "2" })).response.status, 200);
  assert.equal((await adminCreate(`/api/bff/admin/supply/term-drafts/${termDraft.body!.id}/seal`, { expectedRevision: "2" })).response.status, 200);
  assert.equal((await adminCreate(`/api/bff/admin/supply/agreement-drafts/${agreementDraft.body!.id}/seal`, { expectedRevision: "1" })).response.status, 200);
  const currentGeneration = (await pool.query<{ generation: string }>(
    `SELECT COALESCE(MAX(generation), 0)::text AS generation FROM zzsh_supply.rule_release WHERE game_id = $1`, [gameId],
  )).rows[0]!.generation;
  const compatibilityRelease = await post("/api/bff/admin/supply/releases", {
    gameId, priceVersionId: priceDraft.body!.id, termVersionId: termDraft.body!.id, agreementVersionId: agreementDraft.body!.id,
    expectedGeneration: currentGeneration,
  }, o.boss.jar, ADMIN_ORIGIN, key());
  assert.equal(compatibilityRelease.response.status, 200, JSON.stringify(compatibilityRelease.body));
  assert.equal(compatibilityRelease.body!.generation, String(Number(currentGeneration) + 1));
  console.log("trg2 R1 DISCOUNT_USER compatibility fixture", JSON.stringify({ gameId, releaseId: compatibilityRelease.body!.releaseId, generation: compatibilityRelease.body!.generation, tiers: CUSTOMER_TIERS }));
  await settleV2("B3B1 v2冻结DISCOUNT_USER", "NORMAL", "DISCOUNT_USER");

  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.rental_order) AS orders,
    (SELECT count(*)::int FROM zzsh_order.payment_confirmation) AS payments,
    (SELECT count(*)::int FROM zzsh_order.settlement_version) AS versions,
    (SELECT count(*)::int FROM zzsh_iam.audit_event) AS audits`)).rows[0];
  const migrationCount = (await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n;
  console.log("trb3a pre-cleanup counts", JSON.stringify({ ...counts, migrations: migrationCount, migrationTail: after.at(-1), staged: o.staged }));
}
