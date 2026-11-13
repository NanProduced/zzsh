import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("../src", import.meta.url)) });
const { orderUpperResources } = await source.ssrLoadModule("/views/admin-order-upper-resources.ts");
const frozen = { source: "ORDER_VERSION", haff: { itemId: "haff-dynamic", code: "df_billable_haff", name: "哈夫币", quantity: "150000000", unit: "HAFF_BASE" }, materials: [
  { itemId: "bullet-dynamic", code: "df_billable_level6_bullet", name: "6级子弹", quantity: "120", unit: "ROUND" },
  { itemId: "awm-dynamic", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "50", unit: "ROUND" },
] };
const oldVersion = { id: "old", versionHash: "a", computation: { ok: true, consumed: { haff: "1", items: [{ itemId: "awm-dynamic", consumed: "40" }] } } };
const posted = { id: "posted", versionHash: "b", computation: { ok: true, consumed: { haff: "75000000", items: [{ itemId: "bullet-dynamic", consumed: "0" }, { itemId: "awm-dynamic", consumed: "0" }] } } };
test("实际消耗只认过账版本和真实 itemId，零值保留并按 60 发显示", () => {
  const result = orderUpperResources({ origin: "NATIVE", frozen, originalCompleted: false, settlement: { posting: { settlementVersionId: "posted", versionHash: "b" }, versions: [oldVersion, posted] } });
  assert.equal(result.recordedLabel, "下单时数量");
  assert.equal(result.rows[0].consumed, "75 M 哈夫币");
  assert.equal(result.rows[1].recorded, "2组（120发）");
  assert.equal(result.rows[1].consumed, "0组（0发）");
  assert.equal(result.rows[2].consumed, "0发");
});
test("无过账、版本哈希不符、同 itemId 重复时不伪造消耗", () => {
  for (const settlement of [{ versions: [posted] }, { posting: { settlementVersionId: "posted", versionHash: "wrong" }, versions: [posted] }]) {
    assert.ok(orderUpperResources({ origin: "NATIVE", frozen, settlement, originalCompleted: false }).rows.every(row => row.consumed === "—"));
  }
  const duplicate = { ...posted, computation: { ok: true, consumed: { haff: "0", items: [{ itemId: "awm-dynamic", consumed: "0" }, { itemId: "awm-dynamic", consumed: "2" }] } } };
  assert.equal(orderUpperResources({ origin: "NATIVE", frozen, settlement: { posting: { settlementVersionId: "posted", versionHash: "b" }, versions: [duplicate] }, originalCompleted: false }).rows[2].consumed, "—");
});
test("旧完成单展示原记录，账号数量是迁入时参考；未完单不推测消耗", () => {
  const original = { state: "KNOWN", items: [{ code: "df_billable_haff", name: "哈夫币", quantity: "365.00" }, { code: "df_billable_level6_bullet", name: "6级子弹", quantity: "3" }] };
  const reference = { ...frozen, source: "LEGACY_ACCOUNT_SNAPSHOT", haff: { ...frozen.haff, code: "legacy-display:haff_base" }, materials: [...frozen.materials, { code: "legacy_insurance_day", name: "顶级保险体验天数", quantity: "0", unit: "DAY" }] };
  const completed = orderUpperResources({ origin: "LEGACY", frozen: reference, original, originalCompleted: true });
  assert.equal(completed.recordedLabel, "迁入时账号参考");
  assert.equal(completed.consumedLabel, "旧站记录消耗");
  assert.equal(completed.rows[0].consumed, "365.00 M 哈夫币");
  assert.equal(completed.rows[1].consumed, "3组（180发）");
  assert.equal(orderUpperResources({ origin: "LEGACY", frozen: { ...reference, source: "ACCOUNT_PUBLIC_VERSION" }, originalCompleted: false }).recordedLabel, "公开账号资料参考");
  const pending = orderUpperResources({ origin: "LEGACY", frozen: reference, original, originalCompleted: false });
  assert.ok(pending.rows.every(row => row.consumed === "—"));
  assert.equal(orderUpperResources({ origin: "LEGACY", original, originalCompleted: true }).rows.length, 2);
});
test("旧单有依据的待确认申报和已确认记录分开", () => {
  const legacy = { evidenceId: "evidence_1", stage: "8", quantities: { expendHaff: "12.50", bullet: "2", awm: "0" } };
  const pending = orderUpperResources({ origin: "LEGACY", frozen: { ...frozen, source: "LEGACY_ACCOUNT_SNAPSHOT" }, legacy, originalCompleted: false });
  assert.equal(pending.consumedLabel, "申报消耗（待确认）");
  assert.equal(pending.rows[0].consumed, "12.50 M 哈夫币");
  assert.equal(pending.rows[1].consumed, "2组（120发）");
  const finished = orderUpperResources({ origin: "LEGACY", frozen, legacy: { ...legacy, stage: "4" }, originalCompleted: false });
  assert.equal(finished.consumedLabel, "续办记录消耗");
});
