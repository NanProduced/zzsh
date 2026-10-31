import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { handleAdminApprovalRoute, evaluateApprovalActions, assertApprovalAction, hashApprovalPayload, requestScope, virtualRequestStatus } from "../src/auth/approval-audit";
import { projectApprovalBusinesses, approvalRegistration, APPROVAL_EXECUTION_MODE } from "../src/auth/approval-business";

const unifiedPricingFixture = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", scope: "ALL_ENABLED_RENTAL_MODES", priceVersionId: "price_fixture", payableRatio: "1", costBasisRef: "price_fixture" };

type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "EXECUTED" | "EXECUTION_FAILED";

type FixtureActor = {
  id: string;
  username: string;
  status: "ACTIVE" | "FROZEN";
  isBoss: boolean;
  twoFactorEnabled: boolean;
  permissions: string[];
  rolePermissions?: string[];
  deniedPermissions?: string[];
  gameScope?: { mode: string; gameIds: string[] };
};

type FixtureRequest = {
  id: string;
  templateId: string;
  templateVersion: number;
  operationCode: string;
  triggerCondition: string;
  payloadVersion: number;
  operationPayload: Record<string, unknown>;
  operationPayloadHash: string;
  summary: string;
  requestedBy: string;
  status: Status;
  statusReason: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
};

type Fixture = {
  actors: FixtureActor[];
  requests?: FixtureRequest[];
  templates?: { id: string; operationCode: string; triggerCondition: string; version: number }[];
  templateCandidates?: { templateId: string; adminUserId: string }[];
  requestCandidates?: { requestId: string; adminUserId: string }[];
  games?: { id: string; name: string }[];
  entitlements?: Record<string, unknown>[];
  policies?: Record<string, unknown>[];
  settlementVersions?: Record<string, unknown>[];
  settlementDecisions?: Record<string, unknown>[];
  executions?: { requestId: string; status: string; resultCode: string; resultDetail: string | null }[];
  decisions?: { requestId: string; decision: string; reason?: string | null; createdAt?: string; approverId: string; finalPayload?: Record<string, unknown> | null; finalPayloadHash?: string | null }[];
};

type Outcome = { status: number; body: Record<string, any>; code: string | null; message: string; details: { path: string; code: string }[] };

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function requestFixture(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return {
    id: "approval_req_target",
    templateId: "approval_tpl_1",
    templateVersion: 1,
    operationCode: "approval.test.execute",
    triggerCondition: "manual",
    payloadVersion: 1,
    operationPayload: { outcome: "SUCCESS" },
    operationPayloadHash: "f".repeat(64),
    summary: "测试申请",
    requestedBy: "admin_requester",
    status: "PENDING",
    statusReason: null,
    expiresAt: FUTURE,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    supersedesRequestId: null,
    supersededByRequestId: null,
    ...overrides,
  };
}

function harness(fixture: Fixture, idempotencySeed: [string, { fingerprint: string; status: number; body: unknown; createdAt: string }][] = []) {
  const calls: string[] = [];
  const state = {
    requests: new Map((fixture.requests ?? []).map((row) => [row.id, { ...row }])),
    templates: (fixture.templates ?? []).map((row) => ({ ...row })),
    templateCandidates: [...(fixture.templateCandidates ?? [])],
    requestCandidates: [...(fixture.requestCandidates ?? [])],
    idempotency: new Map(idempotencySeed),
    decisions: 0,
    decisionRows: new Map((fixture.decisions ?? (fixture.requests ?? []).filter((row) => row.decidedBy && ["APPROVED", "EXECUTED", "EXECUTION_FAILED"].includes(row.status)).map((row) => ({ requestId: row.id, decision: "APPROVED", reason: null, createdAt: row.decidedAt ?? row.createdAt, approverId: row.decidedBy!, finalPayload: null, finalPayloadHash: null }))).map((row) => [row.requestId, { ...row, reason: row.reason ?? null, createdAt: row.createdAt ?? new Date().toISOString(), finalPayload: row.finalPayload ?? null, finalPayloadHash: row.finalPayloadHash ?? null }])),
    executions: 0,
    audits: 0,
    created: 0,
  };
  const actorById = new Map(fixture.actors.map((actor) => [actor.id, actor]));
  const actorByName = new Map(fixture.actors.map((actor) => [actor.username, actor]));
  const BOSS_CODES = ["approval.request.approve", "approval.request.create", "approval.request.execute", "approval.request.add_approver", "approval.request.read", "approval.audit.read", "approval.template.read", "approval.template.configure", "order.read", "order.settlement.write", "membership.entitlement.decide", "membership.entitlement.execute", "membership.entitlement.request", "membership.policy.publish", "membership.entitlement.revoke", "membership.growth.read.detail"];

  async function query(sql: string, values: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const text = sql.replace(/\s+/g, " ");
    calls.push(text);

    if (text.includes("pg_advisory_xact_lock") || text.includes("set_config") || text.startsWith("BEGIN") || text.startsWith("COMMIT")) return { rows: [], rowCount: 0 };

    if (text.includes('FROM "zzsh_supply"."idempotency_record"')) {
      const row = state.idempotency.get(`${String(values[0])}|${String(values[1])}`);
      return { rows: row ? [{ requestFingerprint: row.fingerprint, responseStatus: row.status, responseBody: row.body, createdAt: row.createdAt }] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      state.idempotency.set(`${String(values[0])}|${String(values[1])}`, { fingerprint: String(values[2]), status: Number(values[3]), body: JSON.parse(String(values[4])), createdAt: new Date().toISOString() });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM "zzsh_iam"."approval_request" r WHERE r."id" = $2')) {
      const row = state.requests.get(String(values[1]));
      const allowed = Boolean(row) && (row!.requestedBy === String(values[0]) || state.requestCandidates.some((item) => item.requestId === row!.id && item.adminUserId === String(values[0])));
      return { rows: [{ allowed }], rowCount: 1 };
    }
    if (text.includes("WITH granted_codes AS")) {
      const ids = (values[0] as string[]) ?? [];
      const outer = text.slice(text.lastIndexOf('SELECT u."id"'));
      const selected = (column: string) => outer.includes(`"${column}"`);
      const rows = fixture.actors
        .filter((actor) => ids.length === 0 || ids.includes(actor.id))
        .map((actor) => {
          const granted = [...new Set([...(actor.rolePermissions ?? []), ...(actor.permissions ?? [])])];
          const denied = [...new Set(actor.deniedPermissions ?? [])];
          return {
            id: actor.id,
            ...(selected("username") ? { username: actor.username } : {}),
            ...(selected("displayUsername") ? { displayUsername: actor.username.toUpperCase() } : {}),
            ...(selected("name") ? { name: actor.username } : {}),
            status: actor.status,
            isBoss: actor.isBoss,
            twoFactorEnabled: actor.twoFactorEnabled,
            grantedCodes: selected("grantedCodes") ? granted : [],
            deniedCodes: selected("deniedCodes") ? denied : [],
            scopeMode: selected("scopeMode") ? actor.gameScope?.mode ?? "ALL_GAMES" : null,
            gameIds: selected("gameIds") ? actor.gameScope?.gameIds ?? [] : [],
          };
        });
      return { rows, rowCount: rows.length };
    }
    if (text.includes("WITH role_permissions AS")) {
      const actor = actorById.get(String(values[0]));
      if (!actor || actor.status !== "ACTIVE") return { rows: [], rowCount: 0 };
      if (actor.isBoss) return { rows: BOSS_CODES.map((permissionCode) => ({ permissionCode })), rowCount: BOSS_CODES.length };
      const denied = new Set(actor.deniedPermissions ?? []);
      const codes = [...new Set([...(actor.rolePermissions ?? []), ...(actor.permissions ?? [])])].filter((code) => !denied.has(code));
      return { rows: codes.map((permissionCode) => ({ permissionCode })), rowCount: codes.length };
    }
    if (text.includes('FROM "zzsh_iam"."admin_user_role"')) return { rows: [], rowCount: 0 };
    if (text.includes('"game_scope_mode"')) {
      const actor = actorById.get(String(values[0]));
      return { rows: [{ mode: actor?.gameScope?.mode ?? "ALL_GAMES", gameIds: actor?.gameScope?.gameIds ?? [] }], rowCount: 1 };
    }
    if (text.includes('FROM "zzsh_iam"."admin_security"')) {
      const actor = actorById.get(String(values[0]));
      return { rows: actor ? [{ status: actor.status, isBoss: actor.isBoss, passwordChangeRequired: false }] : [], rowCount: actor ? 1 : 0 };
    }
    if (text.includes('lower(u."username") = ANY')) {
      const rows = (values[0] as string[]).map((name) => {
        const actor = actorByName.get(name);
        if (!actor) throw new Error("candidate not found");
        return { id: actor.id, username: actor.username, displayUsername: actor.username.toUpperCase(), name: actor.username, status: actor.status, isBoss: actor.isBoss, twoFactorEnabled: actor.twoFactorEnabled };
      });
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_auth_admin"."user" u')) {
      const actor = actorById.get(String(values[0])) ?? actorByName.get(String(values[0]));
      if (!actor) return { rows: [], rowCount: 0 };
      return { rows: [{ id: actor.id, username: actor.username, displayUsername: actor.username.toUpperCase(), name: actor.username, status: actor.status, isBoss: actor.isBoss, twoFactorEnabled: actor.twoFactorEnabled }], rowCount: 1 };
    }
    if (text.includes('FROM "zzsh_iam"."approval_request_candidate" c JOIN')) {
      const rows = state.requestCandidates
        .filter((item) => item.requestId === String(values[0]))
        .map((item) => {
          const actor = actorById.get(item.adminUserId)!;
          return { id: actor.id, username: actor.username, displayUsername: actor.username.toUpperCase(), name: actor.username, status: actor.status, isBoss: actor.isBoss, twoFactorEnabled: actor.twoFactorEnabled, source: "TEMPLATE", templateVersion: 1, addedBy: null };
        });
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SELECT "request_id" AS "requestId", "admin_user_id" AS "adminUserId"')) {
      const rows = state.requestCandidates.filter((item) => (values[0] as string[]).includes(item.requestId));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SELECT "request_id" AS "requestId" FROM "zzsh_iam"."approval_request_candidate"')) {
      const rows = state.requestCandidates.filter((item) => (values[0] as string[]).includes(item.requestId) && item.adminUserId === String(values[1]));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SELECT 1 FROM "zzsh_iam"."approval_request_candidate"')) {
      const hit = state.requestCandidates.some((item) => item.requestId === String(values[0]) && item.adminUserId === String(values[1]));
      return { rows: hit ? [1] : [], rowCount: hit ? 1 : 0 };
    }
    if (text.includes('SELECT "admin_user_id" AS "adminUserId" FROM "zzsh_iam"."approval_template_candidate"')) {
      const rows = state.templateCandidates.filter((item) => item.templateId === String(values[0])).map((item) => ({ adminUserId: item.adminUserId }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SELECT "template_id" AS "templateId", "admin_user_id"')) {
      return { rows: state.templateCandidates, rowCount: state.templateCandidates.length };
    }
    if (text.includes('FROM "zzsh_iam"."approval_template"')) {
      const rows = values.length >= 2
        ? state.templates.filter((row) => row.operationCode === String(values[0]) && row.triggerCondition === String(values[1]))
        : state.templates;
      return { rows, rowCount: rows.length };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_template"')) {
      state.templates.push({ id: String(values[0]), operationCode: String(values[1]), triggerCondition: String(values[2]), version: Number(values[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE "zzsh_iam"."approval_template"')) {
      const row = state.templates.find((item) => item.id === String(values[1]));
      if (row) row.version = Number(values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('DELETE FROM "zzsh_iam"."approval_template_candidate"')) {
      state.templateCandidates = state.templateCandidates.filter((item) => item.templateId !== String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_template_candidate"')) {
      state.templateCandidates.push({ templateId: String(values[0]), adminUserId: String(values[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_request"')) {
      state.created += 1;
      state.requests.set(String(values[0]), requestFixture({
        id: String(values[0]),
        templateId: String(values[1]),
        templateVersion: Number(values[2]),
        operationCode: String(values[3]),
        triggerCondition: String(values[4]),
        payloadVersion: Number(values[5]),
        operationPayload: JSON.parse(String(values[6])) as Record<string, unknown>,
        operationPayloadHash: String(values[7]),
        summary: String(values[8]),
        requestedBy: String(values[9]),
        expiresAt: String(values[10]),
        supersedesRequestId: values[11] == null ? null : String(values[11]),
      }));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_request_candidate"')) {
      state.requestCandidates.push({ requestId: String(values[0]), adminUserId: String(values[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_decision"')) {
      state.decisions += 1;
      state.decisionRows.set(String(values[1]), { requestId: String(values[1]), decision: String(values[3]), reason: values[4] as string | null, createdAt: new Date().toISOString(), approverId: String(values[2]), finalPayload: values[5] == null ? null : JSON.parse(String(values[5])), finalPayloadHash: values[6] == null ? null : String(values[6]) });
      const row = state.requests.get(String(values[1]));
      if (row) { row.status = String(values[3]) as Status; row.decidedBy = String(values[2]); }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."approval_execution"')) {
      state.executions += 1;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
      state.audits += 1;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE "zzsh_iam"."approval_request"')) {
      const row = state.requests.get(String(values[values.length - 1]));
      const literal = /SET "status" = '([A-Z_]+)'/.exec(text);
      if (row) row.status = (literal ? literal[1] : String(values[0])) as Status;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('FROM "zzsh_iam"."approval_decision"')) {
      const ids = Array.isArray(values[0]) ? values[0] as string[] : [String(values[0])];
      const rows = [...state.decisionRows.values()].filter((row) => ids.includes(row.requestId));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_iam"."approval_execution"')) {
      const ids = (values[0] as string[]) ?? [];
      const rows = (fixture.executions ?? []).filter((row) => ids.includes(row.requestId));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_iam"."audit_event"')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM "zzsh_supply"."game"')) return { rows: fixture.games ?? [], rowCount: (fixture.games ?? []).length };
    if (text.includes('FROM "zzsh_iam"."membership_entitlement"')) {
      const ids = values[0] as string[];
      const rows = (fixture.entitlements ?? []).filter((row) => ids.includes(String(row.id)) || ids.includes(String(row.approvalRequestId)));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_iam"."membership_growth_policy"')) {
      const rows = (fixture.policies ?? []).filter((row) => (values[0] as string[]).includes(String(row.id)) || (values[0] as string[]).includes(String(row.approvalRequestId)));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM zzsh_iam.membership_growth_policy WHERE id=$1")) {
      const rows = (fixture.policies ?? []).filter((row) => row.id === values[0]); return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM zzsh_supply.rule_release")) return { rows: [{ releaseId: "release_1", priceVersionId: "price_1", status: "SEALED", mode: "SPREAD", haffRule: { schema: "haff-ratio-v1" } }], rowCount: 1 };
    if (text.includes("FROM zzsh_supply.price_line")) return { rows: [], rowCount: 0 };
    if (text.includes('FROM "zzsh_order"."settlement_version"')) {
      const rows = (fixture.settlementVersions ?? []).filter((row) => (values[0] as string[]).includes(String(row.approvalRequestId)));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_order"."settlement_decision"')) {
      const rows = (fixture.settlementDecisions ?? []).filter((row) => (values[0] as string[]).includes(String(row.versionId)));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM "zzsh_iam"."approval_request"')) {
      if (text.includes('SELECT "requested_by" AS "requestedBy"')) {
        const row = state.requests.get(String(values[0]));
        return { rows: row ? [{ requestedBy: row.requestedBy, actorIsRequester: row.requestedBy === String(values[1]) }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("ORDER BY")) return { rows: [...state.requests.values()], rowCount: state.requests.size };
      const row = state.requests.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error("unhandled SQL: " + text.slice(0, 180));
  }

  const pool = {
    query: async (sql: string, values: unknown[] = []) => query(sql, values),
    connect: async () => ({ query: async (sql: string, values: unknown[] = []) => query(sql, values), release: () => undefined }),
  };
  return { pool: pool as unknown as Pool, calls, state };
}

function responseStub() {
  const captured = { statusCode: 0, body: undefined as unknown };
  return {
    captured,
    headersSent: false,
    setHeader() { return this; },
    status(code: number) { captured.statusCode = code; return this; },
    json(value: unknown) { captured.body = value; },
  };
}

/** 统一把 SecurityApiError 变成可读结果，让断言落在状态码与 reasonCode 上。 */
async function call(view: ReturnType<typeof harness>, actorId: string, method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}, executor?: (input: { operationCode: string }) => Promise<{ resultCode: string; resultDetail?: string }>): Promise<Outcome> {
  const response = responseStub();
  try {
    await handleAdminApprovalRoute(
      { method, originalUrl: "/api/v1/admin/security" + path, url: "/api/v1/admin/security" + path, body, headers } as never,
      response as never,
      "req_trace_1",
      {
        pool: view.pool,
        testOperationsEnabled: true,
        approvalOperationExecutor: executor ? async (_client: PoolClient, input: { operationCode: string }) => executor(input) : async () => ({ resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED", resultDetail: "entitlement_created_1" }),
      } as never,
      async () => ({ userId: actorId, sessionId: "session_1" }) as never,
    );
    const value = response.captured.body as Record<string, any>;
    return { status: response.captured.statusCode, body: value ?? {}, code: value?.error?.code ?? null, message: value?.error?.message ?? "", details: value?.error?.details ?? [] };
  } catch (error) {
    const value = error as { status?: number; code?: string; message?: string; details?: { path: string; code: string }[] };
    if (typeof value.status !== "number") throw error;
    return { status: value.status, body: { error: { code: value.code, message: value.message } }, code: value.code ?? null, message: value.message ?? "", details: value.details ?? [] };
  }
}

const BOSS: FixtureActor = { id: "admin_boss", username: "zz00001", status: "ACTIVE", isBoss: true, twoFactorEnabled: true, permissions: [] };
const REQUESTER: FixtureActor = { id: "admin_requester", username: "zz00002", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.create", "approval.request.read", "approval.request.execute", "approval.request.add_approver"] };
const CANDIDATE: FixtureActor = { id: "admin_candidate", username: "zz00003", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read", "membership.entitlement.decide"] };

function baseFixture(extra: Partial<Fixture> = {}): Fixture {
  return {
    actors: [BOSS, REQUESTER, CANDIDATE],
    requests: [requestFixture()],
    templates: [{ id: "approval_tpl_1", operationCode: "approval.test.execute", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_1", adminUserId: CANDIDATE.id }],
    requestCandidates: [{ requestId: "approval_req_target", adminUserId: CANDIDATE.id }],
    ...extra,
  };
}

function entitlementAmendmentFixture() {
  const pricing = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: "ordinary", priceVersionId: "price_1", payableRatio: "0.95", costBasisRef: "cost_ref_1" };
  const payload = { userId: "member_1", gameId: "game_1", kind: "FRIEND", scopeKey: "game:delta", policyId: "policy_1", startsAtUtc: new Date(Date.now() + 60_000).toISOString(), endsAtUtc: new Date(Date.now() + 86_400_000).toISOString(), pricing, depositWaived: false, reason: "客户专属礼遇" };
  const row = requestFixture({ operationCode: "membership.entitlement.grant", operationPayload: payload, operationPayloadHash: hashApprovalPayload(payload).hash });
  const range = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT_RANGE", mode: "ordinary", priceVersionId: "price_1", minPayableRatio: "0.7", maxPayableRatio: "1", costBasisRef: "cost_ref_1" };
  const policyPayload = { schema: "membership-growth-v1", version: "policy-v1", status: "APPROVED", effectiveAt: "2026-01-01T00:00:00Z", sourceRef: "cost_ref_1", entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" }, entitlementRanges: { FRIEND: { byMode: { ordinary: range } }, PRESTIGE: { byMode: { ordinary: range } } }, tiers: Object.fromEntries(["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"].map((tier) => [tier, { tier, tenantDeposit: "ACCOUNT_BASE", pricing: { ordinary: pricing }, entitlementCap: { status: "NOT_PRICED", reason: "Independent ranges" } }])) };
  const fixture = baseFixture({ requests: [row], games: [{ id: "game_1", name: "测试游戏" }], policies: [{ id: "policy_1", version: 1, policyPayload, sourceRef: "cost_ref_1", ruleReleaseId: "release_1", priceVersionId: "price_1" }] });
  const finalPayload = { ...payload, pricing: { ...pricing, payableRatio: "0.8" }, depositWaived: true, reason: "运营修改折扣后批准" };
  return { fixture, row, finalPayload, body: { requestId: row.id, decision: "APPROVE", expectedPayloadHash: row.operationPayloadHash, finalPayload } };
}

test("amended entitlement approval persists a separate hash and execution consumes that exact decision once", async () => {
  const { fixture, row, finalPayload, body } = entitlementAmendmentFixture();
  const view = harness(fixture), original = JSON.stringify(row.operationPayload), finalHash = hashApprovalPayload(finalPayload).hash;
  const first = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_amended_1" });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.finalPayloadHash, finalHash);
  assert.equal(first.body.requestPayloadHash, row.operationPayloadHash);
  assert.equal(JSON.stringify(view.state.requests.get(row.id)?.operationPayload), original);
  assert.equal(view.state.decisionRows.get(row.id)?.finalPayloadHash, finalHash);
  const replay = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_amended_1" });
  assert.equal(replay.body.idempotencyReplay, true);
  assert.equal(view.state.decisions, 1);
  const conflict = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { ...body, finalPayload: { ...finalPayload, reason: "同键不得替换已批准内容" } }, { "idempotency-key": "idem_amended_1" });
  assert.equal(conflict.status, 409);
  const recover = await call(view, CANDIDATE.id, "GET", `/approvals/recovery?operation=approval.request.decide&key=idem_amended_1&requestId=${row.id}`);
  assert.equal(recover.status, 200, JSON.stringify(recover));
  assert.equal(recover.body.receipt.finalPayloadHash, finalHash);
  let effective: any;
  const execute = await call(view, BOSS.id, "POST", "/approvals/requests/execute", { requestId: row.id }, { "idempotency-key": "idem_execute_final" }, async (input) => { effective = input; return { resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED" }; });
  assert.equal(execute.status, 200, JSON.stringify(execute));
  assert.deepEqual(effective.operationPayload, hashApprovalPayload(finalPayload).value);
  assert.equal(effective.operationPayloadHash, finalHash);
  const executeReplay = await call(view, BOSS.id, "POST", "/approvals/requests/execute", { requestId: row.id }, { "idempotency-key": "idem_execute_final" });
  assert.equal(executeReplay.body.idempotencyReplay, true);
  assert.equal(view.state.executions, 1);
  const detail = await call(view, CANDIDATE.id, "GET", `/approvals/requests/detail?requestId=${row.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal(detail.body.operation.payloadHash, row.operationPayloadHash);
  assert.equal(detail.body.business.summary.payloadSource, "APPROVED_FINAL");
  assert.equal(detail.body.business.summary.pricingSummary.payableRatio, "0.8");
  assert.equal(detail.body.business.summary.originalRequest.pricingSummary.payableRatio, "0.95");
  assert.equal(detail.body.entitlementAmendment, null);
});

test("only a currently eligible approver receives the limited entitlement amendment projection", async () => {
  const { fixture, row } = entitlementAmendmentFixture();
  const view = harness(fixture);
  const detail = await call(view, CANDIDATE.id, "GET", `/approvals/requests/detail?requestId=${row.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal(detail.body.entitlementAmendment.expectedPayloadHash, row.operationPayloadHash);
  assert.equal(detail.body.entitlementAmendment.editablePayload.pricing.costBasisRef, "cost_ref_1");
  assert.equal(detail.body.entitlementAmendment.editablePayload.userId, "member_1");
  assert.doesNotMatch(JSON.stringify(detail.body.entitlementAmendment), /ownerUnitAmount|baseBySafeBox|policyPayload/);
  const own = await call(view, REQUESTER.id, "GET", `/approvals/requests/detail?requestId=${row.id}`);
  assert.equal(own.body.entitlementAmendment, null);
  const wrongScope = harness({ ...fixture, actors: [BOSS, REQUESTER, { ...CANDIDATE, gameScope: { mode: "SELECTED_GAMES", gameIds: ["other_game"] } }] });
  const scoped = await call(wrongScope, CANDIDATE.id, "GET", `/approvals/requests/detail?requestId=${row.id}`);
  assert.equal(scoped.body.entitlementAmendment, null);
  assert.equal(scoped.body.business.summaryAvailable, false);
});

test("amended approval rejects stale hashes, frozen target changes, unsupported operations and oversized bodies before decision write", async () => {
  for (const variant of ["hash", "userId", "gameId", "kind", "policyId", "scopeKey", "target", "price", "cost", "mode", "ratio", "reject", "missingHash", "unsupported", "oversized"] as const) {
    const { fixture, row, body } = entitlementAmendmentFixture();
    const input: any = structuredClone(body);
    let expected = 409;
    if (variant === "hash") input.expectedPayloadHash = "a".repeat(64);
    else if (["userId", "gameId", "kind", "policyId", "scopeKey"].includes(variant)) input.finalPayload[variant] = "changed_target";
    else if (variant === "target") input.finalPayload.replaceEntitlementId = "ent-other";
    else if (variant === "price") input.finalPayload.pricing.priceVersionId = "price_other";
    else if (variant === "cost") input.finalPayload.pricing.costBasisRef = "cost_other";
    else if (variant === "mode") input.finalPayload.pricing.mode = "custom";
    else if (variant === "ratio") input.finalPayload.pricing.payableRatio = "0.6";
    else if (variant === "reject") { input.decision = "REJECT"; input.reason = "拒绝本次申请"; expected = 400; }
    else if (variant === "missingHash") { delete input.expectedPayloadHash; expected = 400; }
    else if (variant === "unsupported") { fixture.requests![0] = { ...row, operationCode: "approval.test.execute" }; expected = 400; }
    else if (variant === "oversized") { for (let i = 0; i < 8; i++) input.finalPayload[`large_${i}`] = "x".repeat(1500); expected = 400; }
    const view = harness(fixture);
    const result = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", input, { "idempotency-key": `idem_amend_${variant}` });
    assert.equal(result.status, expected, `${variant}: ${JSON.stringify(result)}`);
    assert.equal(view.state.decisions, 0, variant);
  }
});

test("execute fails closed on a corrupt or missing decision while legacy null overrides keep the original snapshot", async () => {
  for (const variant of ["hash", "partial", "actor", "missing", "legacy"] as const) {
    const { fixture, row, finalPayload } = entitlementAmendmentFixture();
    fixture.requests = [{ ...row, status: "APPROVED", decidedBy: CANDIDATE.id }];
    const finalHash = hashApprovalPayload(finalPayload).hash;
    fixture.decisions = variant === "missing" ? [] : [{ requestId: row.id, decision: "APPROVED", approverId: variant === "actor" ? BOSS.id : CANDIDATE.id, finalPayload: variant === "partial" || variant === "legacy" ? null : finalPayload, finalPayloadHash: variant === "legacy" ? null : variant === "hash" ? "a".repeat(64) : finalHash }];
    const view = harness(fixture); let called = 0;
    const result = await call(view, BOSS.id, "POST", "/approvals/requests/execute", { requestId: row.id }, { "idempotency-key": `idem_corrupt_${variant}` }, async (input: any) => { called += 1; assert.equal(input.operationPayloadHash, row.operationPayloadHash); assert.deepEqual(input.operationPayload, row.operationPayload); return { resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED" }; });
    assert.equal(result.status, variant === "legacy" ? 200 : 409, JSON.stringify(result));
    assert.equal(called, variant === "legacy" ? 1 : 0);
  }
});

test("approval writes reject a missing or malformed Idempotency-Key before touching state", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ status: "APPROVED", decidedBy: BOSS.id })] }));
  const missing = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" });
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "MISSING_IDEMPOTENCY_KEY");
  assert.equal(view.state.executions, 0);

  const malformed = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "has spaces" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.code, "INVALID_ARGUMENT");
  assert.equal(view.state.executions, 0);
});

test("same key and same body replays the original receipt without a second write", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ status: "APPROVED", decidedBy: CANDIDATE.id })] }));
  const body = { requestId: "approval_req_target" };
  const key = { "idempotency-key": "idem_first" };
  const first = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", body, key);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.idempotencyReplay, false);
  assert.equal(first.body.approvalRequestId, "approval_req_target");
  const audits = view.state.audits;
  const executions = view.state.executions;
  assert.equal(executions, 1);

  const replay = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", body, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotencyReplay, true);
  assert.equal(replay.body.approvalRequestId, first.body.approvalRequestId, "replay must return the original business id");
  assert.equal(replay.body.resultCode, first.body.resultCode);
  assert.equal(view.state.executions, executions, "replay must not add an execution row");
  assert.equal(view.state.audits, audits, "replay must not append audit");
});

test("same key with a different body is an explicit reuse conflict", async () => {
  const view = harness(baseFixture({
    requests: [requestFixture(), requestFixture({ id: "approval_req_other" })],
    requestCandidates: [{ requestId: "approval_req_target", adminUserId: CANDIDATE.id }, { requestId: "approval_req_other", adminUserId: CANDIDATE.id }],
  }));
  const first = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_decide" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const reused = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "REJECT", reason: "同 key 换内容" }, { "idempotency-key": "idem_decide" });
  assert.equal(reused.status, 409);
  assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(view.state.decisions, 1);
});

test("idempotency scope separates principal, operation and target", async () => {
  const view = harness(baseFixture());
  await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "shared_key" });
  const keys = [...view.state.idempotency.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0]!.includes('["admin","admin_candidate","approval.request.decide","approval_req_target"]'), keys[0]);

  const otherPrincipal = await call(view, BOSS.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "REJECT", reason: "他人不同主体" }, { "idempotency-key": "shared_key" });
  assert.equal(otherPrincipal.status, 403);
  assert.equal(view.state.idempotency.size, 1, "a different principal must not reuse or overwrite the first receipt");

  const otherOperation = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "shared_key" });
  assert.equal(otherOperation.status, 200, JSON.stringify(otherOperation.body));
  assert.notEqual(otherOperation.body.idempotencyReplay, true, "a different operation kind on the same key is not a replay of the decision");

  const otherTarget = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_other", decision: "APPROVE" }, { "idempotency-key": "shared_key" });
  assert.equal(otherTarget.status, 404, "an unknown target on a reused key is not the first receipt");
});

test("template update replays keep a single version bump and a single audit", async () => {
  const view = harness(baseFixture());
  const body = { operationCode: "approval.test.execute", triggerCondition: "manual", candidateUsernames: [CANDIDATE.username] };
  const first = await call(view, BOSS.id, "POST", "/approvals/templates/update", body, { "idempotency-key": "idem_tpl" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const version = first.body.version;
  const audits = view.state.audits;

  const replay = await call(view, BOSS.id, "POST", "/approvals/templates/update", body, { "idempotency-key": "idem_tpl" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.version, version, "replay must not increment the template version");
  assert.equal(view.state.audits, audits, "replay must not append a template audit");

  const differentIntent = await call(view, BOSS.id, "POST", "/approvals/templates/update", { ...body, candidateUsernames: [BOSS.username, CANDIDATE.username] }, { "idempotency-key": "idem_tpl" });
  assert.equal(differentIntent.status, 409);
  assert.equal(differentIntent.code, "IDEMPOTENCY_KEY_REUSED");
});

test("request creation replays return the original request id without a second request", async () => {
  const view = harness(baseFixture());
  const body = { operationCode: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "幂等创建申请" };
  const first = await call(view, REQUESTER.id, "POST", "/approvals/requests", body, { "idempotency-key": "idem_create" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.approvalRequestId);
  assert.equal(first.body.requestId, first.body.approvalRequestId);
  assert.equal(view.state.created, 1);
  assert.equal(view.state.templates[0]!.version, 1, "creation must not bump the template version");
  const audits = view.state.audits;

  const replay = await call(view, REQUESTER.id, "POST", "/approvals/requests", body, { "idempotency-key": "idem_create" });
  assert.equal(replay.body.approvalRequestId, first.body.approvalRequestId);
  assert.equal(replay.body.idempotencyReplay, true);
  assert.equal(view.state.created, 1, "a lost-ack retry must not create a second request");
  assert.equal(view.state.audits, audits, "a replay must not append a creation audit");

  const newIntent = await call(view, REQUESTER.id, "POST", "/approvals/requests", body, { "idempotency-key": "idem_create_2" });
  assert.notEqual(newIntent.body.approvalRequestId, first.body.approvalRequestId, "a different key is a different intent");
});

test("replay re-checks current permission and never reports the original operation as failed", async () => {
  const decider: FixtureActor = { id: "admin_decider", username: "zz00007", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read", "membership.entitlement.decide"] };
  const fixture = baseFixture({ actors: [BOSS, REQUESTER, CANDIDATE, decider], requestCandidates: [{ requestId: "approval_req_target", adminUserId: decider.id }] });
  const view = harness(fixture);
  const body = { requestId: "approval_req_target", decision: "APPROVE" };
  const first = await call(view, decider.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_perm" });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const revoked = harness({ ...fixture, actors: [{ ...decider, permissions: [] }, BOSS, REQUESTER, CANDIDATE] });
  const denied = await call(revoked, decider.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_perm" });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "FORBIDDEN");
  assert.equal(revoked.state.decisions, 0, "denied recovery must not write a second decision");
});

test("a completed command still replays its original receipt instead of a blanket conflict", async () => {
  const view = harness(baseFixture());
  const body = { requestId: "approval_req_target", decision: "APPROVE" };
  const first = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_done" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(view.state.requests.get("approval_req_target")?.status, "APPROVED");
  const replay = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_done" });
  assert.equal(replay.status, 200, "the original decision must not become 409 just because the request is closed now");
  assert.equal(replay.body.status, "APPROVED");
  assert.equal(view.state.decisions, 1);
});

test("recovery read returns the safe receipt or an explicit UNRESOLVED", async () => {
  const view = harness(baseFixture());
  const created = await call(view, REQUESTER.id, "POST", "/approvals/requests", { operationCode: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "恢复读取样本" }, { "idempotency-key": "idem_recover" });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const known = await call(view, REQUESTER.id, "GET", "/approvals/recovery?operation=approval.request.create&key=idem_recover");
  assert.equal(known.status, 200, JSON.stringify(known.body));
  assert.equal(known.body.knowledge, "KNOWN");
  assert.equal(known.body.receipt.approvalRequestId, created.body.approvalRequestId);
  assert.equal(known.body.receipt.status, "PENDING");
  assert.equal(JSON.stringify(known.body).includes("operationPayload"), false, "recovery must not return the payload");

  const other = await call(view, CANDIDATE.id, "GET", "/approvals/recovery?operation=approval.request.create&key=idem_recover");
  assert.equal(other.body.knowledge, "UNRESOLVED");
  assert.equal(other.body.resolution, "UNKNOWN_NOT_ABSENT");

  assert.equal((await call(view, REQUESTER.id, "GET", "/approvals/recovery?operation=zzsh_supply.game&key=idem_recover")).status, 400);
  assert.equal((await call(view, REQUESTER.id, "GET", "/approvals/recovery?operation=approval.request.execute&key=idem_recover")).status, 400, "target-scoped recovery must name its target");
  assert.equal((await call(view, REQUESTER.id, "GET", "/approvals/recovery?operation=approval.request.create&key=bad key")).status, 400);
});

test("decide rejects self request, missing second factor and non-candidate with the same reasons as the write", async () => {
  const decider: FixtureActor = { id: "admin_decider", username: "zz00005", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read", "membership.entitlement.decide"] };
  const selfView = harness(baseFixture({
    actors: [BOSS, REQUESTER, decider],
    requests: [requestFixture({ requestedBy: decider.id })],
    requestCandidates: [{ requestId: "approval_req_target", adminUserId: decider.id }],
  }));
  const self = await call(selfView, decider.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_self" });
  assert.equal(self.status, 403);
  assert.match(self.message, /SELF_REQUEST_NOT_ALLOWED/);
  assert.equal(selfView.state.decisions, 0);

  const noFactor: FixtureActor = { ...decider, id: "admin_no2fa", username: "zz00008", twoFactorEnabled: false };
  const factorView = harness(baseFixture({ actors: [BOSS, REQUESTER, noFactor], requestCandidates: [{ requestId: "approval_req_target", adminUserId: noFactor.id }] }));
  const blocked = await call(factorView, noFactor.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_2fa" });
  assert.equal(blocked.status, 403);
  assert.match(blocked.message, /TWO_FACTOR_REQUIRED/);
  assert.equal(factorView.state.decisions, 0, "a candidate without 2FA cannot decide even with the generic permission");

  const outsider = harness(baseFixture({ requestCandidates: [] }));
  const rejected = await call(outsider, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_out" });
  assert.equal(rejected.status, 403);
  assert.match(rejected.message, /NOT_CANDIDATE/);
});

test("an expired approved request keeps the expiry write and audit but yields a definite rejection", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ status: "APPROVED", decidedBy: CANDIDATE.id, expiresAt: PAST })] }));
  const result = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "idem_expired" });
  assert.equal(result.status, 409);
  assert.equal(result.code, "CONFLICT");
  assert.equal(view.state.requests.get("approval_req_target")?.status, "EXPIRED", "the expiry state must still commit");
  assert.equal(view.state.audits, 1, "the expiry audit must still commit");
  assert.equal(view.state.executions, 0);

  const replay = await call(view, REQUESTER.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "idem_expired" });
  assert.equal(replay.status, 409, "the committed rejection is the original receipt");
  assert.equal(replay.body.error.reasons.includes("EXPIRED"), true);
  assert.equal(view.state.audits, 1, "replaying a rejected command must not append another audit");
});

test("settlement adjust never enters the membership executor", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ operationCode: "order.settlement.adjust", status: "APPROVED", decidedBy: CANDIDATE.id })] }));
  const result = await call(view, BOSS.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "idem_settle" }, async (input) => { throw new Error("executor must not run for " + input.operationCode); });
  assert.equal(result.status, 409);
  assert.match(result.message, /EXECUTION_MODE_SOURCE_BUSINESS/);
  assert.equal(view.state.executions, 0, "a source-business operation must not create a generic execution row");
});

test("an unregistered operation is explained, not executed", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ operationCode: "custom.manual.thing", status: "APPROVED", decidedBy: CANDIDATE.id })] }));
  const result = await call(view, BOSS.id, "POST", "/approvals/requests/execute", { requestId: "approval_req_target" }, { "idempotency-key": "idem_unknown" }, async () => ({ resultCode: "SHOULD_NOT_RUN" }));
  assert.equal(result.status, 409);
  assert.match(result.message, /OPERATION_UNREGISTERED/);
  assert.equal(view.state.executions, 0);
  const detail = await call(view, BOSS.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(detail.body.business.summaryAvailable, false);
  assert.deepEqual(detail.body.business.restrictedReasonCodes, ["OPERATION_UNREGISTERED"]);
});

test("eligibility covers business permission, game scope and executor assembly", () => {
  const access = { status: "ACTIVE" as const, isBoss: false, passwordChangeRequired: false, permissions: new Set(["approval.request.approve", "approval.request.execute", "approval.request.add_approver", "approval.request.create"]) };
  const grantedAccess = { ...access, permissions: new Set([...access.permissions, "membership.entitlement.decide", "membership.entitlement.execute", "membership.entitlement.revoke"]) };
  const row = requestFixture({ operationCode: "membership.entitlement.grant", operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND" }, status: "APPROVED" });
  const base = { row, userId: CANDIDATE.id, access, twoFactorEnabled: true, gameScope: { mode: "ALL_GAMES" as const, gameIds: [] }, isCandidate: true, testOperationsEnabled: true, executorAssembled: true };
  const reasons = (input: typeof base) => evaluateApprovalActions(input).map((item) => [item.action, item.reasonCode]);

  assert.deepEqual(reasons(base), [["approve", "BUSINESS_PERMISSION_REQUIRED"], ["reject", "BUSINESS_PERMISSION_REQUIRED"], ["execute", "BUSINESS_PERMISSION_REQUIRED"], ["addCandidate", "OUT_OF_REQUEST_SCOPE"], ["replace", "BUSINESS_PERMISSION_REQUIRED"], ["withdraw", "REQUESTER_ONLY"]]);

  const granted = evaluateApprovalActions({ ...base, access: grantedAccess, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_b"] } });
  assert.equal(granted.find((item) => item.action === "approve")?.reasonCode, "GAME_SCOPE_DENIED");
  assert.equal(granted.find((item) => item.action === "execute")?.reasonCode, "GAME_SCOPE_DENIED");

  const publishRow = requestFixture({ operationCode: "membership.benefit.policy.publish", operationPayload: { policyDraftId: "policy_1" } });
  const publishAccess = { ...access, permissions: new Set([...access.permissions, "membership.policy.publish"]) };
  assert.equal(evaluateApprovalActions({ ...base, row: publishRow, access }).find((item) => item.action === "approve")?.reasonCode, "BUSINESS_PERMISSION_REQUIRED");
  assert.equal(evaluateApprovalActions({ ...base, row: publishRow, access: publishAccess, gameScope: { mode: "SELECTED_GAMES", gameIds: [] } }).find((item) => item.action === "approve")?.nextStepCode, "BOSS_REVIEW_REQUIRED", "operators may draft and request, but policy approval belongs to Boss");
  assert.equal(evaluateApprovalActions({ ...base, row: publishRow, access: { ...publishAccess, isBoss: true }, gameScope: { mode: "SELECTED_GAMES", gameIds: [] } }).find((item) => item.action === "approve")?.allowed, true, "Boss approval keeps the existing non-game-scoped policy contract");

  const noExecutor = evaluateApprovalActions({ ...base, access: grantedAccess, executorAssembled: false });
  assert.equal(noExecutor.find((item) => item.action === "execute")?.reasonCode, "EXECUTOR_NOT_ASSEMBLED");

  const settled = evaluateApprovalActions({ ...base, row: requestFixture({ operationCode: "order.settlement.adjust", operationPayload: { orderId: "order_1" }, status: "APPROVED" }) });
  assert.equal(settled.find((item) => item.action === "execute")?.reasonCode, "EXECUTION_MODE_SOURCE_BUSINESS");
  assert.equal(settled.find((item) => item.action === "execute")?.executionMode, APPROVAL_EXECUTION_MODE.sourceBusiness);
  assert.equal(settled.find((item) => item.action === "execute")?.nextStepCode, "SOURCE_BUSINESS_COMPLETION_REQUIRED");
  assert.equal(settled.find((item) => item.action === "addCandidate")?.reasonCode, "OUT_OF_REQUEST_SCOPE");
  assert.equal(settled.find((item) => item.action === "replace")?.reasonCode, "REQUESTER_ONLY");
  assert.throws(() => assertApprovalAction(settled, "execute"), (error: any) => error.status === 409);

  const pendingGrant = evaluateApprovalActions({ ...base, access: grantedAccess, row: { ...row, status: "PENDING" } });
  assert.equal(pendingGrant.find((item) => item.action === "execute")?.reasonCode, "STATUS_NOT_APPROVED");
  assert.equal(pendingGrant.find((item) => item.action === "approve")?.allowed, true);
  assert.equal(evaluateApprovalActions({ ...base, access: { ...grantedAccess, status: "FROZEN" } }).find((item) => item.action === "approve")?.reasonCode, "ACTOR_INACTIVE");
  assert.equal(evaluateApprovalActions({ ...base, access: grantedAccess, row: { ...row, expiresAt: PAST } }).find((item) => item.action === "approve")?.reasonCode, "EXPIRED");
  assert.equal(evaluateApprovalActions({ ...base, access: grantedAccess, row: { ...row, operationPayload: { gameId: "game_a", entitlementId: "ent_1" }, operationCode: "membership.entitlement.revoke" }, targetEntitlementStatus: "REVOKED" }).find((item) => item.action === "execute")?.reasonCode, "TARGET_NOT_ACTIVE");
  assert.equal(evaluateApprovalActions({ ...base, access: grantedAccess, executorAssembled: false }).find((item) => item.action === "execute")?.reasonCode, "EXECUTOR_NOT_ASSEMBLED");
  assert.equal(evaluateApprovalActions({ ...base, includeStatePreconditions: false, access: grantedAccess }).find((item) => item.action === "execute")?.reasonCode, "OK", "replay authorization must not re-apply state preconditions");
});

test("business projection trims by permission and keeps money and result refs exact", async () => {
  const settlementPayload = {
    schema: "settlement-version-v2",
    orderId: "order_1",
    baseVersionId: "setver_1",
    baseVersionNo: 3,
    reason: "提前结束，号主净入账调整",
    capturedAmount: "300.00",
    proposedOwnerNet: "120.50",
    proposedRenterRefund: "179.50",
    amounts: { ownerNet: "150.00", renterRefund: "150.00", feeAmount: "20.00", platformContribution: "10.00" },
  };
  const rows = [
    { id: "approval_req_settle", operationCode: "order.settlement.adjust", payloadVersion: 1, operationPayload: settlementPayload, operationPayloadHash: "a".repeat(64), summary: "调整结算", requestedBy: REQUESTER.id, status: "APPROVED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "approval_req_grant", operationCode: "membership.entitlement.grant", payloadVersion: 1, operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "scope_a", startsAtUtc: FUTURE, endsAtUtc: FUTURE, policyId: "policy_approved", pricing: { mode: "RATIO", priceVersionId: "price_1", costBasisRef: "cost_1", haff: { baseBySafeBox: { box_1: "0.30" } } }, reason: "发放礼遇" }, operationPayloadHash: "b".repeat(64), summary: "发放礼遇", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "approval_req_mystery", operationCode: "unknown.business.operation", payloadVersion: 1, operationPayload: { secretToken: "never" }, operationPayloadHash: "c".repeat(64), summary: "未知操作", requestedBy: REQUESTER.id, status: "PENDING", decidedBy: null, expiresAt: FUTURE },
  ];
  const fixture: Fixture = {
    actors: [BOSS, REQUESTER, CANDIDATE],
    games: [{ id: "game_a", name: "三角洲行动" }],
    entitlements: [{ id: "entitlement_created_1", approvalRequestId: "approval_req_grant", status: "EXECUTED_PENDING_START", startsAt: FUTURE, endsAt: FUTURE, userId: "user_a", gameId: "game_a", kind: "FRIEND", scopeKey: "scope_a", approvedPolicyId: "policy_approved", replacedById: null, revokedReason: null }],
    policies: [{ id: "policy_approved", version: 4, status: "APPROVED", effectiveAt: null, priceVersionId: "price_1", ruleReleaseId: "release_1", approvalRequestId: null }],
    settlementVersions: [{ id: "setver_2", orderId: "order_1", gameId: "game_a", versionNo: 4, versionHash: "a".repeat(64), kind: "MANUAL_ADJUSTMENT", early: true, endReason: "TENANT_VOLUNTARY_EARLY", initiatorParty: "SUPPORT", approvalRequestId: "approval_req_settle", supersededAt: null, postingId: null, postedAt: null, refundDueAt: null }],
    settlementDecisions: [{ versionId: "setver_2", party: "RENTER", action: "CONFIRM" }],
  };
  const view = harness(fixture);
  const bossAccess = { status: "ACTIVE" as const, isBoss: true, passwordChangeRequired: false, permissions: new Set<string>() };
  const projection = await projectApprovalBusinesses(view.pool, rows as never, { userId: REQUESTER.id, access: bossAccess, gameScope: { mode: "ALL_GAMES", gameIds: [] } });

  const settle = projection.views.get("approval_req_settle")!;
  assert.equal(settle.executionMode, APPROVAL_EXECUTION_MODE.sourceBusiness);
  assert.equal(settle.businessTitle, "人工调整订单结算");
  const settleSummary = settle.summary as Record<string, unknown>;
  assert.deepEqual(settleSummary.proposedOwnerNet, { amount: "120.50", currency: "CNY", unit: "yuan", scale: 2, basis: "PROPOSED_OWNER_NET" });
  assert.deepEqual(settleSummary.systemOwnerNet, { amount: "150.00", currency: "CNY", unit: "yuan", scale: 2, basis: "SYSTEM_OWNER_NET" });
  assert.equal(settleSummary.baseSettlementVersionNo, "3", "the frozen base version number must survive projection");
  assert.equal(settleSummary.baseSettlementVersionId, "setver_1");
  assert.equal(JSON.stringify(settleSummary).includes("feeAmount"), false, "approval summary must not expose fee or profit lines");
  assert.deepEqual(settle.pendingConditionCodes, ["OWNER_CONFIRMATION_REQUIRED", "SUPPORT_REVIEW_REQUIRED", "SETTLEMENT_NOT_POSTED"]);
  assert.equal((settle.settlementResult as Record<string, unknown>).posted, false);
  assert.equal(JSON.stringify(settle.objectRefs).includes("settlement_posting"), false, "a missing posting must not be invented");

  const grant = projection.views.get("approval_req_grant")!;
  assert.equal((grant.summary as Record<string, unknown>).gameName, "三角洲行动");
  assert.equal((grant.entitlement as Record<string, unknown>).status, "EXECUTED_PENDING_START", "entitlement state is read separately from the approval status");
  assert.equal(grant.resultAvailability, "KNOWN");
  assert.equal(JSON.stringify(grant).includes("haff"), false, "pricing detail stays out without the detail read permission");
  assert.equal(grant.pricingRestrictedReasonCode, "MEMBERSHIP_DETAIL_READ_REQUIRED");

  const mystery = projection.views.get("approval_req_mystery")!;
  assert.equal(mystery.summaryAvailable, false);
  assert.deepEqual(mystery.restrictedReasonCodes, ["OPERATION_UNREGISTERED"]);
  assert.equal(mystery.executionMode, APPROVAL_EXECUTION_MODE.unsupported);
  assert.equal(JSON.stringify(mystery).includes("secretToken"), false);

  const outsider = await projectApprovalBusinesses(harness(fixture).pool, rows as never, { userId: "admin_outsider", access: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set<string>() }, gameScope: { mode: "SELECTED_GAMES", gameIds: [] } });
  assert.equal(outsider.views.get("approval_req_settle")!.summaryAvailable, false);
  assert.equal(outsider.views.get("approval_req_grant")!.summaryAvailable, false);
  assert.equal(JSON.stringify([...outsider.views.values()]).includes("proposedOwnerNet"), false, "unauthorized readers must not see amounts through the list projection");

  const scoped = await projectApprovalBusinesses(harness(fixture).pool, [rows[1]!] as never, { userId: CANDIDATE.id, access: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["membership.entitlement.decide"]) }, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_b"] } });
  assert.deepEqual(scoped.views.get("approval_req_grant")!.restrictedReasonCodes, ["GAME_SCOPE_DENIED"]);
});

test("list projection query count stays constant as rows grow", async () => {
  const requests = Array.from({ length: 12 }, (_unused, index) => requestFixture({ id: "approval_req_" + index, operationCode: "membership.entitlement.grant", operationPayload: { gameId: "game_a", userId: "user_" + index, kind: "FRIEND", scopeKey: "s", pricing: { mode: "RATIO" } } }));
  const fixture: Fixture = {
    actors: [BOSS, REQUESTER, CANDIDATE],
    requests,
    templates: [{ id: "approval_tpl_m", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_m", adminUserId: CANDIDATE.id }],
    requestCandidates: requests.map((row) => ({ requestId: row.id, adminUserId: CANDIDATE.id })),
    games: [{ id: "game_a", name: "三角洲行动" }],
    entitlements: [],
    policies: [{ id: "policy_a", version: 1, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null }],
  };
  const many = harness(fixture);
  const manyResult = await call(many, BOSS.id, "GET", "/approvals/requests/mine?limit=20");
  assert.equal(manyResult.status, 200, JSON.stringify(manyResult.body));
  assert.equal(manyResult.body.requests.length, 12);
  const manyCalls = many.calls.length;

  const single = harness({ ...fixture, requests: [requests[0]!], requestCandidates: [{ requestId: requests[0]!.id, adminUserId: CANDIDATE.id }] });
  const singleResult = await call(single, BOSS.id, "GET", "/approvals/requests/mine?limit=20");
  assert.equal(singleResult.body.requests.length, 1);
  assert.equal(single.calls.length, manyCalls, "list projection must not add queries per row");
  assert.equal(singleResult.body.requests[0].payload, undefined, "the raw payload stays out of the list");
  assert.ok(singleResult.body.requests[0].actions.some((item: { action: string; allowed: boolean }) => item.action === "approve"));
  assert.equal(singleResult.body.requests[0].business.summaryAvailable, true);
  assert.equal(singleResult.body.requests[0].candidateAvailability.eligible, 1);
});

test("candidate without an eligible snapshot is explained instead of silently undecidable", async () => {
  const view = harness(baseFixture({ requestCandidates: [{ requestId: "approval_req_target", adminUserId: REQUESTER.id }] }));
  const detail = await call(view, REQUESTER.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.candidates[0].eligible, false, "the existing candidate eligibility field keeps its meaning");
  assert.equal(detail.body.candidateAvailability.eligible, 0);
  assert.equal(detail.body.candidateAvailability.blockingReasonCode, "NO_ELIGIBLE_CANDIDATE");

  const frozen = harness(baseFixture({ actors: [BOSS, REQUESTER, { ...CANDIDATE, status: "FROZEN" }] }));
  const frozenDetail = await call(frozen, REQUESTER.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(frozenDetail.status, 200, JSON.stringify(frozenDetail.body));
  assert.equal(frozenDetail.body.candidateAvailability.eligible, 0);
  assert.equal(frozenDetail.body.candidateAvailability.blockingReasonCode, "NO_ELIGIBLE_CANDIDATE");
  assert.ok(frozenDetail.body.actions.some((item: { action: string; reasonCode: string; allowed: boolean }) => item.action === "addCandidate" && item.allowed));
});

test("operations and candidate-options reads gate on their own permissions", async () => {
  const view = harness(baseFixture());
  const operations = await call(view, REQUESTER.id, "GET", "/approvals/operations");
  assert.equal(operations.status, 200, JSON.stringify(operations.body));
  const byCode = new Map<string, any>(operations.body.operations.map((item: { operationCode: string }) => [item.operationCode, item]));
  assert.equal(byCode.get("order.settlement.adjust").initiation.allowed, false);
  assert.equal(byCode.get("order.settlement.adjust").initiation.reasonCode, "INITIATED_FROM_SOURCE_BUSINESS");
  assert.equal(byCode.get("membership.entitlement.grant").initiation.allowed, false, "the requester lacks the membership request permission in this fixture");
  assert.equal(byCode.get("membership.benefit.policy.publish").initiation.allowed, false);
  assert.equal(byCode.get("approval.test.execute").testOnly, true);
  assert.ok(byCode.get("approval.test.execute").triggers.length >= 1);

  const bossOperations = await call(view, BOSS.id, "GET", "/approvals/operations");
  assert.equal(bossOperations.body.operations.find((item: { operationCode: string }) => item.operationCode === "membership.entitlement.grant").initiation.allowed, true);

  const options = await call(view, BOSS.id, "GET", "/approvals/candidate-options");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.ok(options.body.candidates.some((item: { username: string }) => item.username === CANDIDATE.username));
  assert.equal(options.body.requiredPermission, "approval.template.configure");

  const asRequester = await call(view, REQUESTER.id, "GET", "/approvals/candidate-options?requestId=approval_req_target");
  assert.equal(asRequester.status, 200, JSON.stringify(asRequester.body));
  assert.equal(asRequester.body.requesterExcluded, true);
  assert.equal(asRequester.body.candidates.some((item: { username: string }) => item.username === REQUESTER.username), false, "the original requester must never be offered as a self-approver");
  assert.equal(asRequester.body.requiredPermission, "approval.request.add_approver");

  const outsider = await call(view, CANDIDATE.id, "GET", "/approvals/candidate-options?requestId=approval_req_target");
  assert.equal(outsider.status, 403, "only the requester or a Boss may choose additional candidates");

  const noPermission = harness(baseFixture({ actors: [BOSS, { ...REQUESTER, permissions: [] }, CANDIDATE] }));
  assert.equal((await call(noPermission, REQUESTER.id, "GET", "/approvals/candidate-options")).status, 403);
});

test("R2-1 game scope gates the create POST exactly like the recovery GET", async () => {
  const creator: FixtureActor = { id: "admin_creator", username: "zz00012", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.create", "approval.request.read", "membership.entitlement.request"] };
  const grantPayload = { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s", startsAtUtc: FUTURE, endsAtUtc: FUTURE, policyId: "policy_a", pricing: unifiedPricingFixture };
  const createBody = { operationCode: "membership.entitlement.grant", triggerCondition: "manual", payloadVersion: 1, payload: grantPayload, summary: "越范围创建必须当场拒绝" };
  const outOfScopeCreator = { ...creator, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } };
  const outOfScope = harness(baseFixture({
    actors: [BOSS, outOfScopeCreator, CANDIDATE],
    requests: [],
    templates: [{ id: "approval_tpl_g", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_g", adminUserId: CANDIDATE.id }],
    requestCandidates: [],
    games: [{ id: "game_a", name: "三角洲行动" }],
    policies: [{ id: "policy_a", version: 1, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null }],
  }));
  const denied = await call(outOfScope, creator.id, "POST", "/approvals/requests", createBody, { "idempotency-key": "idem_scope_create" });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.match(denied.message, /GAME_SCOPE_DENIED/);
  assert.equal(outOfScope.state.created, 0, "an out-of-scope creation must not persist a request");
  assert.equal(outOfScope.state.audits, 0, "an out-of-scope creation must not write a creation audit");
  assert.equal(outOfScope.state.idempotency.size, 0, "a rejected first attempt leaves no receipt to replay");

  const inScopeActor = { ...creator, gameScope: { mode: "ALL_GAMES", gameIds: [] } };
  const inScopeFixture = baseFixture({
    actors: [BOSS, inScopeActor, CANDIDATE],
    requests: [],
    templates: [{ id: "approval_tpl_g", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_g", adminUserId: CANDIDATE.id }],
    requestCandidates: [],
    games: [{ id: "game_a", name: "三角洲行动" }],
    policies: [{ id: "policy_a", version: 1, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null }],
  });
  const granted = harness(inScopeFixture);
  const created = await call(granted, creator.id, "POST", "/approvals/requests", createBody, { "idempotency-key": "idem_scope_create" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const createdRow = [...granted.state.requests.values()][0]!;

  const lostScope = harness({ ...inScopeFixture, actors: [BOSS, { ...creator, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } }, CANDIDATE], requests: [createdRow] }, [...granted.state.idempotency.entries()]);
  const getReceipt = await call(lostScope, creator.id, "GET", "/approvals/recovery?operation=approval.request.create&key=idem_scope_create");
  const replayPost = await call(lostScope, creator.id, "POST", "/approvals/requests", createBody, { "idempotency-key": "idem_scope_create" });
  assert.equal(getReceipt.status, 403, JSON.stringify(getReceipt.body));
  assert.equal(replayPost.status, getReceipt.status, "create replay and create recovery must share one authorization verdict");
  assert.equal(getReceipt.body.receipt, undefined);
});

test("R2-2 a registered request cannot supersede an unknown or expired one", async () => {
  const legacyRow = requestFixture({ operationCode: "legacy.unknown.thing", requestedBy: REQUESTER.id });
  const view = harness(baseFixture({
    requests: [legacyRow],
    templates: [
      { id: "approval_tpl_1", operationCode: "approval.test.execute", triggerCondition: "manual", version: 1 },
      { id: "approval_tpl_legacy", operationCode: "legacy.unknown.thing", triggerCondition: "manual", version: 1 },
    ],
    templateCandidates: [
      { templateId: "approval_tpl_1", adminUserId: CANDIDATE.id },
      { templateId: "approval_tpl_legacy", adminUserId: CANDIDATE.id },
    ],
  }));
  const blocked = await call(view, REQUESTER.id, "POST", "/approvals/requests", {
    operationCode: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "替代未知操作申请", supersedesRequestId: legacyRow.id,
  }, { "idempotency-key": "idem_supersede" });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.message, /OPERATION_UNREGISTERED/);
  assert.equal(view.state.created, 0, "an unknown request must not be modified through a replacement");
  assert.equal(view.state.requests.get(legacyRow.id)?.status, "PENDING", "the unknown request must keep its own state");

  const expiredRow = requestFixture({ id: "approval_req_expired", requestedBy: REQUESTER.id, expiresAt: PAST });
  const expiredView = harness(baseFixture({ requests: [expiredRow] }));
  const expiredReplace = await call(expiredView, REQUESTER.id, "POST", "/approvals/requests", {
    operationCode: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "替代已过期申请", supersedesRequestId: expiredRow.id,
  }, { "idempotency-key": "idem_supersede_expired" });
  assert.equal(expiredReplace.status, 409, JSON.stringify(expiredReplace.body));
  assert.equal(expiredView.state.created, 0);
  assert.equal(expiredView.state.requests.get(expiredRow.id)?.status, "PENDING", "an expired request is not cancelled by a replacement attempt");

  const standaloneUnknown = await call(view, REQUESTER.id, "POST", "/approvals/requests", {
    operationCode: "legacy.unknown.thing", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "独立未知操作仍可创建",
  }, { "idempotency-key": "idem_unknown_standalone" });
  assert.equal(standaloneUnknown.status, 200, JSON.stringify(standaloneUnknown.body));
  assert.equal(view.state.created, 1, "creating an independent unknown request stays allowed; modifying one does not");
});

for (const change of ["unchanged", "old-scope-revoked", "old-permission-revoked", "old-missing"] as const) {
  test(`R3 replacement recovery shares old-object authorization: ${change}`, async () => {
    const actor: FixtureActor = {
      ...REQUESTER,
      permissions: [...REQUESTER.permissions, "membership.entitlement.request", "membership.entitlement.revoke"],
      gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_a", "game_b"] },
    };
    const previous = requestFixture({
      operationCode: "membership.entitlement.revoke", requestedBy: actor.id,
      operationPayload: { gameId: "game_a", entitlementId: "ent_old" },
    });
    const view = harness(baseFixture({
      actors: [BOSS, actor, CANDIDATE], requests: [previous],
      templates: [{ id: "approval_tpl_1", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    }));
    const body = { operationCode: "membership.entitlement.grant", triggerCondition: "manual", payloadVersion: 1,
      payload: { gameId: "game_b", pricing: unifiedPricingFixture }, summary: "替代申请恢复授权", supersedesRequestId: previous.id };
    const headers = { "idempotency-key": "idem_r3_replacement" };
    const first = await call(view, actor.id, "POST", "/approvals/requests", body, headers);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // A committed replacement leaves its old request cancelled, not pending.
    assert.equal(view.state.requests.get(previous.id)!.status, "CANCELLED");
    const counts = { created: view.state.created, audits: view.state.audits, receipts: view.state.idempotency.size };
    if (change === "old-scope-revoked") actor.gameScope = { mode: "SELECTED_GAMES", gameIds: ["game_b"] };
    if (change === "old-permission-revoked") actor.permissions = actor.permissions.filter((code) => code !== "membership.entitlement.revoke");
    if (change === "old-missing") view.state.requests.delete(previous.id);
    const post = await call(view, actor.id, "POST", "/approvals/requests", body, headers);
    const get = await call(view, actor.id, "GET", "/approvals/recovery?operation=approval.request.create&key=idem_r3_replacement");
    const expected = change === "unchanged" ? 200 : change === "old-missing" ? 404 : 403;
    assert.equal(post.status, expected, JSON.stringify(post.body));
    assert.equal(get.status, expected, JSON.stringify(get.body));
    if (change === "unchanged") {
      assert.equal(post.body.approvalRequestId, first.body.approvalRequestId);
      assert.equal(post.body.idempotencyReplay, true);
      assert.equal(get.body.receipt.approvalRequestId, first.body.approvalRequestId);
    } else {
      for (const result of [post, get]) {
        assert.equal(result.body.receipt, undefined);
        assert.equal(result.body.approvalRequestId, undefined);
      }
    }
    assert.deepEqual({ created: view.state.created, audits: view.state.audits, receipts: view.state.idempotency.size }, counts);
  });
}

test("R2-3 candidate options and the append write both judge the request context", async () => {
  const grantPayload = { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s" };
  const grantRow = requestFixture({ operationCode: "membership.entitlement.grant", operationPayload: grantPayload, requestedBy: REQUESTER.id });
  const noDecide: FixtureActor = { id: "admin_nodecide", username: "zz00013", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read"] };
  const wrongScope: FixtureActor = { ...noDecide, id: "admin_wrongscope", username: "zz00014", permissions: ["approval.request.approve", "approval.request.read", "membership.entitlement.decide"], gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } };
  const buildFixture = (candidate: FixtureActor) => baseFixture({
    actors: [BOSS, REQUESTER, CANDIDATE, candidate],
    requests: [grantRow],
    templates: [{ id: "approval_tpl_g", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_g", adminUserId: CANDIDATE.id }],
    requestCandidates: [{ requestId: grantRow.id, adminUserId: CANDIDATE.id }],
    games: [{ id: "game_a", name: "三角洲行动" }],
    policies: [{ id: "policy_a", version: 1, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null }],
  });

  const missingBusiness = harness(buildFixture(noDecide));
  const picker = await call(missingBusiness, REQUESTER.id, "GET", "/approvals/candidate-options?requestId=" + grantRow.id);
  assert.equal(picker.status, 200, JSON.stringify(picker.body));
  assert.equal(picker.body.candidates.some((item: { username: string }) => item.username === noDecide.username), false, "a generic approver without the business decide permission is not choosable for this request");
  assert.equal(picker.body.excludedByReason.BUSINESS_PERMISSION_REQUIRED >= 1, true);

  const appendDenied = await call(missingBusiness, REQUESTER.id, "POST", "/approvals/requests/add-candidate", { requestId: grantRow.id, username: noDecide.username, reason: "试图追加无业务权限者" }, { "idempotency-key": "idem_append_biz" });
  assert.equal(appendDenied.status, 409, JSON.stringify(appendDenied.body));
  assert.equal(missingBusiness.state.requestCandidates.length, 1, "the append write re-checks the same condition the picker applied");

  const wrongScopeView = harness(buildFixture(wrongScope));
  const scopePicker = await call(wrongScopeView, REQUESTER.id, "GET", "/approvals/candidate-options?requestId=" + grantRow.id);
  assert.equal(scopePicker.body.candidates.some((item: { username: string }) => item.username === wrongScope.username), false, "a decider outside the target game is not choosable for this request");
  assert.equal(scopePicker.body.excludedByReason.GAME_SCOPE_DENIED >= 1, true);
  const scopeAppend = await call(wrongScopeView, REQUESTER.id, "POST", "/approvals/requests/add-candidate", { requestId: grantRow.id, username: wrongScope.username, reason: "试图追加越范围者" }, { "idempotency-key": "idem_append_scope" });
  assert.equal(scopeAppend.status, 409);
  assert.equal(wrongScopeView.state.requestCandidates.length, 1);

  const templateLevel = await call(missingBusiness, BOSS.id, "GET", "/approvals/candidate-options");
  assert.equal(templateLevel.status, 200, JSON.stringify(templateLevel.body));
  assert.equal(templateLevel.body.candidates.some((item: { username: string }) => item.username === noDecide.username), true, "without a request context the picker stays at the generic qualification used for template wiring");
});

test("registration exposes execution modes for the five formal operations and the test operation", () => {
  const codes = ["membership.benefit.policy.publish", "membership.entitlement.grant", "membership.entitlement.replace", "membership.entitlement.revoke", "order.settlement.adjust", "approval.test.execute"];
  for (const code of codes) assert.ok(approvalRegistration(code), code + " must be registered");
  assert.equal(approvalRegistration("order.settlement.adjust")!.executionMode, APPROVAL_EXECUTION_MODE.sourceBusiness);
  assert.equal(approvalRegistration("membership.entitlement.grant")!.executionMode, APPROVAL_EXECUTION_MODE.genericTransaction);
  assert.equal(approvalRegistration("approval.test.execute")!.testOnly, true);
  assert.equal(approvalRegistration("withdrawal.manual.approve"), null);
});

test("F1 candidate options return real identities instead of unknown placeholders", async () => {
  const view = harness(baseFixture());
  const options = await call(view, BOSS.id, "GET", "/approvals/candidate-options");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const listed = options.body.candidates.find((item: { username: string }) => item.username === CANDIDATE.username);
  assert.ok(listed, "the picker must carry the real login name from the SQL projection");
  assert.equal(listed.displayUsername, "ZZ00003");
  assert.equal(options.body.candidates.some((item: { username: string }) => item.username === "unknown"), false, "a missing identity column must not degrade to unknown");
  assert.equal(options.body.candidates.some((item: Record<string, unknown>) => "ip" in item || "session" in item), false);
});

test("F2 a personal DENY over a role grant is neither an eligible candidate nor a writable approver", async () => {
  const denied: FixtureActor = {
    id: "admin_denied", username: "zz00006", status: "ACTIVE", isBoss: false, twoFactorEnabled: true,
    permissions: [], rolePermissions: ["approval.request.approve", "approval.request.read"], deniedPermissions: ["approval.request.approve"],
  };
  const fixture = baseFixture({ actors: [BOSS, REQUESTER, CANDIDATE, denied], requestCandidates: [{ requestId: "approval_req_target", adminUserId: denied.id }] });
  const view = harness(fixture);
  const detail = await call(view, BOSS.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.candidateAvailability.total, 1);
  assert.equal(detail.body.candidateAvailability.eligible, 0, "a denied permission must subtract from role grants too");
  assert.equal(detail.body.candidateAvailability.blockingReasonCode, "NO_ELIGIBLE_CANDIDATE");

  const picker = await call(view, BOSS.id, "GET", "/approvals/candidate-options");
  assert.equal(picker.body.candidates.some((item: { username: string }) => item.username === denied.username), false, "a denied permission must not be offered as a candidate");
  assert.equal(picker.body.excludedByReason.PERMISSION_REQUIRED >= 1, true, "the exclusion is explained by reason without exposing the person");
  assert.equal(picker.body.candidates.some((item: { username: string }) => item.username === CANDIDATE.username), true);

  const write = await call(view, denied.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_deny" });
  assert.equal(write.status, 403, "the write path must reject the same person the picker marks ineligible");
  assert.equal(view.state.decisions, 0);
});

test("F2 candidate eligibility is per request: business permission and game scope both count", async () => {
  const noBusiness: FixtureActor = { id: "admin_nobiz", username: "zz00010", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read"] };
  const wrongScope: FixtureActor = { id: "admin_scope", username: "zz00011", status: "ACTIVE", isBoss: false, twoFactorEnabled: true, permissions: ["approval.request.approve", "approval.request.read", "membership.entitlement.decide"], gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } };
  const grantRow = requestFixture({ operationCode: "membership.entitlement.grant", operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s" } });
  const build = (candidateId: string) => baseFixture({
    actors: [BOSS, REQUESTER, noBusiness, wrongScope],
    requests: [grantRow],
    templates: [{ id: "approval_tpl_m", operationCode: "membership.entitlement.grant", triggerCondition: "manual", version: 1 }],
    templateCandidates: [{ templateId: "approval_tpl_m", adminUserId: candidateId }],
    requestCandidates: [{ requestId: grantRow.id, adminUserId: candidateId }],
    games: [{ id: "game_a", name: "三角洲行动" }],
  });

  const missingBusiness = harness(build(noBusiness.id));
  const businessView = await call(missingBusiness, BOSS.id, "GET", "/approvals/requests/detail?requestId=" + grantRow.id);
  assert.equal(businessView.body.candidateAvailability.eligible, 0, "a candidate without the membership decide permission cannot decide this request");
  assert.equal(businessView.body.candidateAvailability.blockingReasonCode, "NO_ELIGIBLE_CANDIDATE");

  const outOfScope = harness(build(wrongScope.id));
  const scopeView = await call(outOfScope, BOSS.id, "GET", "/approvals/requests/detail?requestId=" + grantRow.id);
  assert.equal(scopeView.body.candidateAvailability.eligible, 0, "a candidate outside the target game scope cannot decide this request");

  const operations = await call(missingBusiness, BOSS.id, "GET", "/approvals/operations");
  const grantOperation = operations.body.operations.find((item: { operationCode: string }) => item.operationCode === "membership.entitlement.grant");
  assert.equal(grantOperation.triggers[0].candidateEligible, 1, "template-level availability stays a generic qualification, not a per-request verdict");
});

test("F2 a candidate group holding only the requester is not decidable", async () => {
  const selfCandidate: FixtureActor = { ...REQUESTER, permissions: [...REQUESTER.permissions, "approval.request.approve", "approval.request.read"] };
  const view = harness(baseFixture({
    actors: [BOSS, selfCandidate, CANDIDATE],
    requests: [requestFixture({ requestedBy: selfCandidate.id })],
    requestCandidates: [{ requestId: "approval_req_target", adminUserId: selfCandidate.id }],
  }));
  const detail = await call(view, BOSS.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.candidateAvailability.total, 1);
  assert.equal(detail.body.candidateAvailability.eligible, 0, "the applicant may never be the only decidable candidate");
  assert.equal(detail.body.candidateAvailability.blockingReasonCode, "NO_ELIGIBLE_CANDIDATE");
});

test("F3 a revoked authority denies the GET recovery and the POST replay identically", async () => {
  const grantRow = requestFixture({ operationCode: "membership.entitlement.grant", operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s" } });
  const fixture = baseFixture({ requests: [grantRow], games: [{ id: "game_a", name: "三角洲行动" }] });
  const granted = harness(fixture);
  const body = { requestId: grantRow.id, decision: "APPROVE" as const };
  const first = await call(granted, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_recovery" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const known = await call(granted, CANDIDATE.id, "GET", `/approvals/recovery?operation=approval.request.decide&key=idem_recovery&requestId=${encodeURIComponent(grantRow.id)}`);
  assert.equal(known.body.knowledge, "KNOWN");
  assert.equal(known.body.receipt.approvalRequestId, grantRow.id);

  const receiptSeed = [...granted.state.idempotency.entries()];

  const revokedPermission = harness({ ...fixture, actors: [BOSS, REQUESTER, { ...CANDIDATE, permissions: ["approval.request.read"] }] }, receiptSeed);
  const getDenied = await call(revokedPermission, CANDIDATE.id, "GET", `/approvals/recovery?operation=approval.request.decide&key=idem_recovery&requestId=${encodeURIComponent(grantRow.id)}`);
  const postDenied = await call(revokedPermission, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_recovery" });
  assert.equal(getDenied.status, 403, JSON.stringify(getDenied.body));
  assert.equal(postDenied.status, getDenied.status, "recovery and replay must share one authorization verdict");
  assert.equal(getDenied.code, "FORBIDDEN");

  const revokedScope = harness({ ...fixture, actors: [BOSS, REQUESTER, { ...CANDIDATE, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } }] }, receiptSeed);
  const getScope = await call(revokedScope, CANDIDATE.id, "GET", `/approvals/recovery?operation=approval.request.decide&key=idem_recovery&requestId=${encodeURIComponent(grantRow.id)}`);
  const postScope = await call(revokedScope, CANDIDATE.id, "POST", "/approvals/requests/decision", body, { "idempotency-key": "idem_recovery" });
  assert.equal(getScope.status, 403);
  assert.match(getScope.message, /GAME_SCOPE_DENIED/);
  assert.equal(postScope.status, getScope.status, "a lost game scope must not read a receipt it cannot replay");
  assert.equal(getScope.body.receipt, undefined, "a denied recovery must not leak the original receipt");

  const createReceipt = (approvalRequestId: string): [string, { fingerprint: string; status: number; body: unknown; createdAt: string }] => [
    `${JSON.stringify(["admin", REQUESTER.id, "approval.request.create", null])}|idem_create_scope`,
    { fingerprint: "e".repeat(64), status: 200, body: { approvalRequestId, requestId: approvalRequestId, status: "PENDING" }, createdAt: new Date().toISOString() },
  ];
  const creator: FixtureActor = { ...REQUESTER, permissions: [...REQUESTER.permissions, "membership.entitlement.request"] };
  const memberRow = requestFixture({ id: "approval_req_member", operationCode: "membership.entitlement.grant", operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s" }, requestedBy: REQUESTER.id });
  const memberFixture = { ...baseFixture({ requests: [memberRow], games: [{ id: "game_a", name: "三角洲行动" }] }), actors: [BOSS, creator, CANDIDATE] };
  const recoveryPath = "/approvals/recovery?operation=approval.request.create&key=idem_create_scope";

  const createKnown = await call(harness(memberFixture, [createReceipt(memberRow.id)]), REQUESTER.id, "GET", recoveryPath);
  assert.equal(createKnown.status, 200, JSON.stringify(createKnown.body));
  assert.equal(createKnown.body.knowledge, "KNOWN", "a create receipt stays readable while the creator keeps the original authority and scope");
  assert.equal(createKnown.body.receipt.approvalRequestId, memberRow.id);

  const createLost = await call(harness({ ...memberFixture, actors: [BOSS, { ...creator, permissions: ["approval.request.read"] }, CANDIDATE] }, [createReceipt(memberRow.id)]), REQUESTER.id, "GET", recoveryPath);
  assert.equal(createLost.status, 403, "losing the original create permission also closes the GET recovery");
  assert.equal(createLost.body.receipt, undefined, "a denied recovery must not leak the original receipt");

  const createOutOfScope = await call(harness({ ...memberFixture, actors: [BOSS, { ...creator, gameScope: { mode: "SELECTED_GAMES", gameIds: ["game_other"] } }, CANDIDATE] }, [createReceipt(memberRow.id)]), REQUESTER.id, "GET", recoveryPath);
  assert.equal(createOutOfScope.status, 403);
  assert.match(createOutOfScope.message, /GAME_SCOPE_DENIED/, "the create receipt is verified against the saved request's game scope");
});

test("F4 a successful revoke links its result instead of staying unresolved forever", async () => {
  const revokeRow = { id: "approval_req_revoke", operationCode: "membership.entitlement.revoke", payloadVersion: 1, operationPayload: { entitlementId: "ent_1", gameId: "game_a", scopeKey: "s", reason: "违规收回" }, operationPayloadHash: "d".repeat(64), summary: "撤销礼遇", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE };
  const base = {
    actors: [BOSS, REQUESTER, CANDIDATE],
    games: [{ id: "game_a", name: "三角洲行动" }],
    entitlements: [{ id: "ent_1", approvalRequestId: "approval_req_original_grant", status: "REVOKED", revokedReason: "违规收回", startsAt: FUTURE, endsAt: FUTURE, userId: "user_a", gameId: "game_a", kind: "FRIEND", scopeKey: "s", approvedPolicyId: "policy_a", replacedById: null }],
    policies: [{ id: "policy_a", version: 1, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null }],
  };
  const bossAccess = { status: "ACTIVE" as const, isBoss: true, passwordChangeRequired: false, permissions: new Set<string>() };
  const withReceipt = await projectApprovalBusinesses(harness({ ...base, executions: [{ requestId: "approval_req_revoke", status: "SUCCEEDED", resultCode: "MEMBERSHIP_ENTITLEMENT_REVOKED", resultDetail: "ent_1" }] }).pool, [revokeRow] as never, { userId: BOSS.id, access: bossAccess, gameScope: { mode: "ALL_GAMES", gameIds: [] } });
  const view = withReceipt.views.get("approval_req_revoke")!;
  assert.equal(view.resultAvailability, "KNOWN", "a committed revoke execution must be readable even though the entitlement keeps its original grant id");
  assert.equal((view.entitlement as Record<string, unknown>).status, "REVOKED");
  assert.equal((view.entitlement as Record<string, unknown>).effectiveState, "REVOKED");
  assert.equal((view.executionReceipt as Record<string, unknown>).resultCode, "MEMBERSHIP_ENTITLEMENT_REVOKED");
  assert.equal(JSON.stringify(view.objectRefs).includes("ent_1"), true);
  assert.equal(JSON.stringify(view.summary).includes("ent_1"), true, "the frozen target stays listed in the summary, separate from the execution receipt");

  const withoutReceipt = await projectApprovalBusinesses(harness(base).pool, [revokeRow] as never, { userId: BOSS.id, access: bossAccess, gameScope: { mode: "ALL_GAMES", gameIds: [] } });
  assert.equal(withoutReceipt.views.get("approval_req_revoke")!.resultAvailability, "UNRESOLVED", "executed but unreadable stays a distinct answer");
});

test("F4 each formal operation links its own business result", async () => {
  const rows = [
    { id: "ar_publish", operationCode: "membership.benefit.policy.publish", payloadVersion: 1, operationPayload: { policyDraftId: "policy_draft", policyDraftVersion: 2 }, operationPayloadHash: "1".repeat(64), summary: "发布政策", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "ar_grant", operationCode: "membership.entitlement.grant", payloadVersion: 1, operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s", policyId: "policy_approved" }, operationPayloadHash: "2".repeat(64), summary: "发放", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "ar_replace", operationCode: "membership.entitlement.replace", payloadVersion: 1, operationPayload: { gameId: "game_a", userId: "user_a", kind: "FRIEND", scopeKey: "s", policyId: "policy_approved", replaceEntitlementId: "ent_old" }, operationPayloadHash: "3".repeat(64), summary: "替换", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "ar_revoke", operationCode: "membership.entitlement.revoke", payloadVersion: 1, operationPayload: { gameId: "game_a", entitlementId: "ent_old", scopeKey: "s", reason: "收回" }, operationPayloadHash: "4".repeat(64), summary: "撤销", requestedBy: REQUESTER.id, status: "EXECUTED", decidedBy: BOSS.id, expiresAt: FUTURE },
    { id: "ar_settle", operationCode: "order.settlement.adjust", payloadVersion: 1, operationPayload: { orderId: "order_1", reason: "调整", proposedOwnerNet: "10.00", proposedRenterRefund: "5.00", amounts: { ownerNet: "9.00", renterRefund: "6.00" } }, operationPayloadHash: "5".repeat(64), summary: "调整结算", requestedBy: REQUESTER.id, status: "APPROVED", decidedBy: BOSS.id, expiresAt: FUTURE },
  ];
  const view = harness({
    actors: [BOSS, REQUESTER, CANDIDATE],
    games: [{ id: "game_a", name: "三角洲行动" }],
    entitlements: [
      { id: "ent_new", approvalRequestId: "ar_grant", status: "ACTIVE", startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: FUTURE, userId: "user_a", gameId: "game_a", kind: "FRIEND", scopeKey: "s", approvedPolicyId: "policy_approved", replacedById: null },
      { id: "ent_new2", approvalRequestId: "ar_replace", status: "EXECUTED_PENDING_START", startsAt: FUTURE, endsAt: FUTURE, userId: "user_a", gameId: "game_a", kind: "FRIEND", scopeKey: "s", approvedPolicyId: "policy_approved", replacedById: null },
      { id: "ent_old", approvalRequestId: "ar_other", status: "REPLACED", startsAt: new Date(Date.now() - 9000).toISOString(), endsAt: FUTURE, userId: "user_a", gameId: "game_a", kind: "FRIEND", scopeKey: "s", approvedPolicyId: "policy_approved", replacedById: "ent_new2" },
    ],
    policies: [
      { id: "policy_approved", version: 4, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: null },
      { id: "policy_draft", version: 2, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: "ar_publish" },
      { id: "policy_new", version: 3, status: "APPROVED", effectiveAt: null, priceVersionId: "p", ruleReleaseId: "r", approvalRequestId: "ar_publish" },
    ],
    settlementVersions: [{ id: "setver_9", orderId: "order_1", gameId: "game_a", versionNo: 9, versionHash: "5".repeat(64), kind: "MANUAL_ADJUSTMENT", early: false, endReason: "NORMAL", initiatorParty: "SUPPORT", approvalRequestId: "ar_settle", supersededAt: null, postingId: "post_9", postedAt: FUTURE, refundDueAt: FUTURE }],
    settlementDecisions: [{ versionId: "setver_9", party: "RENTER", action: "CONFIRM" }, { versionId: "setver_9", party: "OWNER", action: "CONFIRM" }],
    executions: [
      { requestId: "ar_publish", status: "SUCCEEDED", resultCode: "MEMBERSHIP_POLICY_PUBLISHED", resultDetail: "policy_new" },
      { requestId: "ar_grant", status: "SUCCEEDED", resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED", resultDetail: "ent_new" },
      { requestId: "ar_replace", status: "SUCCEEDED", resultCode: "MEMBERSHIP_ENTITLEMENT_REPLACED", resultDetail: "ent_new2" },
      { requestId: "ar_revoke", status: "SUCCEEDED", resultCode: "MEMBERSHIP_ENTITLEMENT_REVOKED", resultDetail: "ent_old" },
    ],
  });
  const bossAccess = { status: "ACTIVE" as const, isBoss: true, passwordChangeRequired: false, permissions: new Set<string>() };
  const projection = await projectApprovalBusinesses(view.pool, rows as never, { userId: BOSS.id, access: bossAccess, gameScope: { mode: "ALL_GAMES", gameIds: [] } });

  assert.equal(projection.views.get("ar_publish")!.resultAvailability, "KNOWN");
  assert.ok(projection.views.get("ar_publish")!.publishedPolicy, "policy publish links the published version");
  assert.equal(projection.views.get("ar_grant")!.resultAvailability, "KNOWN");
  assert.equal((projection.views.get("ar_grant")!.entitlement as Record<string, unknown>).effectiveState, "EFFECTIVE", "an active entitlement reads as effective, separate from the approval status");
  assert.equal(projection.views.get("ar_replace")!.resultAvailability, "KNOWN");
  assert.equal(JSON.stringify(projection.views.get("ar_replace")!.summary).includes("REPLACED"), true, "the replaced source keeps its own current state");
  assert.equal(projection.views.get("ar_revoke")!.resultAvailability, "KNOWN");
  assert.equal(projection.views.get("ar_settle")!.resultAvailability, "KNOWN");
  assert.equal((projection.views.get("ar_settle")!.settlementResult as Record<string, unknown>).posted, true);
  assert.deepEqual(projection.views.get("ar_settle")!.pendingConditionCodes, [], "both parties confirmed a normal settlement leaves nothing pending");
  assert.equal(JSON.stringify([...projection.views.values()]).includes("feeAmount"), false);
});

test("F5 an unregistered request blocks every mutation entry", async () => {
  const view = harness(baseFixture({ requests: [requestFixture({ operationCode: "legacy.unknown.thing" })] }));
  const detail = await call(view, BOSS.id, "GET", "/approvals/requests/detail?requestId=approval_req_target");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const blocked = detail.body.actions.filter((item: { allowed: boolean }) => item.allowed === true);
  assert.deepEqual(blocked, [], "no action may be offered on an unregistered operation");
  assert.equal(detail.body.actions.every((item: { reasonCode: string }) => item.reasonCode === "OPERATION_UNREGISTERED"), true);
  assert.equal(detail.body.business.summaryAvailable, false);

  const decision = await call(view, CANDIDATE.id, "POST", "/approvals/requests/decision", { requestId: "approval_req_target", decision: "APPROVE" }, { "idempotency-key": "idem_unregistered" });
  assert.equal(decision.status, 409);
  assert.match(decision.message, /OPERATION_UNREGISTERED/);
  assert.equal(view.state.decisions, 0, "a rejected unregistered decision must not write a decision row");

  const append = await call(view, BOSS.id, "POST", "/approvals/requests/add-candidate", { requestId: "approval_req_target", username: CANDIDATE.username, reason: "补齐候选" }, { "idempotency-key": "idem_unregistered_append" });
  assert.equal(append.status, 409);
  assert.equal(view.state.requestCandidates.length, 1, "an unregistered request must not gain candidates either");

  const registered = await call(view, BOSS.id, "GET", "/approvals/operations");
  assert.equal(registered.body.operations.every((item: { operationCode: string }) => item.operationCode !== "legacy.unknown.thing"), true, "unregistered codes stay outside the operation registry");
});

test("approval business effective state follows interval truth at one read time", async () => {
  const at = new Date(), day = 86_400_000, instant = (offset: number) => new Date(at.getTime() + offset).toISOString();
  const sample = entitlementAmendmentFixture();
  type ResultCase = { id: string; status: string; startsAt: string | null; endsAt: string | null };
  const read = async (cases: ResultCase[]) => {
    const requests = cases.map((item) => {
      const payload = { ...sample.row.operationPayload, startsAtUtc: item.startsAt ?? instant(-day), endsAtUtc: item.endsAt ?? instant(day) };
      return requestFixture({ ...sample.row, id: item.id, requestedBy: BOSS.id, status: "EXECUTED", decidedBy: CANDIDATE.id, operationPayload: payload, operationPayloadHash: hashApprovalPayload(payload).hash, createdAt: instant(-3 * day), expiresAt: instant(-2 * day) });
    });
    const view = harness({ ...sample.fixture, requests,
      requestCandidates: requests.map((row) => ({ requestId: row.id, adminUserId: CANDIDATE.id })),
      entitlements: cases.map((item) => ({ ...item, id: "ent_" + item.id, userId: "member_1", gameId: "game_1", kind: "FRIEND", scopeKey: "game:delta", approvedPolicyId: "policy_1", approvalRequestId: item.id, replacedById: null })),
      executions: requests.map((row) => ({ requestId: row.id, status: "SUCCEEDED", resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED", resultDetail: "ent_" + row.id })),
    });
    const result = await call(view, BOSS.id, "GET", "/approvals/requests/mine?limit=20");
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual([view.state.created, view.state.decisions, view.state.executions, view.state.audits], [0, 0, 0, 0]);
    const byId = new Map<string, Record<string, any>>(result.body.requests.map((item: Record<string, any>) => [item.requestId, item]));
    return cases.map((item) => byId.get(item.id)!.business.entitlement.effectiveState);
  };
  const states = await read([
    { id: "expiry_active", status: "ACTIVE", startsAt: instant(-2 * day), endsAt: instant(-day) },
    { id: "future_start", status: "EXECUTED_PENDING_START", startsAt: instant(day), endsAt: instant(2 * day) },
    { id: "revoked", status: "REVOKED", startsAt: instant(-2 * day), endsAt: instant(-day) },
    { id: "time_unknown", status: "ACTIVE", startsAt: null, endsAt: null },
    { id: "active_now", status: "ACTIVE", startsAt: instant(-day), endsAt: instant(day) },
  ]);
  // Cross a start boundary between per-row clock reads; one projection must share its asOf.
  const originalNow = Date.now; let reads = 0, batchStates: string[];
  try {
    Date.now = () => at.getTime() + reads++ * 2 * 3_600_000;
    batchStates = await read([0, 1, 2].map((index) => ({ id: "same_asof_" + index, status: "EXECUTED_PENDING_START", startsAt: instant(3_600_000), endsAt: instant(day) })));
  } finally { Date.now = originalNow; }
  assert.deepEqual(states, ["EXPIRED", "NOT_STARTED", "REVOKED", "UNKNOWN", "EFFECTIVE"]);
  assert.deepEqual(batchStates, ["NOT_STARTED", "NOT_STARTED", "NOT_STARTED"]);
});

test("policy context explicit asOf preserves expiry microseconds while original approval callers retain the default clock", () => {
  const row = { status: "APPROVED" as const, expiresAt: "2026-10-25T12:00:00.123457Z" };
  assert.equal(virtualRequestStatus(row, "2026-10-25T12:00:00.123456Z"), "APPROVED");
  assert.equal(virtualRequestStatus(row, row.expiresAt), "EXPIRED");
  assert.equal(virtualRequestStatus({ ...row, status: "PENDING" }, row.expiresAt), "EXPIRED");
  assert.equal(virtualRequestStatus({ ...row, status: "EXECUTED" }, row.expiresAt), "EXECUTED");
  const originalNow = Date.now;
  try { Date.now = () => Date.parse(row.expiresAt); assert.equal(virtualRequestStatus(row), "EXPIRED", "the original writer's default millisecond behavior is unchanged"); }
  finally { Date.now = originalNow; }
});

test("policy context can reuse the original request scope with the same transaction client and no locks", async () => {
  const calls: unknown[][] = [], client = { query: async (sql: string, values: unknown[]) => { assert.match(sql, /requested_by/); assert.match(sql, /approval_request_candidate/); assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE|INSERT|UPDATE|DELETE/); calls.push(values); return { rows: [{ allowed: true }] }; } } as unknown as PoolClient;
  assert.equal(await requestScope(client, "policy_viewer", "policy_request", false), true); assert.deepEqual(calls, [["policy_viewer", "policy_request"]]);
  assert.equal(await requestScope(client, "boss_viewer", "policy_request", true), true); assert.equal(calls.length, 1, "existing Boss scope does not invent another role or query");
});
