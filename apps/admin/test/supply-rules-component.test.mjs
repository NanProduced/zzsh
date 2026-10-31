import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { fundingPolicyFixture } from "../../api/test/funding-authority-fixtures.ts";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";
import { installSupplyLockFixture } from "./supply-lock-fixture.mjs";

test("items editor saves STANDARD-only lines for the explicit draft in any row order, v1 or missing tier (Owner override)", async () => {
  const browser = new Window({url:"http://127.0.0.1:3101/workspace/supply/rules"});
  installSupplyLockFixture(browser);
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:browser.getComputedStyle.bind(browser),requestAnimationFrame:browser.requestAnimationFrame.bind(browser),cancelAnimationFrame:browser.cancelAnimationFrame.bind(browser)});
  Object.defineProperty(globalThis,"navigator",{value:browser.navigator,configurable:true});
  const originalFetch = globalThis.fetch;
  const {createRoot} = await import("react-dom/client");
  const vite = await createOfflineAdminSource({root:fileURLToPath(new URL("..",import.meta.url))});
  let root;
  try {
    const {SupplyRulesView} = await vite.ssrLoadModule("/src/views/supply-rules-view.tsx");
    for (const variant of ["v2", "v2-reversed", "multi-tier-v1", "v1", "v1-missing-tier"]) {
      const readonly = !["v1","v1-missing-tier"].includes(variant);
      const game={id:"game",name:"Fixture",code:"delta",catalogRevision:"1"};
      const priceLines=["STANDARD","VIP","SVIP","DISCOUNT_USER"].flatMap((customerTier,i)=>[
        {priceVersionId:"price",customerTier,itemId:"haff",pricingKind:"HAFF_RATIO",unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null},
        {priceVersionId:"price",customerTier,itemId:"round",pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:["10","8","7","8"][i],ownerUnitAmount:"4"},
      ]);
      const fixture={game,release:null,priceVersions:[{id:"price",mode:"SPREAD",status:"DRAFT",revision:"2",haffRule:{schema:variant.startsWith("v2")?"haff-ratio-v2":"haff-ratio-v1"},commissionRate:null,roundingPolicy:"HALF_UP_CENT_V1",sealedAt:null}],priceLines:readonly?priceLines:priceLines.slice(0,2),termVersions:[],termOptions:[],agreementVersions:[],items:[{id:"haff",name:"Haff",unit:"HAFF_BASE",enabled:true},{id:"round",name:"Rounds",unit:"ROUND",enabled:true}]};
      if (variant==="v2-reversed") fixture.priceLines.reverse();
      if (variant==="v1-missing-tier") fixture.priceLines=fixture.priceLines.map(({customerTier: _tier,...line})=>line);
      const writes=[];
      globalThis.fetch=async(input,init={})=>{const url=new URL(String(input),browser.location.href);if(init.method && init.method!=="GET"){writes.push({path:url.pathname,body:JSON.parse(init.body)});fixture.priceVersions[0].revision=String(Number(fixture.priceVersions[0].revision)+1);return Response.json({id:"price"});}return Response.json(url.pathname.endsWith("/supply/games")?{games:[game]}:fixture);};
      const el=document.createElement("div");document.body.append(el);root=createRoot(el);
      await act(async()=>root.render(createElement(SupplyRulesView,{snapshot:{authenticated:true,adminUserId:"admin-fixture",security:{isBoss:true},permissions:["supply.rules.edit","supply.quote.internal.read"]},onDirtyChange:()=>{},section:"items",draft:"price"})));
      const items=el.querySelector('[aria-label="物资价目"]');
      assert.ok(items);
      assert.ok(el.querySelector('[aria-label="发布状态"]'),"publish bar replaces the draft picker");
      {
        const input=items.querySelector('[aria-label="Rounds 租客单价"]');assert.ok(input);assert.equal(input.value,"10.00");
        await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,"value").set.call(input,"11");input.dispatchEvent(new browser.Event("input",{bubbles:true}));input.dispatchEvent(new browser.Event("change",{bubbles:true}));});
        const save=[...items.querySelectorAll("button")].find(b=>b.textContent==="保存物资价目");assert.ok(save);assert.equal(save.disabled,false);
        await act(async()=>save.click());
        assert.equal(writes.length,1);
        assert.match(writes[0].path,/price-drafts\/price$/);
        assert.equal(writes[0].body.expectedRevision,"2");
        assert.equal(writes[0].body.lines.length,2,"only STANDARD lines are written");
        assert.ok(writes[0].body.lines.every(l=>l.customerTier==="STANDARD"));
        assert.equal(writes[0].body.lines.find(l=>l.itemId==="round").buyerUnitAmount,"11");
        assert.equal(writes[0].body.lines.find(l=>l.itemId==="round").ownerUnitAmount,"4.00","owner price kept (normalised to two decimals)");
        if(readonly) assert.match(items.textContent,/旧的会员档位价目/,"member-tier drafts are flagged before save");
      }
      await act(async()=>root.unmount());root=null;el.remove();
    }
  } finally {
    if(root)await act(async()=>root.unmount());
    globalThis.fetch=originalFetch;
    await vite.close();await browser.happyDOM.abort();
  }
});

test("rules writes and trial window preserve uncertainty across lifecycle changes", async t => {
  const browser = new Window({ url: "http://127.0.0.1:3101/supply/rules" });
  const held = installSupplyLockFixture(browser);
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  Object.defineProperty(browser, "innerWidth", { value: 1440, writable: true, configurable: true }); Object.defineProperty(browser, "innerHeight", { value: 900, writable: true, configurable: true });
  const originalFetch = globalThis.fetch, { createRoot } = await import("react-dom/client");
  const vite = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  let root, el, View, model, writes, reads, policy, quotes, recovery, readResume;
  const snapshot = { authenticated: true, adminUserId: "admin-a", session: { id: "session-a" }, security: { isBoss: true, status: "ACTIVE" }, permissions: ["supply.rules.edit", "supply.quote.internal.read"] };
  const fresh = () => {
    const haffRule = { schema: "haff-ratio-v2", baseBySafeBox: { "box-a": "50" }, vitalityDeltaByLevel: { "6": "0", "7": "-1" }, bearDeltaByLevel: { "6": "0" }, dailyDeltaByTermOption: { d10: "0" }, compatibility: { ordinary: { spreadDelta: "8", discounts: { STANDARD: "0", VIP: "1", SVIP: "2", DISCOUNT_USER: "1" } }, fast: { spreadDelta: "12", discounts: { STANDARD: "0" } }, modes: { ordinary: { enabled: true }, custom: { enabled: true, min: { base: "C", value: "-3" }, max: { base: "C", value: "-1" } }, fast: { enabled: true, min: { base: "C", value: "6" }, max: { base: "ABSOLUTE", value: "99" } } } } };
    const price = { id: "p1", gameId: "g1", mode: "SPREAD", status: "SEALED", revision: "2", createdAt: "2026-10-01T00:00:00Z", sealedAt: "2026-10-01T00:00:00Z", commissionRate: null, compensationPolicyRef: null, roundingPolicy: "HALF_UP_CENT_V1", haffRule, fundingPolicy: null };
    return { game: { id: "g1", name: "三角洲行动", code: "delta", enabled: true, catalogRevision: "1" }, release: { id: "r1", gameId: "g1", priceVersionId: "p1", termVersionId: "t1", agreementVersionId: "a1", generation: "1", activatedAt: "2026-10-01T00:00:00Z" }, priceVersions: [{ ...structuredClone(price), id: "p2", revision: "3" }, price], priceLines: ["p1", "p2"].flatMap(priceVersionId => [{ priceVersionId, customerTier: "STANDARD", itemId: "haff", pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null }, { priceVersionId, customerTier: "STANDARD", itemId: "piece", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "2", ownerUnitAmount: "1" }]), termVersions: [{ id: "t1", gameId: "g1", status: "SEALED", revision: "1", createdAt: "2026-10-01T00:00:00Z", sealedAt: "2026-10-01T00:00:00Z" }], termOptions: [{ versionId: "t1", code: "d10", name: "10M/天", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }], agreementVersions: [{ id: "a1", gameId: "g1", title: "协议", body: "协议正文", digest: "hash", status: "SEALED", revision: "1", createdAt: "2026-10-01T00:00:00Z", sealedAt: "2026-10-01T00:00:00Z" }], items: [{ id: "haff", code: "haff", name: "哈夫币", unit: "HAFF_BASE", quantityScale: 0, enabled: true }, { id: "piece", code: "piece", name: "物品", unit: "PIECE", quantityScale: 0, enabled: true }] };
  };
  const quote = amount => ({ quotable: true, quote: { lines: [{ itemId: "haff", quantity: "100000000", buyerAmount: { amount }, ownerAmount: { amount: "200.00" } }], termSeconds: "864000", ownerHaffRatio: "50" } });
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const byText = (text, scope = document) => buttons(scope).find(button => button.textContent.trim() === text);
  const click = async (text, scope = document) => { const button = byText(text, scope); assert.ok(button, "button " + text); await act(async () => button.click()); };
  const fill = async (label, value) => act(async () => { const input = document.querySelector(`[aria-label="${label}"]`); assert.ok(input, label); Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  // 新流程没有「新建草稿」按钮：第一次保存时自动建草稿。
  const createDraft = async (scope = document) => { const input = scope.querySelector('[aria-label="普通模式利润点"]'); assert.ok(input, "spread input"); await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "9"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }); const button = byText("保存基础计价", scope); assert.ok(button, "save base"); await act(async () => button.click()); };
  const wait = async ms => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const businessWrites = () => writes.filter(write => !write.path.endsWith("quote-preview"));
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href), path = url.pathname;
    if (!init.method || init.method === "GET") {
      reads.push({ path, search: url.search, headers: init.headers });
      if (path.endsWith("/supply/games")) return Response.json({ games: [model.game] });
      if (path.includes("operation-result")) return Response.json(recovery);
      if (policy === "readback-fail" && businessWrites().length) throw new Error("readback failed");
      if (policy === "readback-delay" && businessWrites().length) { const original = structuredClone(model); return new Promise(resolve => { readResume = () => resolve(Response.json(original)); }); }
      return Response.json(model);
    }
    const body = JSON.parse(init.body); writes.push({ path, body, method: init.method, key: init.headers["idempotency-key"] });
    if (path.endsWith("quote-preview")) { if (policy === "quote-delay") return new Promise(resolve => quotes.push(amount => resolve(Response.json(quote(amount))))); return Response.json(quote("238.10")); }
    if (policy === "conflict") return Response.json({ error: { code: "CONFLICT" } }, { status: 409 });
    const receipt = path.endsWith("releases") ? { releaseId: "r2", generation: "2", affectedCount: 4 } : { id: "pnew" };
    if (path.endsWith("releases")) model.release = { ...model.release, id: "r2", generation: "2", priceVersionId: body.priceVersionId, termVersionId: body.termVersionId, agreementVersionId: body.agreementVersionId };
    else if (path.endsWith("price-drafts")) model.priceVersions.unshift({ ...model.priceVersions[0], id: "pnew", status: "DRAFT", revision: "1", sealedAt: null }), model.priceLines.push(...model.priceLines.filter(line => line.priceVersionId === "p2").map(line => ({ ...line, priceVersionId: "pnew" })));
    else if (path.endsWith("/seal")) model.priceVersions.find(version => version.id === "pnew").status = "SEALED";
    if (policy === "lost") throw new Error("response lost");
    if (policy === "server-error") return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    if (policy === "foreign-id") return Response.json({ id: "another-draft" });
    return Response.json(receipt);
  };
  async function mount({ preserve = false, permissions = snapshot.permissions, fundingPolicy = null, draftPolicy = null, section = undefined, draft = undefined, onOpenPath = undefined } = {}) {
    if (root) { await act(async () => root.unmount()); el.remove(); }
    if (!preserve) { browser.localStorage.clear(); model = fresh(); writes = []; reads = []; policy = "ok"; quotes = []; recovery = { receipt: "UNRESOLVED" }; readResume = null; }
    if (fundingPolicy) model.priceVersions.find(version => version.id === "p1").fundingPolicy = fundingPolicy;
    if (draft === "p2" && !preserve) Object.assign(model.priceVersions[0], { status: "DRAFT", sealedAt: null });
    if (draftPolicy) model.priceVersions.find(version => version.id === "p2").fundingPolicy = draftPolicy;
    el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root.render(createElement(View, { snapshot: { ...snapshot, permissions }, onDirtyChange: () => undefined, section, draft, onOpenPath })));
    await wait(0);
  }
  const activate = async () => { await click("选择版本并确认生效"); await click("确认生效"); };
  try {
    ({ SupplyRulesView: View } = await vite.ssrLoadModule("/src/views/supply-rules-view.tsx"));
    await t.test("overview keeps trial and activation and does not offer an unsavable preview editor", async () => {
      await mount();
      assert.equal(byText("编辑规则（仅预览）"), undefined);
      assert.ok(byText("试算一单"));
      assert.ok(byText("选择版本并确认生效"));
      assert.doesNotMatch(el.textContent, /本轮修改不能保存|暂不能保存或提交审批/);
      assert.equal([...el.querySelectorAll('select,details,summary,textarea:not([data-slot]),button:not([data-slot]),input:not([data-slot]):not([type=hidden]):not([aria-hidden])')].filter(n => !n.closest('.rules-markdown')).length, 0, 'only the shared Markdown editor may bring its own controls');
    });
    await t.test("v1 skin hides old group amounts and the overview opens the skin section", async () => {
      const fundingPolicy = fundingPolicyFixture("NOT_REQUIRED");
      fundingPolicy.recommendation.parameters.skinWeights.LEGACY_GOLD = { firstCents: "12345", subsequentCents: "6789" };
      const original = structuredClone(fundingPolicy);
      let opened = "";
      await mount({ fundingPolicy, onOpenPath: (path) => { opened = path; } });
      await click("配置新版皮肤押金");
      assert.equal(opened, "/supply/rules?section=skin");
      assert.equal(el.querySelector('a[href="#skin-deposit-policy-g1"]'), null);
      assert.ok(el.querySelector("#skin-deposit-policy-g1"));
      assert.match(el.textContent, /旧写法/);
      assert.doesNotMatch(el.textContent, /旧版分组|人物金皮|人物红皮|刀皮|武器砖皮|123\.45/);
      assert.equal(el.querySelectorAll('[aria-label*="人物金皮"]').length, 0);
      assert.deepEqual(model.priceVersions.find(version => version.id === "p1").fundingPolicy, original, "read-only disclosure preserves the existing policy amounts");
      assert.equal(businessWrites().length, 0);
    });
    await t.test("an effective v2 policy does not show the unsavable preview editor", async () => {
      const { buildSkinDepositPolicy, skinDepositDraft } = await vite.ssrLoadModule("/src/views/supply-rules/skin-deposit-policy.ts");
      const original = fundingPolicyFixture("NOT_REQUIRED"), draft = skinDepositDraft(original);
      draft.policyVersion = "synthetic-v2";
      draft.rules = draft.rules.map(row => ({ ...row, first: "0", subsequent: "0" }));
      await mount({ section: "deposit", fundingPolicy: buildSkinDepositPolicy(original, draft) });
      assert.equal(byText("编辑规则（仅预览）"), undefined);
      assert.match(el.textContent, /草稿押金上限/);
      assert.doesNotMatch(el.textContent, /旧版分组/);
      assert.equal(businessWrites().length, 0);
    });
    await t.test("field association reaches the real select trigger through the rules wrapper", async () => {
      await mount({ section: "pricing" });
      for (const label of []) {
        const trigger = [...el.querySelectorAll("[aria-labelledby]")].find(node => document.getElementById(node.getAttribute("aria-labelledby"))?.textContent.trim() === label);
        assert.ok(trigger, "labelled trigger for " + label);
        assert.equal(document.getElementById(trigger.getAttribute("aria-labelledby"))?.textContent.trim(), label, "visible label is the accessible name of " + label);
        assert.equal(trigger.getAttribute("aria-label"), null, "no stale aria-label on " + label);
      }
    });
    await t.test("composite field error contract lands on the select control", async () => {
      const { Field } = await vite.ssrLoadModule("/src/components/ui/field.tsx");
      const { SupplySelect } = await vite.ssrLoadModule("/src/components/supply/supply-select.tsx");
      const host = document.createElement("div");
      document.body.append(host);
      const box = createRoot(host);
      try {
        await act(async () => box.render(createElement(Field, { label: "模式", composite: true, hint: "依实际方案标注。", error: "请选择模式。" },
          createElement(SupplySelect, { label: "模式", value: "", options: [{ value: "a", label: "甲" }], onValueChange: () => undefined }))));
        const trigger = host.querySelector("[aria-labelledby]");
        assert.ok(trigger, "trigger keeps the visible label association");
        assert.equal(trigger.getAttribute("aria-invalid"), "true", "error state reaches the control, not only the text");
        const refs = (trigger.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
        assert.deepEqual(refs.map(id => document.getElementById(id)?.textContent.trim()), ["依实际方案标注。", "请选择模式。"]);
      } finally {
        await act(async () => box.unmount());
        host.remove();
      }
    });
    await t.test("no permission starts no reads", async () => { await mount({ permissions: [] }); assert.match(el.textContent, /没有规则草稿编辑权限/); assert.equal(reads.length, 0); });
    for (const failure of ["lost", "server-error"]) await t.test("release " + failure + " stays locked after closing and unmounting", async () => {
      await mount(); policy = failure; await activate(); assert.match(document.body.textContent, /结果未知/); const key = businessWrites()[0].key;
      await click("关闭（保留原请求）"); await click("选择版本并确认生效"); assert.ok(!byText("确认生效")); assert.equal(businessWrites().length, 1);
      await mount({ preserve: true }); assert.match(el.textContent, /原规则写入结果尚未核清|请求可能已执行/);
      await click("核对原写入回执"); const read = reads.find(read => read.path.includes("operation-result")); assert.equal(read.headers["idempotency-key"], key); assert.ok(new URLSearchParams(read.search).get("fingerprint")); assert.equal(businessWrites().length, 1); assert.match(el.textContent, /不代表请求未执行/);
    });
    await t.test("recorded recovery keeps omitted affected counts unknown", async () => {
      await mount(); policy = "lost"; await activate(); await click("关闭（保留原请求）"); recovery = { receipt: "RECORDED", responseStatus: 200, operation: "supply.rules.release.activate", resourceId: "g1", result: { releaseId: "r2", generation: "2" } }; await click("核对原写入回执"); await click("选择版本并确认生效"); assert.match(document.body.textContent, /未提供受影响账号数量/); assert.equal(businessWrites().length, 1); assert.equal(browser.localStorage.length, 0);
    });
    await t.test("recovery echo must match the original operation and resource", async () => {
      await mount(); policy = "lost"; await activate(); await click("关闭（保留原请求）"); recovery = { receipt: "RECORDED", responseStatus: 200, operation: "supply.rules.price_draft.update", resourceId: "another", result: { releaseId: "r2", generation: "2" } }; await click("核对原写入回执"); assert.match(el.textContent, /未提供匹配的完整写入结果/); assert.ok(browser.localStorage.length); assert.equal(businessWrites().length, 1);
    });
    await t.test("accepted but failed readback is not an error or permission to submit again", async () => {
      await mount(); policy = "readback-fail"; await activate(); assert.match(document.body.textContent, /已收到写入回执，但规则回读失败/); assert.ok(!byText("确认生效")); assert.equal(businessWrites().length, 1);
      await mount({ preserve: true }); assert.match(el.textContent, /已收到原写入回执|已收到写入回执/); assert.equal(businessWrites().length, 1);
    });
    await t.test("accepted old-scope readback cannot replace a new actor/session/game", async () => {
      await mount(); policy = "readback-delay"; await activate(); for (let n = 0; n < 20 && !readResume; n++) await wait(0); assert.ok(readResume);
      model = fresh(); model.game = { ...model.game, id: "g2", name: "新游戏" }; model.release.gameId = "g2"; policy = "ok";
      await act(async () => root.render(createElement(View, { snapshot: { ...snapshot, adminUserId: "admin-b", session: { id: "session-b" } }, onDirtyChange: () => undefined }))); await wait(0);
      assert.match(el.textContent, /新游戏/); assert.ok(el.querySelector('[aria-label="当前生效版本"]'));
      await act(async () => readResume()); await wait(0); assert.match(el.textContent, /新游戏/); assert.match(el.querySelector('[aria-label="当前生效版本"]').textContent, /已生效/);
      assert.equal(businessWrites().length, 1); assert.ok(browser.localStorage.getItem("zzsh.admin.rules.pending.v1:admin-a"), "old accepted intent stays under the original actor");
    });
    await t.test("advanced creation response loss and refresh cannot recreate a draft", async () => {
      await mount({ section: "pricing" }); policy = "lost"; await createDraft(); assert.match(el.textContent, /请求可能已执行/); const write = businessWrites()[0]; assert.match(write.path, /price-drafts$/);
      await mount({ preserve: true, section: "pricing" }); await createDraft().catch(() => undefined); assert.equal(businessWrites().length, 1);
      await click("核对原写入回执"); const recoveryRead = reads.find(read => read.path.includes("operation-result")); assert.equal(new URLSearchParams(recoveryRead.search).get("operation"), "supply.rules.price_draft.create"); assert.equal(new URLSearchParams(recoveryRead.search).has("resourceId"), false); assert.equal(recoveryRead.headers["idempotency-key"], write.key);
    });
    await t.test("seal response cannot settle another draft's ID", async () => {
      const { buildSkinDepositPolicy, skinDepositDraft } = await vite.ssrLoadModule("/src/views/supply-rules/skin-deposit-policy.ts"); const base = fundingPolicyFixture("NOT_REQUIRED"), sd = skinDepositDraft(base); sd.policyVersion = "synthetic-v2"; sd.rules = sd.rules.map(row => ({ ...row, first: "0", subsequent: "0" }));
      await mount({ section: "pricing", draft: "p2", draftPolicy: buildSkinDepositPolicy(base, sd) }); policy = "foreign-id"; await act(async () => buttons().find(b => b.textContent.startsWith("待发布修改")).click()); await click("提交发布"); await click("确认提交"); assert.match(el.textContent, /写入回执不完整|请求可能已执行/); const record = JSON.parse(browser.localStorage.getItem("zzsh.admin.rules.pending.v1:admin-a")); assert.equal(record.resourceId, "p2", "the sealed draft ID is kept, not the foreign one"); assert.equal(record.operation, "supply.rules.price_draft.seal"); assert.equal(businessWrites().length, 1);
    });
    await t.test("tampered body cannot start a receipt query with the old digest", async () => {
      await mount({ section: "pricing" }); policy = "lost"; await createDraft(); const key = "zzsh.admin.rules.pending.v1:admin-a", record = JSON.parse(browser.localStorage.getItem(key)); record.body.mode = "PERCENT"; browser.localStorage.setItem(key, JSON.stringify(record)); await mount({ preserve: true, section: "pricing" }); await click("核对原写入回执"); assert.match(el.textContent, /本地原请求与指纹不一致/); assert.equal(reads.filter(read => read.path.includes("operation-result")).length, 0); assert.equal(businessWrites().length, 1);
    });
    await t.test("409 preserves inputs and does not auto-adopt a revision", async () => {
      await mount(); policy = "conflict"; await activate(); assert.match(document.body.textContent, /版本冲突|版本已变化/); assert.equal(businessWrites()[0].body.expectedGeneration, "1"); assert.equal(businessWrites().length, 1); assert.equal(browser.localStorage.length, 0);
    });
    await t.test("storage failure blocks a command before POST", async () => {
      await mount({ section: "pricing" }); const original = browser.localStorage, descriptor = Object.getOwnPropertyDescriptor(browser, "localStorage"); Object.defineProperty(browser, "localStorage", { configurable: true, value: { getItem: original.getItem.bind(original), removeItem: original.removeItem.bind(original), setItem: () => { throw new Error("quota"); } } });
      try { await createDraft(); assert.equal(businessWrites().length, 0); assert.match(el.textContent, /未发送写入命令/); } finally { if (descriptor) Object.defineProperty(browser, "localStorage", descriptor); else delete browser.localStorage; }
    });
    await t.test("a busy cross-window lock sends no command and creates no UNKNOWN intent", async () => {
      await mount({ section: "pricing" }); const lockName = "zzsh:supply-write:zzsh.admin.rules.pending.v1:admin-a"; held.add(lockName);
      try { await createDraft(); assert.equal(businessWrites().length, 0); assert.equal(browser.localStorage.length, 0); assert.match(el.textContent, /另一窗口正在处理.*本次未发送写入命令/); assert.ok(!el.textContent.includes("原规则写入结果尚未核清")); } finally { held.delete(lockName); }
    });
    await t.test("a missing LockManager fails closed before POST", async () => {
      await mount({ section: "pricing" }); Object.defineProperty(browser.navigator, "locks", { configurable: true, value: undefined });
      try { await createDraft(); assert.equal(businessWrites().length, 0); assert.equal(browser.localStorage.length, 0); assert.match(el.textContent, /跨窗口写入锁.*本次未发送写入命令/); } finally { installSupplyLockFixture(browser, held); }
    });
    await t.test("the lock also covers receipt lookup and keeps the original key", async () => {
      await mount({ section: "pricing" }); policy = "lost"; await createDraft(); const original = browser.localStorage.getItem("zzsh.admin.rules.pending.v1:admin-a"), lockName = "zzsh:supply-write:zzsh.admin.rules.pending.v1:admin-a"; held.add(lockName);
      try { await click("核对原写入回执"); assert.equal(reads.filter(read => read.path.includes("operation-result")).length, 0); assert.equal(browser.localStorage.getItem("zzsh.admin.rules.pending.v1:admin-a"), original); assert.match(el.textContent, /本次未发送恢复查询/); } finally { held.delete(lockName); }
    });
    await t.test("two same-admin instances with a late digest issue exactly one POST", async () => {
      await mount({ section: "pricing" }); const second = document.createElement("div"); document.body.append(second); const secondRoot = createRoot(second);
      await act(async () => secondRoot.render(createElement(View, { snapshot, onDirtyChange: () => undefined, section: "pricing" }))); await wait(0);
      const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest"), originalDigest = crypto.subtle.digest;
      let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
      Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: async (...args) => { if (!entered) { entered = true; await gate; } return originalDigest.apply(crypto.subtle, args); } });
      try {
        await createDraft(el); assert.equal(entered, true); assert.equal(businessWrites().length, 0);
        await createDraft(second); assert.match(second.textContent, /另一窗口正在处理/); assert.equal(businessWrites().length, 0);
        await act(async () => release()); await wait(0); assert.equal(businessWrites().length, 2, "one create + one save, nothing from the second window");
      } finally { release(); if (descriptor) Object.defineProperty(crypto.subtle, "digest", descriptor); else delete crypto.subtle.digest; await act(async () => secondRoot.unmount()); second.remove(); }
    });
    await t.test("draft save 409 keeps input, offers reread and never retries", async () => {
      await mount({ section: "items", draft: "p2" }); policy = "conflict"; await fill("物品 租客单价", "9"); await click("保存物资价目");
      assert.match(el.textContent, /版本已变化（409）/); assert.equal(document.querySelector('[aria-label="物品 租客单价"]').value, "9"); assert.equal(businessWrites().length, 1); assert.match(businessWrites()[0].path, /price-drafts\/p2$/);
      await wait(50); assert.equal(businessWrites().length, 1, "no auto-retry");
    });
    await t.test("sealed version is read-only and drafts stay isolated", async () => {
      await mount({ section: "items" }); await fill("物品 租客单价", "7"); await click("保存物资价目"); assert.match(businessWrites()[0].path, /price-drafts$/, "sealed versions are never edited; saving creates a new draft"); assert.ok(businessWrites().every(w => !/p1|p2/.test(w.path))); assert.equal(model.priceVersions.find(v => v.id === "p1").status, "SEALED");
    });
    await t.test("cleared account conditions invalidate an already running quote", async () => {
      await mount(); policy = "quote-delay"; await click("试算一单"); await wait(450); assert.equal(quotes.length, 1);
      await fill("哈夫币（M）", ""); await act(async () => quotes[0]("999999.00")); await wait(0);
      const current = document.querySelector('[aria-label="当前生效规则"]'), adjusted = document.querySelector('[aria-label="可调整参数"]'); assert.match(current.textContent, /待计算/); assert.ok(!current.textContent.includes("999,999")); assert.match(adjusted.textContent, /待计算/); assert.ok(!adjusted.textContent.includes("¥"));
    });
    await t.test("latest quote wins and invalid item quantities are not silently omitted", async () => {
      await mount(); policy = "quote-delay"; await click("试算一单"); await wait(450); await fill("哈夫币（M）", "200"); await wait(450); assert.equal(quotes.length, 2);
      await act(async () => quotes[1]("777.77")); await act(async () => quotes[0]("999.99")); await wait(0); assert.match(document.querySelector('[aria-label="当前生效规则"]').textContent, /777\.77/); assert.ok(!document.querySelector('[aria-label="当前生效规则"]').textContent.includes("999.99"));
      await fill("物品（件）", "-1"); assert.match(document.querySelector('[aria-label="当前生效规则"]').textContent, /待计算/); assert.ok(!document.querySelector('[aria-label="可调整参数"]').textContent.includes("¥"));
    });
    await t.test("trial compares live and draft via two server quotes and never writes a draft", async () => {
      model = fresh(); await mount({ draft: "p2" }); model.priceLines.find(l => l.priceVersionId === "p2" && l.itemId === "piece").buyerUnitAmount = "3"; await mount({ draft: "p2", preserve: true });
      await click("试算一单"); await wait(450);
      const q = writes.filter(w => w.path.endsWith("quote-preview")); assert.deepEqual(q.map(w => w.body.priceVersionId).sort(), ["p1", "p2"]); assert.equal(q.find(w => w.body.priceVersionId === "p2").body.expectedRevision, "3");
      const pane = document.querySelector('[aria-label="试算一单"]'); for (const h of ["线上", "草稿", "差额", "保险箱", "体力等级", "负重等级", "潜水等级", "每日消耗档"]) assert.match(pane.textContent, new RegExp(h));
      assert.match(document.querySelector('[aria-label="可调整参数"]').textContent, /238\.10/); assert.equal(businessWrites().length, 0);
      await click("临时调整（估算）"); await fill("比例差（普通/自定义）", "9"); assert.match(pane.textContent, /估算/);
    });
    await t.test("empty adjustment cannot produce a numeric result", async () => {
      await mount(); await click("试算一单"); await click("临时调整（估算）"); await fill("比例差（普通/自定义）", ""); const adjusted = document.querySelector('[aria-label="可调整参数"]'); assert.match(adjusted.textContent, /缺失|非法/); assert.ok(!adjusted.textContent.includes("¥"));
    });
    await t.test("drag and resize keep controls reachable; Escape returns focus", async () => {
      await mount(); const trigger = byText("试算一单"); trigger.focus(); await click("试算一单"); const pane = document.querySelector('[aria-label="试算一单"]'), header = pane.firstElementChild;
      await act(async () => { header.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 })); header.dispatchEvent(new browser.PointerEvent("pointermove", { bubbles: true, clientX: 10000, clientY: 10000, pointerId: 1 })); }); assert.ok(parseFloat(pane.style.left) <= 452);
      await act(async () => { browser.innerWidth = 390; browser.innerHeight = 844; browser.dispatchEvent(new browser.Event("resize")); }); assert.equal(parseFloat(pane.style.left), 8);
      await act(async () => document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); assert.equal(document.querySelector('[aria-label="试算一单"]'), null); assert.equal(document.activeElement, trigger);
      browser.innerWidth = 1440; browser.innerHeight = 900;
    });
  } finally { if (root) await act(async () => root.unmount()); globalThis.fetch = originalFetch; await vite.close(); await browser.happyDOM.abort(); }
});


test("Root: changing one price row never rounds an untouched fractional-cent contract", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101/" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const vite = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const { PriceItemsEditor } = await vite.ssrLoadModule("/src/views/supply-rules/step0-editors.tsx");
    const rules = { game: { id: "root-g" }, release: { priceVersionId: "root-draft" }, priceVersions: [{ id: "root-draft", mode: "SPREAD", status: "DRAFT", revision: "1" }], priceLines: [{ priceVersionId: "root-draft", itemId: "fraction", pricingKind: "FIXED_UNIT", unitQuantity: "60", buyerUnitAmount: "0.005", ownerUnitAmount: "0.003", customerTier: "STANDARD" }, { priceVersionId: "root-draft", itemId: "other", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "10", ownerUnitAmount: "4", customerTier: "STANDARD" }], items: [{ id: "fraction", code: "root-fraction", name: "精确单价", unit: "ROUND" }, { id: "other", code: "root-other", name: "其他物资", unit: "PIECE" }] };
    const writes = [];
    await act(async () => root.render(createElement(PriceItemsEditor, { rules, draftId: "root-draft", canEdit: true, onDirtyChange() {}, ensureDraft: async () => ({ rules, draft: rules.priceVersions[0] }), command: { locked: false, write: async command => { writes.push(command); return {}; } } })));
    assert.equal(host.querySelector('[aria-label="精确单价 租客单价"]').value, "0.005");
    const input = host.querySelector('[aria-label="其他物资 租客单价"]');
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "11.12345678"); input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
    assert.equal(input.value, "11.12345678");
    const save = [...host.querySelectorAll("button")].find(button => button.textContent === "保存物资价目");
    assert.equal(save.disabled, false); await act(async () => save.click());
    assert.equal(writes.length, 1);
    const fraction = writes[0].body.lines.find(line => line.itemId === "fraction");
    assert.equal(fraction.buyerUnitAmount, "0.005"); assert.equal(fraction.ownerUnitAmount, "0.003");
  } finally { await act(async () => root.unmount()); host.remove(); await vite.close(); await browser.happyDOM.abort(); }
});
