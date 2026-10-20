import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { fundingPolicyFixture } from "../../api/test/funding-authority-fixtures.ts";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

test("skin deposit editor saves unconfigured drafts, keeps zero explicit, and blocks seal and duplicate unknown writes", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101/supply/rules" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client"), source = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const { SkinDepositPolicyEditor: Editor } = await source.ssrLoadModule("/src/views/supply-rules/skin-deposit-policy-editor.tsx");
  const policy = fundingPolicyFixture("NOT_REQUIRED"), writes = [], dirty = [];
  let rules = { game: { id: "game", catalogRevision: "1235" }, release: { priceVersionId: "current" }, priceVersions: [
    { id: "draft", status: "DRAFT", revision: "1", fundingPolicy: null, mode: "SPREAD", commissionRate: null, haffRule: null, roundingPolicy: "HALF_UP_CENT_V1" },
    { id: "current", status: "SEALED", revision: "1", fundingPolicy: policy, mode: "SPREAD", commissionRate: null, haffRule: null, roundingPolicy: "HALF_UP_CENT_V1" },
  ], priceLines: [{ priceVersionId: "draft", itemId: "item", customerTier: "STANDARD", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "1", ownerUnitAmount: "1" }], depositCatalog: { catalogRevision: "1235", rarities: [{ code: "q", name: "合成品质", enabled: true }], skins: [{ id: "skin_fixture", name: "合成词条", ownerKind: "AGENT", rarityCode: "q" }] } };
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  let unknown = false;
  const changed = value => dirty.push(value);
  const command = { locked: false, write: async operation => {
    writes.push(operation);
    if (unknown) { command.locked = true; render(); return undefined; }
    rules = structuredClone(rules);
    if (operation.operation.endsWith("update")) { rules.priceVersions[0].fundingPolicy = operation.body.fundingPolicy; rules.priceVersions[0].revision = String(Number(rules.priceVersions[0].revision) + 1); }
    if (operation.operation.endsWith("seal")) rules.priceVersions[0].status = "SEALED";
    render(); return { receipt: { id: "draft", revision: rules.priceVersions[0].revision }, fresh: rules };
  } };
  const render = () => root.render(createElement(Editor, { rules, command, onDirtyChange: changed }));
  const button = text => [...document.querySelectorAll("button")].find(node => node.textContent.trim() === text);
  const click = async text => { const node = button(text); assert.ok(node, text); await act(async () => node.click()); };
  const fill = async (label, value) => act(async () => {
    const input = document.querySelector(`[aria-label="${label}"]`); assert.ok(input, label);
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true })); input.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  try {
    await act(async () => render());
    assert.equal(document.querySelector('[aria-label="皮肤推荐押金配置"]').id, "skin-deposit-policy-game", "rules overview has a stable configuration anchor");
    assert.match(document.body.textContent, /留空为待配置/);
    assert.ok(button("封存此价格版本").disabled);
    await fill("本次资金政策版本", "synthetic-v2");
    await click("保存皮肤押金草稿");
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].body).sort(), ["expectedRevision", "fundingPolicy"]);
    assert.ok(writes[0].body.fundingPolicy.recommendation.parameters.skinRules.every(row => row.firstCents === null && row.subsequentCents === null));
    assert.ok(button("封存此价格版本").disabled);
    for (let index = 1; index <= 3; index++) { await fill(`第${index}行首件加价`, "0"); await fill(`第${index}行后续每件加价`, "0"); }
    await click("保存皮肤押金草稿");
    assert.ok(writes[1].body.fundingPolicy.recommendation.parameters.skinRules.every(row => row.firstCents === "0" && row.subsequentCents === "0"));
    assert.equal(button("封存此价格版本").disabled, false);
    assert.equal(writes[1].body.fundingPolicy.ownerDepositRules.capCents, policy.ownerDepositRules.capCents);
    await fill("第1行首件加价", "2.25"); unknown = true;
    await click("保存皮肤押金草稿");
    assert.equal(writes.length, 3); assert.ok(button("保存皮肤押金草稿").disabled);
    await click("保存皮肤押金草稿"); assert.equal(writes.length, 3, "original unknown command blocks a second write");
    assert.ok(dirty.includes(true));
  } finally { await act(async () => root.unmount()); await source.close(); await browser.happyDOM.abort(); }
});
