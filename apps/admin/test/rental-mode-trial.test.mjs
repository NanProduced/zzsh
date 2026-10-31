import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingMatches, canonicalB, draftTrialRequest } from "../src/views/supply-rules/rental-mode-trial.ts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as trialModule from "../src/views/supply-rules/rental-mode-trial.ts";
import * as rulesModel from "../src/views/supply-rules/rules-model.ts";
import * as rentalModes from "../src/views/supply-rules/rental-modes.ts";

const haff = (fast) => ({ schema: "haff-ratio-v2", baseBySafeBox: { S6: "10" }, vitalityDeltaByLevel: { "7": "0" }, bearDeltaByLevel: { "7": "0" }, dailyDeltaByTermOption: {}, compatibility: { ordinary: { spreadDelta: "4", discounts: {} }, fast: { spreadDelta: "12", discounts: {} }, modes: { ordinary: { enabled: true }, custom: { enabled: false }, fast } } });
const rules = { release: { termVersionId: "term_1", priceVersionId: "price_cur" }, termOptions: [{ versionId: "term_1", code: "D3" }, { versionId: "old", code: "D7" }], items: [{ id: "item_haff", enabled: true, unit: "HAFF_BASE" }] };
const draft = (fast = { enabled: true, min: { base: "C", value: "6" } }) => ({ id: "price_draft", status: "DRAFT", revision: "4", haffRule: haff(fast) });
const input = { ownerRatioB: "18", haffM: "100", box: "S6", vit: "7", bear: "7", term: "D3" };

test("请求绑定草稿 id/revision、fast 模式、B、库存与当前消耗档版本", () => {
  const r = draftTrialRequest(rules, draft(), input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { priceVersionId: "price_draft", expectedRevision: "4", termVersionId: "term_1", conditions: { safeBoxCode: "S6", vitLevel: 7, bearLevel: 7, termOptionCode: "D3", rentalPricing: { rentalMode: "fast", ownerRatioB: "18" } }, inventory: [{ itemId: "item_haff", quantity: "100000000" }] });
  assert.notEqual(draftTrialRequest(rules, draft(), { ...input, ownerRatioB: "17" }).signature, r.signature, "改 B 即失效");
  assert.notEqual(draftTrialRequest(rules, { ...draft(), revision: "5" }, input).signature, r.signature, "改修订即失效");
});

test("拒绝：非草稿、未启用极速、B 非法、旧消耗档版本", () => {
  assert.equal(draftTrialRequest(rules, { ...draft(), status: "PUBLISHED" }, input).ok, false);
  assert.ok(draftTrialRequest(rules, draft({ enabled: false }), input).errors.version);
  for (const b of ["", "0", "-1", "1.123456789", "abc"]) assert.ok(draftTrialRequest(rules, draft(), { ...input, ownerRatioB: b }).errors.ownerRatioB, b);
  assert.ok(draftTrialRequest(rules, draft(), { ...input, term: "D7" }).errors.term);
});

test("回执 binding 逐项比对；B 按十进制规范形等价", () => {
  const { expected } = draftTrialRequest(rules, draft(), input);
  assert.ok(bindingMatches({ ...expected, ownerRatioB: "18.00000000" }, expected));
  assert.equal(bindingMatches({ ...expected, priceVersionRevision: "3" }, expected), false);
  assert.equal(bindingMatches({ ...expected, rentalMode: "ordinary" }, expected), false);
  assert.equal(bindingMatches({ ...expected, ownerRatioB: "17" }, expected), false);
  assert.equal(bindingMatches({ ...expected, inventory: [] }, expected), false);
  assert.equal(bindingMatches(undefined, expected), false);
});
test("B 十进制精确比较：仅尾零等价，不经 Number", () => {
  const { expected } = draftTrialRequest(rules, draft(), input);
  const big = { ...expected, ownerRatioB: "100000000.00000001" };
  assert.equal(bindingMatches({ ...big, ownerRatioB: "100000000.00000002" }, big), false, "Number 会把二者视为相等");
  assert.equal(bindingMatches({ ...big }, big), true);
  const b63 = { ...expected, ownerRatioB: "63" };
  assert.equal(bindingMatches({ ...b63, ownerRatioB: "63.00000000" }, b63), true);
  assert.equal(bindingMatches({ ...b63, ownerRatioB: "63.0000001" }, b63), false);
  for (const bad of [null, undefined, 63, "", "063", "6e1", " 63"]) assert.equal(bindingMatches({ ...b63, ownerRatioB: bad }, b63), false, String(bad));
  assert.equal(canonicalB("18.50"), "18.5");
  assert.equal(canonicalB("0.000"), "0");
});

test("试算面板 SSR：真实 quotePreview 响应 → C/B/租客比例/P 与服务端汇总金额", () => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript"), React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const fx = JSON.parse(readFileSync(new URL("./fixtures/fast-trial-quote-preview.json", import.meta.url), "utf8"));
  const r2 = { release: { termVersionId: "term_synthetic" }, termOptions: [{ versionId: "term_synthetic", code: "daily-10m" }], items: [{ id: "haff", enabled: true, unit: "HAFF_BASE" }] };
  const version = { id: "price_synthetic", status: "DRAFT", revision: "4", haffRule: fx.haffRule };
  const inp = { ownerRatioB: "63", haffM: "100", box: "box-a", vit: "6", bear: "6", term: "daily-10m" };
  const req = draftTrialRequest(r2, version, inp);
  assert.equal(req.ok, true);
  assert.deepEqual(req.body, fx.request, "夹具请求即面板实际请求");
  const render = (result) => {
    let n = 0;
    const mocks = { react: { ...React, useEffect() {}, useRef: () => ({ current: 0 }), useState: () => [n++ === 0 ? inp : { signature: req.signature, status: "ok", result }, () => {}] }, "../../api": { adminRequest() { throw Error("No network"); }, friendlyError: String }, "../../components/ui/button": { Button: ({ children }) => React.createElement("button", null, children) }, "../../components/ui/input": { Input: () => React.createElement("input") }, "../../components/supply/supply-select": { SupplySelect: () => React.createElement("select") }, "./rental-mode-trial": trialModule, "./rules-model": rulesModel, "./rental-modes": rentalModes };
    const src = readFileSync(new URL("../src/views/supply-rules/rental-mode-trial-panel.tsx", import.meta.url), "utf8");
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    new Function("require", "module", "exports", out)((name) => mocks[name] ?? require(name), mod, mod.exports);
    return renderToStaticMarkup(React.createElement(mod.exports.DraftFastTrial, { rules: r2, version, dirty: false })).replace(/<!--.*?-->/g, "");
  };
  const html = render(fx.response);
  assert.match(html, /基础比例 C 57 万哈夫币\/元/);
  assert.match(html, /号主比例 B 63 万哈夫币\/元/);
  assert.match(html, /租客比例 51 万哈夫币\/元/);
  assert.match(html, /价差 P 12 万哈夫币\/元/);
  assert.match(html, new RegExp(`租客资源金额 ¥${fx.response.quote.resourceTotal.amount.replace(".", "\\.")}`));
  assert.match(html, new RegExp(`号主金额（扣费前） ¥${fx.response.quote.ownerTotal.amount.replace(".", "\\.")}`));
  assert.match(html, /不含会员折扣/);
  assert.doesNotMatch(html, /租客比例 未返回/);
  const missing = structuredClone(fx.response);
  delete missing.quote.pricingInputs.denominators; delete missing.quote.ownerTotal; missing.quote.pricingInputs.spreadDelta = null;
  const h2 = render(missing);
  assert.match(h2, /租客比例 未返回/); assert.match(h2, /价差 P 未返回/); assert.match(h2, /号主金额（扣费前） 未返回/);
});