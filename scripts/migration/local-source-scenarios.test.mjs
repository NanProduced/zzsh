import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSourceScenarios } from "./local-source-scenarios.mjs";
import { parseSourceCaptureLine, sourceJsonLine, readSourceRows, sourceAccountPlan } from "./local-source-adapter.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

test("hex capture framing retains multiline and control text as one valid JSONL record", () => {
  const raw = { id: "1", description: "原文\r\n二行\u2028三行\u0000", nullable: null, flag: "0", amount: "0001.2300" };
  const hex = Buffer.from(JSON.stringify(raw)).toString("hex").toUpperCase();
  const row = parseSourceCaptureLine(hex), stored = sourceJsonLine(row);
  assert.deepEqual(row, raw); assert.equal(stored.split("\n").length, 2); assert.deepEqual(JSON.parse(stored), raw);
  assert.deepEqual(parseSourceCaptureLine('{"_phase":"rollback-complete"}'), { _phase: "rollback-complete" });
  assert.throws(() => parseSourceCaptureLine("NOT_JSON"));
});
test("source JSONL reader uses LF and retains Unicode separators across read boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zzsh-source-lines-"));
  try {
    const file = join(dir, "source.jsonl"), rows = [{ id: "1", text: "A".repeat(65520) + "\u2028中文\u2029" }, { id: "2", nullable: null }];
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const actual = []; for await (const row of readSourceRows(file)) actual.push(row);
    assert.deepEqual(actual, rows); assert.equal(sourceJsonLine(rows[0]).includes("\u2028"), false);
    writeFileSync(file, JSON.stringify(rows[0]) + "\r\n\r\n" + JSON.stringify(rows[1]));
    const crlf = []; for await (const row of readSourceRows(file)) crlf.push(row);
    assert.deepEqual(crlf, rows);
  } finally { assert.equal(dirname(dir), tmpdir()); assert.ok(dir.split(/[\\/]/).at(-1).startsWith("zzsh-source-lines-")); rmSync(dir, { recursive: true }); }
});

const user = (id, extra = {}) => ({ id, inviter_id: "0", first_leader: "0", second_leader: "0", third_leader: "0", money: "0.00", earnings: "0.00", is_delete: "0", is_disable: "0", mobile: "present", ...extra });
const account = (id, user_id, extra = {}) => ({ id, user_id, status: "0", is_delete: "0", no: "old", title: "", is_demulan: "0", is_next_season_pass: null, ...extra });
test("selection closes independent funds, ancestors and owner history without expanding unrelated descendants", () => {
  const data = {
    users: [user("1", { first_leader: "3" }), user("2"), user("3"), user("4", { inviter_id: "3", earnings: "10.00" }), user("5", { earnings: "99.00" }), user("6"), user("7"), user("8"), user("9", { inviter_id: "3" })],
    accounts: [account("10", "1"), account("11", "1", { status: "3" }), account("12", "3"), account("13", "4", { status: "3", ratio_type: "fast" }), account("14", "4", { status: "6" }), account("15", "5", { status: "3", is_delete: "1" }), account("16", "7", { status: "5" }), account("17", "8", { pay_money: "5.00" })],
    orders: [{ id: "20", user_id: "2", sale_user_id: "1", accounts_id: "10" }],
    withdraws: [{ id: "30", user_id: "1" }, { id: "31", user_id: "5" }],
    earnings: [{ id: "40", user_id: "1" }, { id: "41", user_id: "1" }, { id: "42", user_id: "5" }],
    distributionOrders: [{ id: "50", user_id: "6", order_id: "20", order_type: "1", status: "2", is_delete: "0" }],
    pays: [{ id: "60", order_id: "20", order_type: "1" }, { id: "61", order_id: "16", order_type: "2", pay_is: "0" }, { id: "62", order_id: "11", order_type: "2" }],
  };
  const plan = selectSourceScenarios(data);
  assert.deepEqual([...plan.selected.users].sort(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual([...plan.selected.accounts].sort(), ["10", "11", "12", "13", "14", "15", "16", "17"]);
  assert.equal(plan.summary.coreOrderUsers, 2); assert.equal(plan.summary.necessaryRelatedUsers, 6);
  assert.deepEqual(plan.summary.domains.earnings, { source: 3, selected: 3, excluded: 0 });
  assert.equal(plan.summary.domains.pays.selected, 3); assert.equal(plan.includes("pays", data.pays[1]), true); assert.equal(plan.summary.scenes["untraded-listed"].selected, 2);
  assert.ok(plan.summary.missingScenes.includes("cancelled-user")); assert.equal(plan.missing.length, 0);
  assert.equal(plan.includes("withdraws", data.withdraws[1]), true);
});

test("selection reports missing original references and rejects duplicate IDs without inventing facts", () => {
  const data = { users: [user("1", { first_leader: "9" })], accounts: [account("10", "1")], orders: [{ id: "20", user_id: "8", sale_user_id: "1", accounts_id: "10" }] };
  const plan = selectSourceScenarios(data);
  assert.deepEqual([...plan.selected.users], ["1"]); assert.equal(plan.missing.length, 2);
  assert.ok(plan.missing.some(row => row.sourceId === "8")); assert.ok(plan.missing.some(row => row.sourceId === "9"));
  assert.throws(() => selectSourceScenarios({ ...data, users: [...data.users, data.users[0]] }), /SOURCE_ID_NOT_UNIQUE:users/);
});
test("missing legacy aliases stay null in bindings while source rows and digests preserve original null or empty values", () => {
  const seen = [], modules = { contentHash: { canonicalize: JSON.stringify }, planner: { listingSnapshot: row => { seen.push(row.no); return { snapshot: { resourceNo: null }, sourceUpdatedAt: null, missing: [] }; } } };
  for (const no of [null, ""]) {
    const raw = { id: "1", user_id: "2", game_id: "1", status: "3", is_delete: "0", no };
    const p = sourceAccountPlan(raw, new Map([["2", { userId: "real-owner", sourceDigest: "a".repeat(64) }]]), modules, "real-source", new Map([["1", "delta"]]));
    assert.equal(p.businessNo, null); assert.equal(raw.no, no); assert.equal(p.sourceDigest, createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  }
  assert.deepEqual(seen, [null, ""]);
});
test("funds supplement plan is exactly three domains, keeps source fields, and never extracts the payment URL", () => {
  const result = spawnSync(process.execPath, [new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--plan", "--finance-supplement-only"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); const p = JSON.parse(result.stdout);
  assert.deepEqual(p.domains, ["accounts", "earnings", "withdraws"]);
  assert.equal(p.dbConnections, 0); assert.equal(p.credentialReads, 0);
  for (const field of ["create_pay_time", "pay_way", "pay_url_present", "pay_url_sha256", "high_risk_owner"]) assert.ok(p.fieldsByDomain.accounts.includes(field));
  assert.equal(p.fieldsByDomain.accounts.includes("pay_url"), false);
  for (const field of ["update_time", "delete_time"]) assert.ok(p.fieldsByDomain.earnings.includes(field));
  for (const field of ["real_name", "account", "money_qr_code", "apply_remark", "pay_desc", "pay_search_result", "audit_remark", "transfer_voucher", "transfer_remark", "bank_card_no", "bank_name", "mobile", "admin_id"]) assert.ok(p.fieldsByDomain.withdraws.includes(field));
  assert.ok(p.required.includes("--base-source")); assert.ok(p.required.includes("--base-sha"));
});
test("refund attempt capture plans all eleven columns and typed record/order bindings without another population", () => {
  const result = spawnSync(process.execPath, [new URL("./capture-local-source.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--plan", "--refund-attempts-only"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); const p = JSON.parse(result.stdout);
  assert.deepEqual(p.domains, ["refunds", "refundLogs", "sourceParentBindings"]);
  assert.deepEqual(p.fieldsByDomain.refundLogs, ["id", "sn", "record_id", "user_id", "handle_id", "order_amount", "refund_amount", "refund_status", "refund_msg", "create_time", "update_time"]);
  for (const field of ["parent_record_id", "parent_source_entity", "parent_order_type", "parent_order_id", "order_source_entity", "resolved_order_id"]) assert.ok(p.fieldsByDomain.sourceParentBindings.includes(field));
  assert.equal(p.dbConnections, 0); assert.equal(p.credentialReads, 0);
});
test("holding cutoff offset and UTC normalize to the same instant accepted by formal admission", () => {
  const require = createRequire(import.meta.url), formal = require(new URL("../../apps/api/dist/src/supply/legacy-observation.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const proof = value => ({ schema: "legacy-skin-holdings-source-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", sourceExtractSha256: "a".repeat(64), sourceCutoff: value.endsWith("Z") ? value : new Date(value).toISOString(), targetBindingsSha256: "b".repeat(64), tokenRulesVersion: "offset-representation-proof", tokenRulesExtractSha256: "c".repeat(64), tokenRules: [], gameId: "game_delta", catalogRevision: "2108", rows: [{ legacyId: "1", accountId: "account_one", observationVersionId: "version_one", sourceDigest: "d".repeat(64), sourceUpdatedAtUtc: "2026-11-03T07:45:26.000Z", columns: { knife_skin: null, agent_skin: "", weapon_skin: null, gold_skin: "" } }] });
  const offset = proof("2026-11-03T15:47:05+08:00"), utc = proof("2026-11-03T07:47:05.000Z");
  assert.deepEqual(offset, utc);
  const bytes = JSON.stringify(offset); assert.ok(formal.prepareLegacySkinHoldingsAdmission(bytes, createHash("sha256").update(bytes).digest("hex")));
  const micros = proof("2026-11-03T07:47:05.123456Z"); assert.equal(micros.sourceCutoff, "2026-11-03T07:47:05.123456Z");
  const microBytes = JSON.stringify(micros); assert.ok(formal.prepareLegacySkinHoldingsAdmission(microBytes, createHash("sha256").update(microBytes).digest("hex")));
});
