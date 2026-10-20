import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createHash } from "node:crypto";

const tiers = ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"];
function fixture({ withPriceDraft = false } = {}) {
  const policy = { schema: "funding-policy-v1", policyVersion: "1", recommendation: { schema: "deposit-recommendation-v1", algorithm: "delta-deposit-owner-declared-v1", version: "1", currency: "CNY", unit: "cent", inputSpec: { schema: "x" }, parameters: { safeBoxWeightsByCode: { "box-a": "5000" }, vitalityAtLeast7Cents: "5000", bearAtLeast7Cents: "5000", diveAtLeast3Cents: "5000", skinGroupById: {}, skinWeights: { LEGACY_GOLD: { firstCents: "5000", subsequentCents: "2500" } }, rounding: { mode: "CEIL", unitCents: "5000", zeroFallbackCents: "5000" }, upperLimitCents: "120000" } }, ownerDepositRules: { schema: "owner-deposit-rule-v1", currency: "CNY", unit: "cent", normal: { minCents: "1", zeroAllowed: false }, fullPayoutSelected: { minCents: "30000", zeroAllowed: false }, capCents: "120000" }, guaranteeRequirement: { schema: "g", version: "1", scope: "GAME_ACCOUNT", currency: "CNY", unit: "cent", mode: "NOT_REQUIRED", requiredCents: "0" }, proofValidity: { schema: "p", satisfiedMode: "FIXED_DAYS", satisfiedDays: "30" }, vipWaiver: false, svipWaiver: false, fullPayoutPolicyRef: "ref", fullPayoutPolicyVersion: "1", disclosureVersion: "1" };
  const haffRule = { schema: "haff-ratio-v2", baseBySafeBox: { "box-a": "50" }, vitalityDeltaByLevel: { "6": "0" }, bearDeltaByLevel: { "6": "0" }, dailyDeltaByTermOption: { d10: "0" }, compatibility: { ordinary: { spreadDelta: "8", discounts: { STANDARD: "0", VIP: "1" } }, fast: { spreadDelta: "12", discounts: {} }, modes: { ordinary: { enabled: true }, custom: { enabled: true, min: { base: "C", value: "-3" }, max: { base: "C", value: "-1" } }, fast: { enabled: true, min: { base: "C", value: "6" }, max: { base: "ABSOLUTE", value: "99" } } } } };
  const priceLines = tiers.flatMap((customerTier, i) => [
    { priceVersionId: "p1", customerTier, itemId: "haff", pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null },
    { priceVersionId: "p1", customerTier, itemId: "piece", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: ["2", "1.8", "1.6", "1.9"][i], ownerUnitAmount: "1.5" },
  ]);
  return {
    game: { id: "g1", name: "三角洲行动", code: "delta" },
    release: { id: "r1", gameId: "g1", priceVersionId: "p1", termVersionId: "t1", agreementVersionId: "a1", generation: "1", activatedAt: "2026-10-09T02:39:00Z" },
    priceVersions: [...(withPriceDraft ? [{ id: "pd", gameId: "g1", mode: "SPREAD", status: "DRAFT", revision: "3", haffRule: null, roundingPolicy: "HALF_UP_CENT_V1", commissionRate: null, compensationPolicyRef: null, fundingPolicy: null, createdAt: "", sealedAt: null }] : []),
      { id: "p1", gameId: "g1", mode: "SPREAD", status: "SEALED", revision: "2", haffRule, roundingPolicy: "HALF_UP_CENT_V1", commissionRate: null, compensationPolicyRef: null, fundingPolicy: policy, createdAt: "", sealedAt: "2026-10-09T02:00:00Z" }],
    priceLines,
    termVersions: [{ id: "t1", gameId: "g1", status: "SEALED", revision: "1", createdAt: "", sealedAt: "x" }],
    termOptions: [{ versionId: "t1", code: "d10", name: "10M/天", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }],
    agreementVersions: [], items: [{ id: "haff", name: "哈夫币", unit: "HAFF_BASE", enabled: true }, { id: "piece", name: "件", unit: "PIECE", enabled: true }],
  };
}

test("rules model: complete changes, honest estimates, original request fingerprints", async t => {
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const edit = await vite.ssrLoadModule("/src/views/supply-rules/rules-edit.ts");
    const model = await vite.ssrLoadModule("/src/views/supply-rules/rules-model.ts");
    const trial = await vite.ssrLoadModule("/src/views/supply-rules/rules-trial-model.ts");
    const write = await vite.ssrLoadModule("/src/views/supply-rules/rules-write.ts");
    const next = () => { const rules = fixture(); rules.priceVersions.push({ ...structuredClone(rules.priceVersions[0]), id: "p2" }); rules.priceLines.push(...rules.priceLines.map(line => ({ ...line, priceVersionId: "p2" }))); return rules; };
    const account = () => ({ haffM: "100", box: "box-a", vit: "6", bear: "6", dive: "0", term: "d10", items: {} });
    await t.test("edit keeps a local baseline and removes the unsafe unused write sequencer", () => {
      const bl = edit.baseline(fixture()); assert.equal(bl.values["dep.cap"], "1200"); assert.equal(bl.values["term.d10.daily"], "10");
      assert.equal(bl.fields.some(field => field.key.startsWith("dep.skin.")), false, "original v1 skin groups have no editable fields");
      assert.equal(Object.keys(bl.values).some(key => key.startsWith("dep.skin.")), false, "original v1 skin amounts are absent from edit state");
      assert.equal(bl.values["dep.vit7"], "50", "non-skin deposit fields remain editable");
      assert.equal(edit.submitChanges, undefined); assert.equal(edit.buildPriceBody, undefined);
      assert.equal(edit.validate(bl.fields, { ...bl.values, "item.piece.buyer": "1.00000001" })["item.piece.buyer"], undefined);
      assert.ok(edit.validate(bl.fields, { ...bl.values, "dep.cap": "200" })["dep.cap"]);
      assert.ok(edit.validate(bl.fields, { ...bl.values, "term.d10.daily": "9".repeat(400) })["term.d10.daily"]);
    });
    for (const [label, change, pattern] of [
      ["vitality only", p => { p.haffRule.vitalityDeltaByLevel[6] = "-1"; }, /体力调整/],
      ["bear only", p => { p.haffRule.bearDeltaByLevel[6] = "2"; }, /负重调整/],
      ["daily only", p => { p.haffRule.dailyDeltaByTermOption.d10 = "3"; }, /每日消耗调整/],
      ["mode bounds only", p => { p.haffRule.compatibility.modes.fast.max.value = "80"; }, /快速.*上限/],
      ["mode enable only", p => { p.haffRule.compatibility.modes.ordinary.enabled = false; }, /启用状态/],
      ["ordinary discount only", p => { p.haffRule.compatibility.ordinary.discounts.STANDARD = "1"; }, /档位调整.*普通/],
      ["pricing mode only", p => { p.mode = "PERCENT"; p.commissionRate = "0.2"; }, /计价方式/],
      ["rounding only", p => { p.roundingPolicy = "OTHER"; }, /金额取整方式/],
      ["future policy field", p => { p.fundingPolicy.futureConstraint = { threshold: "3" }; }, /futureConstraint/],
    ]) await t.test("version diff detects " + label, () => { const rules = next(); change(rules.priceVersions[1]); assert.ok(model.priceDiff(rules, "p1", "p2").some(row => pattern.test(row.label))); });
    await t.test("funding cap plus weights plus guarantees are all listed", () => {
      const rules = next(), policy = rules.priceVersions[1].fundingPolicy;
      policy.recommendation.parameters.upperLimitCents = "200000"; policy.ownerDepositRules.capCents = "200000"; policy.recommendation.parameters.safeBoxWeightsByCode["box-a"] = "6000"; policy.guaranteeRequirement.requiredCents = "10000";
      const labels = model.priceDiff(rules, "p1", "p2").map(row => row.label).join("|");
      assert.match(labels, /推荐押金上限/); assert.match(labels, /保险箱加价/); assert.match(labels, /账号押金约束.*押金上限/); assert.match(labels, /号主保证金.*要求金额/);
    });
    await t.test("all tiers, quantity and sub-cent unit amounts are compared without display rounding", () => {
      assert.equal(model.unitYuan("0.00000001"), "¥0.00000001"); assert.equal(model.unitYuan("0"), "¥0.00");
      assert.equal(model.unitYuan("99999999999999.00000001"), "¥99,999,999,999,999.00000001");
      assert.equal(model.spread("99999999999999.00000002", "99999999999999.00000001"), "¥0.00000001");
      const rules = next(), line = rules.priceLines.find(line => line.priceVersionId === "p2" && line.itemId === "piece" && line.customerTier === "VIP");
      line.buyerUnitAmount = "1.80000001"; line.unitQuantity = "60";
      const rows = model.priceDiff(rules, "p1", "p2"); assert.ok(rows.some(row => /VIP.*租客单价/.test(row.label) && row.after === "1.80000001")); assert.ok(rows.some(row => /单位数量/.test(row.label)));
      rules.priceLines.find(line => line.priceVersionId === "p1" && line.itemId === "piece" && line.customerTier === "STANDARD").buyerUnitAmount = "99999999999999.00000001"; assert.equal(edit.baseline(rules).values["item.piece.buyer"], "99999999999999.00000001");
      rules.priceLines = rules.priceLines.filter(line => !(line.priceVersionId === "p2" && line.customerTier === "SVIP"));
      assert.ok(model.priceDiff(rules, "p1", "p2").some(row => /SVIP/.test(row.label) && row.after === "未提供"));
    });
    await t.test("object key order is harmless, empty vs missing is not silently equal", () => {
      const rules = next(); rules.priceVersions[1].haffRule.baseBySafeBox = Object.fromEntries(Object.entries(rules.priceVersions[1].haffRule.baseBySafeBox).reverse()); assert.deepEqual(model.priceDiff(rules, "p1", "p2"), []);
      rules.priceVersions[0].fundingPolicy = {}; rules.priceVersions[1].fundingPolicy = null; assert.ok(model.priceDiff(rules, "p1", "p2").some(row => row.group === "押金规则"));
    });
    await t.test("term identity and protocol body are part of confirmation even when human labels match", () => {
      const rules = fixture(); rules.termVersions.push({ ...rules.termVersions[0], id: "t2" }); rules.termOptions.push({ ...rules.termOptions[0], versionId: "t2", code: "new-code" }); assert.ok(model.termDiff(rules, "t1", "t2").length);
      rules.agreementVersions = [{ id: "a1", title: "同名协议", body: "甲", digest: "a" }, { id: "a2", title: "同名协议", body: "乙", digest: "b" }]; assert.ok(model.agreementDiff(rules, "a1", "a2").some(row => row.label === "正文" && row.before === "甲" && row.after === "乙"));
    });
    await t.test("invalid and empty quantities cannot be interpreted as zero or removed", () => {
      const rules = fixture(), a = account(); assert.equal(trial.validateTrialAccount(rules, a).ready, true);
      assert.equal(trial.validateTrialAccount(rules, { ...a, haffM: "" }).ready, false); assert.equal(trial.validateTrialAccount(rules, { ...a, items: { piece: "-1" } }).ready, false); assert.equal(trial.validateTrialAccount(rules, { ...a, items: { piece: "1.5" } }).ready, false);
      const zero = trial.validateTrialAccount(rules, { ...a, items: { piece: "0" } }); assert.equal(zero.ready, true); assert.ok(zero.inventory.some(line => line.itemId === "piece" && line.quantity === "0"));
      assert.equal(trial.validateTrialAccount(rules, { ...a, haffM: "1.000001" }).rawHaff, "1000001");
    });
    await t.test("ordinary estimate uses positive and negative deltas plus STANDARD discount", () => {
      const rules = fixture(), haff = rules.priceVersions[0].haffRule;
      haff.vitalityDeltaByLevel[6] = "-1"; haff.bearDeltaByLevel[6] = "2"; haff.dailyDeltaByTermOption.d10 = "3"; haff.compatibility.ordinary.discounts.STANDARD = "1";
      const estimate = trial.trialEstimate(rules, edit.baseline(rules).values, account()); assert.equal(estimate.ratio, 54); assert.equal(estimate.rows[0].owner, 185.19); assert.equal(estimate.rows[0].tenant, 212.77);
    });
    await t.test("missing selected deltas, prices, units and deposit weights stay unavailable", () => {
      const rules = fixture(), a = account(), values = edit.baseline(rules).values;
      assert.equal(trial.trialEstimate(rules, { ...values, "haff.spread.ordinary": "" }, a).rows, null);
      assert.equal(trial.trialEstimate(rules, { ...values, "haff.vit.6": "" }, a).rows, null);
      assert.equal(trial.trialEstimate(rules, { ...values, "item.piece.buyer": "" }, { ...a, items: { piece: "1" } }).rows, null);
      rules.priceLines.find(line => line.itemId === "piece" && line.customerTier === "STANDARD").unitQuantity = null;
      assert.equal(trial.trialEstimate(rules, values, { ...a, items: { piece: "1" } }).rows, null);
      rules.priceVersions[0].haffRule.vitalityDeltaByLevel[7] = "0";
      assert.equal(trial.trialDeposit(rules, { ...values, "dep.vit7": "" }, { ...a, vit: "7" }), null);
      assert.equal(trial.trialDeposit(rules, { ...values, "dep.box.box-a": "" }, a), null);
    });
    await t.test("bounds use complete window size for drag and resize", () => {
      assert.deepEqual(trial.clampTrialPosition({ x: 1000, y: 1000 }, { width: 390, height: 844 }, { width: 374, height: 600 }), { x: 8, y: 236 });
      assert.deepEqual(trial.clampTrialPosition({ x: 1000, y: 1000 }, { width: 1440, height: 900 }, { width: 980, height: 700 }), { x: 452, y: 192 });
    });
    await t.test("write fingerprint matches the server operation/target/body contract", async () => {
      const command = write.draftCommand("g1", "price", "create", { gameId: "g1", mode: "SPREAD" });
      const fp = await write.rulesFingerprint(command.operation, command.resourceId, command.body);
      assert.equal(fp, createHash("sha256").update(JSON.stringify([command.operation, null, command.body])).digest("hex"));
      const record = { ...command, schema: 1, adminId: "admin-a", key: "idem_original", fingerprint: fp };
      assert.deepEqual(write.parsePendingRulesWrite(JSON.stringify(record), "admin-a"), record); assert.throws(() => write.parsePendingRulesWrite(JSON.stringify(record), "admin-b")); assert.throws(() => write.parsePendingRulesWrite(JSON.stringify({ ...record, path: "/supply/releases" }), "admin-a"));
      assert.throws(() => write.parsePendingRulesWrite(JSON.stringify({ ...record, body: { ...record.body, gameId: "g2" } }), "admin-a"));
      const release = { ...record, operation: "supply.rules.release.activate", resourceId: "g1", path: "/supply/releases", body: { gameId: "g1", priceVersionId: "p1", termVersionId: "t1", agreementVersionId: "a1", expectedGeneration: "1" } }; assert.ok(write.parsePendingRulesWrite(JSON.stringify(release), "admin-a")); assert.throws(() => write.parsePendingRulesWrite(JSON.stringify({ ...release, resourceId: "g2" }), "admin-a"));
    });
    await t.test("F3 a missing funding policy produces no deposit fields instead of invented defaults", () => {
      const noPolicy = fixture();
      noPolicy.priceVersions[0].fundingPolicy = null;
      const bl = edit.baseline(noPolicy);
      assert.deepEqual(bl.fields.filter(f => f.group === "押金规则"), [], "no policy means no editable deposit baseline");
      assert.ok(!Object.keys(bl.values).some(k => k.startsWith("dep.")), JSON.stringify(Object.keys(bl.values)));
      assert.equal(trial.trialDeposit(noPolicy, bl.values, { haffM: "100", box: "box-a", vit: "6", bear: "6", dive: "0", term: "d10", items: {} }), null);
      noPolicy.priceVersions[0].fundingPolicy = structuredClone(fixture().priceVersions[0].fundingPolicy);
      const withPolicy = edit.baseline(noPolicy);
      assert.equal(withPolicy.values["dep.cap"], "1200", "the real policy cap still reads through");
      assert.equal(Object.keys(withPolicy.values).includes("dep.box.box-2x3"), false, "boxes absent from the policy are not invented");
      assert.equal(withPolicy.fields.some(f => f.key === "dep.box.box-a"), true);
    });
    await t.test("F3 an item without a price line is never billed at an assumed unit of one", () => {
      const rules = fixture();
      rules.priceLines = rules.priceLines.filter(x => x.itemId !== 'piece');
      rules.items.find(x => x.id === 'piece').unit = 'ROUND';
      rules.items.find(x => x.id === 'piece').name = '子弹';
      const { values } = edit.baseline(rules);
      values['item.piece.buyer'] = '2'; values['item.piece.owner'] = '1.5';
      const account = { haffM: '100', box: 'box-a', vit: '6', bear: '6', dive: '0', term: 'd10', items: { piece: '60' } };
      assert.equal(trial.validateTrialAccount(rules, account).ready, true, 'the account itself is complete');
      const missing = trial.trialEstimate(rules, values, account);
      assert.equal(missing.rows, null, 'no contracted billing quantity means no simulated amount');
      assert.match(missing.message, /计费单位行/, missing.message);
      assert.ok(!JSON.stringify(missing).includes('120'), 'the old 60 × 2 yuan total must not appear');
      rules.priceLines.push({ priceVersionId: 'p1', customerTier: 'STANDARD', itemId: 'piece', pricingKind: 'FIXED_UNIT', unitQuantity: '60', buyerUnitAmount: '2', ownerUnitAmount: '1.5' });
      const configured = trial.trialEstimate(rules, values, account).rows.find(x => x.key === 'piece');
      assert.deepEqual([configured.tenant, configured.owner], [2, 1.5], '60 发一组按每组单价计一次');
    });
    await t.test("F3 an incomplete v1 rule never becomes a synthetic v2", () => {
      for (const rule of [
        { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "50" } },
        { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "50" }, spreadDelta: "10", options: { standard: { delta: "0" } } },
        { schema: "haff-ratio-v1" },
      ]) assert.equal(model.asHaffV2(rule), null, `v1 ${JSON.stringify(rule)} stays unsupported`);
      assert.equal(model.asHaffV2({ schema: "haff-ratio-v2" }), null, "an incomplete v2 also stays unadapted");
      const v1 = fixture();
      v1.priceVersions[0].haffRule = { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "50" }, spreadDelta: "10", options: { standard: { delta: "0" } } };
      const account = { haffM: "100", box: "box-a", vit: "6", bear: "6", dive: "0", term: "d10", items: {} };
      const checked = trial.validateTrialAccount(v1, account);
      assert.equal(checked.ready, false);
      assert.match(checked.errors.haff ?? "", /暂不支持/, "the reason names the unsupported rule format, not a missing safe box");
      assert.equal(trial.trialEstimate(v1, edit.baseline(v1).values, account).rows, null);
    });
  } finally { await vite.close(); }
});
