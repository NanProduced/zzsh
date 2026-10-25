import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { bindJoinpayAccountProfile, readJoinpayAccountObservation, type JoinpayAccountServerProfile } from "../src/finance/joinpay-account";
import { refreshJoinpayAccount, refreshJoinpayAccountBySystem, recoverJoinpayAccountObservation, readJoinpayAccountSummary, AccountObservationWriteError } from "../src/finance/joinpay-account-store";

// 虚构后台配置/KAT模型；不是已取得的官方原件。所有响应由fake fetch返回。
const KEY = "SYNTHETIC_ACCOUNT_KEY", USER = "999900000000005", md5 = (s: string) => createHash("md5").update(s).digest("hex");
function raw(code = "2001") {
  const sig = md5(code + "ok" + USER + "fictional" + "201" + "12.00" + "1.00" + KEY);
  return `{"statusCode":${code},"message":"ok","data":{"userNo":"${USER}","userName":"fictional","currency":201,"useAbleSettAmount":12.00,"availableSettAmountFrozen":1.00,"errorCode":"","errorDesc":"","hmac":"${sig}"}}`;
}
function profile(purpose: "MERCHANT_READ" | "SYNTHETIC_PROTOCOL" = "MERCHANT_READ") {
  const responseBody = raw();
  const c: JoinpayAccountServerProfile = { purpose, resourceDatabase: "synthetic_balance_test", resourceRuntimeUser: "synthetic_balance_r", operation: "AVAILABLE", profileId: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL", merchantIdentityId: "synthetic_account_store", userNo: USER, keyVersionRef: "synthetic_store_key",
    reviewRef: "SYNTHETIC_REVIEW_NOT_OFFICIAL", reviewSha256: "b".repeat(64), permission: "REVIEWED_MERCHANT_BALANCE_READ",
    rules: { dataEncoding: "OBJECT", statusCodeToken: "NUMBER", amountToken: "NUMBER", currencyToken: "NUMBER", numericSigning: "RAW_JSON_TOKEN", optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT", unknownFields: "REJECT", amount: { unit: "UNKNOWN" } },
    knownAnswer: { reference: "SYNTHETIC_NOT_OFFICIAL", sha256: createHash("sha256").update(responseBody).digest("hex"), vectorKey: KEY, requestHmac: md5(USER + KEY), responseBody } };
  return bindJoinpayAccountProfile(c);
}
const actor = { adminId: "synthetic_admin", sessionId: "synthetic_session", requestId: "synthetic_request" };

test("系统刷新沿原存储事务记system审计，不伪造admin/session；合成响应仍为合成", async () => {
  const m = memory();
  const r = await refreshJoinpayAccountBySystem(m.pool, profile(), { keyFor: () => KEY, fetch: async () => new Response(raw()) }, "system_request");
  assert.equal(r.integration, "INTEGRATED"); assert.equal(r.result!.evidenceLevel, "SYNTHETIC_PROTOCOL");
  const audit = m.state.audit[0]!; assert.equal(audit[1], "system"); assert.equal(audit[2], "joinpay-account-observer");
  assert.equal(audit[3], null); assert.equal(audit[8], "system_request"); assert.equal(m.state.rows.length, 1);
});
test("系统刷新在PG/key之前拒绝合成用途与非法requestId", async () => {
  const m = memory(); let keys = 0;
  const deps = { keyFor: () => { keys++; return KEY; }, fetch: async () => new Response(raw()) };
  await assert.rejects(refreshJoinpayAccountBySystem(m.pool, profile("SYNTHETIC_PROTOCOL"), deps, "system_request"), /SYNTHETIC_NETWORK_FORBIDDEN/);
  await assert.rejects(refreshJoinpayAccountBySystem(m.pool, profile(), deps, " "), /ACCOUNT_ACTOR_INVALID/);
  assert.equal(keys, 0); assert.equal(m.state.connectCount, 0);
});
test("系统观察审计故障回滚；COMMIT未知保留原attempt且不再次查渠道", async () => {
  for (const unknown of [false, true]) {
    const m = memory(); m.state.failAudit = !unknown; m.state.commitUnknown = unknown; let sends = 0;
    await assert.rejects(refreshJoinpayAccountBySystem(m.pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, "system_request"), e => {
      assert.ok(e instanceof AccountObservationWriteError); assert.equal(e.code, unknown ? "ACCOUNT_OBSERVATION_COMMIT_UNKNOWN" : "ACCOUNT_OBSERVATION_WRITE_FAILED");
      assert(e.attemptId); return true;
    });
    assert.equal(sends, 1); assert.equal(m.state.rows.length, unknown ? 1 : 0);
  }
});
function memory() {
  const state = { integrated: true, rows: [] as Record<string, any>[], staged: [] as Record<string, any>[], audit: [] as unknown[][], stagedAudit: [] as unknown[][],
    queries: [] as string[], releases: 0, failAudit: false, missingReturning: false, commitUnknown: false, connectCount: 0, database: "synthetic_balance_test", runtimeUser: "synthetic_balance_r" };
  function safe(r: Record<string, any>) {
    return { attemptId: r.attemptId, operation: "AVAILABLE", evidenceLevel: r.evidenceLevel, decision: r.decision, reason: r.reason, requestedAt: r.requestedAt, receivedAt: r.receivedAt, recordedAt: r.recordedAt,
      responseComplete: r.responseComplete, httpStatus: r.httpStatus, statusCode: r.statusCode, errorCode: r.errorCode, amounts: r.decision === "SUCCESS" ? r.amounts : null };
  }
  const client = { release() { state.releases++; }, async query(sql: string, values: unknown[] = []) {
    state.queries.push(sql);
    if (sql.startsWith("SELECT to_regclass")) return { rows: [{ ready: state.integrated, database: state.database, runtime_user: state.runtimeUser }] };
    if (sql === "BEGIN") { state.staged = []; state.stagedAudit = []; return { rows: [] }; }
    if (sql === "COMMIT") { state.rows.push(...state.staged); state.audit.push(...state.stagedAudit); state.staged = []; state.stagedAudit = []; if (state.commitUnknown) throw Error("synthetic socket lost after commit"); return { rows: [] }; }
    if (sql === "ROLLBACK") { state.staged = []; state.stagedAudit = []; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO zzsh_order.joinpay_account_observation")) {
      const row = { attemptId: values[0], merchant: values[1], operation: values[2], profile: values[3], requestedAt: values[10], receivedAt: values[11], httpStatus: values[12], responseComplete: values[13], raw: values[16], rawSha: values[17], evidenceLevel: values[18], decision: values[19], reason: values[23], statusCode: values[24], errorCode: values[25], amounts: values[26] === null ? null : JSON.parse(String(values[26])), recordedAt: `2026-10-23T12:00:${String(state.rows.length).padStart(2, "0")}Z` };
      state.staged.push(row); return { rows: state.missingReturning ? [] : [{ recorded_at: row.recordedAt }] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (state.failAudit) throw Object.assign(Error("synthetic permission failure"), { code: "42501" }); state.stagedAudit.push(values); return { rows: [] }; }
    if (sql.startsWith("WITH scoped AS")) {
      assert.equal(sql.includes("raw_body"), false); assert.equal(sql.includes("key_version_ref"), false); assert.equal(sql.includes("profile_sha256"), false);
      const scoped = state.rows.filter(r => r.merchant === values[0] && r.operation === values[1]);
      const verified = scoped.filter(r => r.evidenceLevel === "PROVIDER_RESPONSE" && r.decision === "SUCCESS");
      return { rows: [{ latest: scoped.length ? safe(scoped.at(-1)!) : null, verified: verified.length ? safe(verified.at(-1)!) : null }] };
    }
    if (sql.startsWith("SELECT attempt_id")) { const found = state.rows.find(r => r.attemptId === values[0] && r.merchant === values[1] && r.operation === values[2]); return { rows: found ? [safe(found)] : [] }; }
    throw Error("UNEXPECTED_MODEL_SQL");
  } } as unknown as PoolClient;
  const pool = { async connect() { state.connectCount++; return client; } } as unknown as Pool;
  return { state, client, pool };
}

test("schema缺失先拒，0key/0fetch/0write；GET也是明确NOT_INTEGRATED", async () => {
  const m = memory(); m.state.integrated = false; let keyReads = 0, sends = 0;
  const r = await refreshJoinpayAccount(m.pool, profile(), { keyFor: () => { keyReads++; return KEY; }, fetch: async () => { sends++; return new Response(raw()); } }, actor);
  assert.equal(r.integration, "NOT_INTEGRATED"); assert.equal(keyReads, 0); assert.equal(sends, 0); assert.equal(m.state.rows.length, 0);
  assert.equal((await readJoinpayAccountSummary(m.client, "synthetic_account_store", "AVAILABLE")).integration, "NOT_INTEGRATED");
  assert.equal(m.state.queries.every(q => q.startsWith("SELECT")), true);
});
test("观察和audit同事务；本地摘要合成不升真实已验余额", async () => {
  const m = memory(); let sends = 0;
  const r = await refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, actor);
  assert.equal(r.integration, "INTEGRATED"); assert.equal(sends, 1); assert.equal(m.state.rows.length, 1); assert.equal(m.state.audit.length, 1);
  assert.equal(m.state.rows[0]?.rawSha, readJoinpayAccountObservation(r.result!).rawSha256);
  const start = m.state.queries.length, summary = await readJoinpayAccountSummary(m.client, "synthetic_account_store", "AVAILABLE");
  assert.equal(summary.knowledge, "UNKNOWN"); assert.equal(summary.latestVerifiedSnapshot, null); assert.equal(summary.latestObservation?.evidenceLevel, "SYNTHETIC_PROTOCOL"); assert.equal(summary.channelAsOf, null);
  assert.equal(m.state.queries.slice(start).every(q => q.startsWith("SELECT") || q.startsWith("WITH scoped")), true);
  const serialized = JSON.stringify(summary); for (const hidden of [KEY, USER, "hmac", "raw_body", "profileSha256", "keyVersionRef", "fictional"]) assert.equal(serialized.includes(hidden), false);
});
test("新坏响应不覆盖先前真实快照：仅投影模型，不是provider执行证据", async () => {
  const m = memory();
  await refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => new Response(raw()) }, actor);
  // 模拟已持久真实观察，仅验证reader谓词；不产生正式profile/渠道证据。
  m.state.rows[0]!.evidenceLevel = "PROVIDER_RESPONSE";
  await refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => new Response(raw().replace("12.00", "13.00")) }, actor);
  const summary = await readJoinpayAccountSummary(m.client, "synthetic_account_store", "AVAILABLE");
  assert.equal(summary.latestObservation?.decision, "UNKNOWN"); assert.equal(summary.latestVerifiedSnapshot?.decision, "SUCCESS");
  assert.equal(summary.latestVerifiedSnapshot?.attemptId, m.state.rows[0]!.attemptId); assert.equal(summary.knowledge, "KNOWN");
  assert.equal((await readJoinpayAccountSummary(m.client, "another_merchant", "AVAILABLE")).latestObservation, null);
  assert.equal((await readJoinpayAccountSummary(m.client, "synthetic_account_store", "COLLECTION")).latestObservation, null);
});
test("audit失败全回滚，保留原query结果/attempt不重发", async () => {
  const m = memory(); m.state.failAudit = true; let sends = 0;
  await assert.rejects(refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, actor), e => {
    assert.ok(e instanceof AccountObservationWriteError); assert.equal(e.code, "ACCOUNT_OBSERVATION_WRITE_FAILED"); assert.equal(e.originalResult.decision, "SUCCESS"); return true;
  });
  assert.equal(sends, 1); assert.equal(m.state.rows.length, 0); assert.equal(m.state.audit.length, 0); assert.equal(m.state.queries.includes("ROLLBACK"), true);
});
test("COMMIT响应丢失模型：原观察保留，独立只读原attempt恢复且不补发", async () => {
  const m = memory(); m.state.commitUnknown = true; let sends = 0, attempt = "";
  await assert.rejects(refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, actor), e => {
    assert.ok(e instanceof AccountObservationWriteError); assert.equal(e.code, "ACCOUNT_OBSERVATION_COMMIT_UNKNOWN"); attempt = e.attemptId;
    assert.equal(JSON.stringify(e).includes(KEY), false); assert.equal(JSON.stringify(e).includes(USER), false); return true;
  });
  assert.equal(m.state.rows.length, 1); assert.equal(m.state.audit.length, 1);
  const start = m.state.queries.length, recovered = await recoverJoinpayAccountObservation(m.client, "synthetic_account_store", "AVAILABLE", attempt);
  assert.equal(recovered.status, "FOUND"); assert.equal(sends, 1); assert.equal(m.state.queries.slice(start).every(q => q.startsWith("SELECT")), true);
  assert.equal((await recoverJoinpayAccountObservation(m.client, "synthetic_account_store", "AVAILABLE", "not_found")).status, "NOT_FOUND");
  assert.equal((await recoverJoinpayAccountObservation(m.client, "another_merchant", "AVAILABLE", attempt)).status, "NOT_FOUND");
});

test("INSERT缺回执仍是事务内写失败，回滚原观察而不误记COMMIT未知", async () => {
  const m = memory(); m.state.missingReturning = true; let sends = 0;
  await assert.rejects(refreshJoinpayAccount(m.pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, actor), error => {
    assert.ok(error instanceof AccountObservationWriteError); assert.equal(error.code, "ACCOUNT_OBSERVATION_WRITE_FAILED");
    assert.equal(error.originalResult.decision, "SUCCESS"); assert.ok(error.attemptId); return true;
  });
  assert.equal(sends, 1); assert.equal(m.state.rows.length, 0); assert.equal(m.state.audit.length, 0);
  assert.equal(m.state.queries.includes("ROLLBACK"), true); assert.equal(m.state.queries.includes("COMMIT"), false);
});
test("未经绑定profile/非法scope在SQL或网络之前拒绝", async () => {
  const m = memory();
  await assert.rejects(refreshJoinpayAccount(m.pool, { ...profile() }, { keyFor: () => KEY, fetch: async () => { throw Error("unexpected"); } }, actor), /NOT_BOUND/);
  await assert.rejects(readJoinpayAccountSummary(m.client, "bad scope", "AVAILABLE"), /SCOPE_INVALID/); assert.equal(m.state.queries.length, 0);
});
test("配置资源DB或runtime不符先拒，0key/0transport/0write", async () => {
  for (const field of ["database", "runtimeUser"] as const) {
    const m = memory(); m.state[field] = "wrong_resource"; let keys = 0, sends = 0;
    await assert.rejects(refreshJoinpayAccount(m.pool, profile(), { keyFor: () => { keys++; return KEY; }, fetch: async () => { sends++; return new Response(raw()); } }, actor), /RESOURCE_MISMATCH/);
    assert.equal(keys, 0); assert.equal(sends, 0); assert.equal(m.state.rows.length, 0); assert.equal(m.state.releases, 1);
  }
});
test("实际写client换资源也拒绝：保留原查询结果，不向错误资源INSERT", async () => {
  for (const field of ["database", "runtimeUser"] as const) {
    const m = memory(); let connections = 0, sends = 0;
    const pool = { async connect() { if (++connections === 2) m.state[field] = "wrong_write_resource"; return m.client; } } as unknown as Pool;
    await assert.rejects(refreshJoinpayAccount(pool, profile(), { keyFor: () => KEY, fetch: async () => { sends++; return new Response(raw()); } }, actor), e => {
      assert.ok(e instanceof AccountObservationWriteError); assert.equal(e.code, "ACCOUNT_OBSERVATION_WRITE_FAILED"); assert.equal(e.originalResult.decision, "SUCCESS"); return true;
    });
    assert.equal(sends, 1); assert.equal(m.state.rows.length, 0); assert.equal(m.state.audit.length, 0);
    assert.equal(m.state.queries.some(q => q.startsWith("INSERT")), false); assert.equal(m.state.queries.includes("ROLLBACK"), true);
  }
});
