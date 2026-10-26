import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { installSupplyLockFixture } from "./supply-lock-fixture.mjs";

// Rewritten 2026-10-13 for the row-edit + dialog catalog UI. Same protection
// surface as the sheet-era suite: identity confirm, 409 adoption, UNKNOWN
// original-key replay, close/reopen recovery, readback failure, late response
// isolation, permission loss, missing contract, FIREARM id-only binding.
test("catalog row editor: identity, conflicts and fixed request recovery", async t => {
  const browser = new Window({ url: "http://127.0.0.1:3101/supply/catalog" });
  const heldSupplyLocks = installSupplyLockFixture(browser);
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import("react-dom/client");
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  Object.assign(globalThis, { requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  let root, el, model, writes, reads, policy, pending, pendingRead, readFailure, identity, receipts, createdGames;
  const dirty = [];
  const actor = (id = "admin-a", gunsmith = false) => ({ authenticated: true, adminUserId: id, security: { status: "ACTIVE", isBoss: false }, session: { id: "session-" + id, locked: false }, permissions: ["supply.catalog.manage", ...(gunsmith ? ["supply.gunsmith.manage"] : [])] });
  const skin = (id, namingState) => ({ id, code: "code_" + id, name: namingState === "VERIFIED" ? "Agent-Old" : "旧名 " + id, categoryId: "category", rarityCode: null, enabled: namingState !== "PENDING", formVisible: namingState !== "PENDING", mediaId: null, sortOrder: 0, sourceNamespace: null, sourceField: "agent_skin", sourceToken: " raw " + id + " ", aliases: [], baseName: namingState === "VERIFIED" ? "Old" : null, ownerRef: namingState === "VERIFIED" ? { kind: "AGENT", id: "agent" } : null, namingState });
  const fresh = () => ({ skinCategoryModel:{mode:"RETIRED",categorylessWriteReady:true,legacyReferencesReadOnly:true}, game: { id: "game", code: "delta", name: "Fixture game", enabled: true, catalogRevision: "10" }, items: [{ id: "item", code: "item_code", name: "Existing item", unit: "PIECE", quantityScale: 0, required: false, sortOrder: 0, enabled: true, mediaId: null }], rarities: [], categories: [{ id: "category", code: "category", name: "Display category", parentId: null, enabled: true, formVisible: true, sortOrder: 0 }], skins: [skin("legacy", "LEGACY"), skin("verified", "VERIFIED"), skin("pending", "PENDING")], entitlements: [], owners: [{ id: "agent", kind: "AGENT", code: "agent_code", name: "Agent", enabled: true }, { id: "melee", kind: "MELEE_TYPE", code: "melee_code", name: "Blade", enabled: true }], firearmOwners: [{ id: "gun", code: "gun_code", name: "Gun", enabled: true }] });
  const NL = String.fromCharCode(10);
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const byText = (text, scope = document) => buttons(scope).find(b => b.textContent.trim() === text) ?? [...scope.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.replace(/\s+/g, " ").trim().replace(/(?:已加载)?待核\s*\d+/g, "").replace(/\s*\d+$/, "").trim() === text);
  const row = id => [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes("code_" + id));
  const field = label => document.querySelector(`[aria-label="${label}"]`) ?? (() => { const node = [...document.querySelectorAll("label")].find(l => l.querySelector("span")?.textContent === label); assert.ok(node, "field " + label); return node.querySelector("input,select,textarea,button"); })();
  const click = async (text, scope = document) => { if(text === "保存") { const reason = [...document.querySelectorAll("label")].find(l => l.querySelector("span")?.textContent === "操作原因")?.querySelector("input"); if(reason && !reason.value.trim()) await fill("操作原因", "Synthetic catalog edit reason"); } const b = byText(text, scope); assert.ok(b, "button " + text); await act(async () => b.click()); };
  const fill = async (label, value) => act(async () => {
    const node = field(label);
    if (node.tagName === "BUTTON") {
      await act(async () => node.click());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      const LABEL_FOR = { FIREARM: "枪械", MELEE_TYPE: "近战外观", AGENT: "干员" };
      const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes(LABEL_FOR[value] ?? value) || (value === "MELEE_TYPE" && o.textContent.includes("近战外观")));
      assert.ok(option, "option " + value);
      await act(async () => option.click());
      return;
    }
    const prototype = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const saveRow = async () => click(byText("保存") ? "保存" : "保存中…");
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const review = async () => { await fill("操作原因", "Reviewed mapping"); await fill("证据链接（每行一条，最多8条）", "https://example.org/one" + NL + "https://example.org/two"); await fill("证据核对日期", "2026-09-26"); await fill("适用地区", "CN"); await fill("证据说明", "Synthetic relation and exact legacy token reviewed"); };
  function apply(path, body) {
    if (path.endsWith("/supply/games")) { const game = { ...body, id: "created-game", enabled: true, catalogRevision: "1" }; createdGames.push(game); return { game }; }
    model.game.catalogRevision = String(Number(model.game.catalogRevision) + 1);
    const kind = path.includes("skin-owners") ? "owners" : "skins";
    let record = model[kind].find(r => path.endsWith("/" + r.id));
    if (!record) { record = kind === "skins" ? { ...skin("created", "PENDING"), ...body, id: "created", sourceNamespace: null, sourceField: null, sourceToken: null } : { id: "created-owner", ...body, enabled: true }; model[kind].push(record); }
    else {
      Object.assign(record, body);
      if (body.confirmIdentity) { record.namingState = "VERIFIED"; record.name = body.ownerRef ? (body.ownerRef.kind === "FIREARM" ? "Gun" : model.owners.find(o => o.id === body.ownerRef.id)?.name) + "-" + body.baseName : body.baseName; }
    }
    return { id: record.id, code: record.code, catalogRevision: model.game.catalogRevision, ...(kind === "skins" ? { namingState: record.namingState } : { kind: record.kind, enabled: record.enabled }) };
  }
  globalThis.fetch = async (input, init = {}) => {
    const parsedUrl = new URL(String(input), browser.location.href), path = parsedUrl.pathname, query = parsedUrl.search;
    if (!init.method || init.method === "GET") {
      reads.push(path + query);
      if (path.endsWith("/games")) return Response.json({ games: [model.game, ...createdGames, { ...model.game, id: "other", name: "Other game" }] });
      if (path.includes("media-options")) return Response.json(query.includes("SKIN_MEDIA") ? { items: [{ id: "skin-media", gameId: "game", mime: "image/png", width: 32, height: 32, byteSize: "128" }], nextCursor: null, limit: 20 } : { items: [], nextCursor: null, limit: 20 });
      if (path.endsWith("/firearms")) throw new Error("Catalog must not require gunsmith permission");
      if (path.endsWith("/operation-result")) {
        if (policy === "recovery-denied") return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
        const saved = receipts.get(init.headers?.["idempotency-key"]);
        return Response.json(saved ? { receipt: "RECORDED", operation: parsedUrl.searchParams.get("operation"), resourceId: parsedUrl.searchParams.get("resourceId"), responseStatus: 200, result: { id: saved.result.id ?? saved.result.game?.id } } : { receipt: "UNRESOLVED" });
      }
      if (policy === "delay-read") { policy = "ok"; const captured = structuredClone(model); return new Promise(resolve => { pendingRead = () => resolve(Response.json(captured)); }); }
      if (readFailure) { readFailure = false; throw new Error("readback failed"); }
      return Response.json(path.includes("/other/") ? { ...model, game: { ...model.game, id: "other", name: "Other game" } } : model);
    }
    const body = JSON.parse(init.body), request = { path, body, raw: init.body, key: init.headers["idempotency-key"], method: init.method };
    writes.push(request);
    if (receipts.has(request.key)) { const saved = receipts.get(request.key); assert.equal(saved.raw, request.raw); return Response.json(saved.result); }
    if (policy === "delay") return new Promise(resolve => { pending = () => resolve(Response.json(apply(path, body))); });
    if (policy === "conflict") { model.game.catalogRevision = "11"; return Response.json({ error: { code: "CONFLICT" } }, { status: 409 }); }
    if (policy === "network") { policy = "ok"; receipts.set(request.key, { raw: request.raw, result: apply(path, body) }); throw new Error("lost committed response"); }
    if (policy === "invalid-receipt") { policy = "ok"; receipts.set(request.key, { raw: request.raw, result: apply(path, body) }); return Response.json(null); }
    const result = apply(path, body); receipts.set(request.key, { raw: request.raw, result });
    if (policy === "game-empty-id") return Response.json({ game: { ...result.game, id: "" } });
    if (policy === "game-wrong-code") return Response.json({ game: { ...result.game, code: "other_code" } });
    if (policy === "game-missing-readback") createdGames = [];
    if (policy === "readback-fail") { policy = "ok"; readFailure = true; }
    return Response.json(result);
  };
  let View;
  async function mount(options = {}) {
    if (root) { await act(async () => root.unmount()); el.remove(); }
    browser.localStorage.clear();
    model = fresh(); if (options.missing) delete model.owners;
    if (options.missingFirearms) delete model.firearmOwners;
    if (options.badFirearms) model.firearmOwners[0].enabled = "yes";
    writes = []; reads = []; receipts = new Map(); createdGames = []; policy = "ok"; pending = null; pendingRead = null; readFailure = false; identity = actor("admin-a", Boolean(options.gunsmith));
    el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: value => dirty.push(value) })));
    for (let i = 0; i < 20 && !byText("皮肤"); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(byText("皮肤")); await click("皮肤");
  }
  async function remount(snapshot = identity) {
    if (root) { await act(async () => root.unmount()); el.remove(); }
    el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root.render(createElement(View, { snapshot, onDirtyChange: value => dirty.push(value) })));
    for (let index = 0; index < 20 && !byText("皮肤"); index++) await flush();
    if (byText("皮肤")) await click("皮肤");
  }
  try {
    ({ SupplyCatalogView: View } = await vite.ssrLoadModule("/src/views/supply-catalog-view.tsx"));
    await t.test("category retirement: Delta nav and new form have no legacy category control",async()=>{await mount();assert.ok(!byText("皮肤分类"));assert.ok(!document.querySelector('[data-catalog-list-title="categories"]'));await click("新增皮肤");assert.ok(!document.querySelector('[aria-label="分类"]'));assert.ok(!document.body.textContent.includes("先维护至少一个皮肤分类"));});
    await t.test("row create writes disabled draft; aliases and identity confirm are separate writes", async () => {
      await mount(); await click("新增皮肤"); await fill("稳定 code", "new_skin"); await fill("名称", "New raw");
      await saveRow(); assert.equal(writes.length, 1); assert.equal(writes[0].body.enabled, false); assert.equal(writes[0].body.formVisible, false); assert.equal(writes[0].body.expectedCatalogRevision, "10"); assert.ok(!("ownerRef" in writes[0].body));
      assert.match(document.body.textContent, /待核实/);
      await click("详情", row("created")); await fill("别名（每行一个）", "Alias A" + NL + "Alias B"); await click("保存", document.querySelector('[role="dialog"]')); assert.equal(writes.length, 2); assert.deepEqual(writes[1].body.aliases, ["Alias A", "Alias B"]);
      await click("确认身份", row("created")); await fill("所属对象", "Agent"); await fill("皮肤本名", "Canonical"); await click("保存", document.querySelector('[role="dialog"]')); assert.equal(writes.length, 2, "missing evidence never submits");
      await review(); await click("保存", document.querySelector('[role="dialog"]'));
    });
    await t.test("LEGACY rename omits untouched source; VERIFIED exposes base name without editable owner", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Renamed"); await fill("操作原因", "Row reason"); await saveRow(); assert.equal(writes[0].body.name, "Renamed"); for (const key of ["sourceNamespace", "sourceField", "sourceToken", "enabled", "namingState", "id", "code"]) assert.ok(!(key in writes[0].body), key);
      await click("编辑", row("verified")); assert.equal(field("皮肤本名").disabled, false); assert.equal(document.querySelector('[aria-label="所属对象"]'),null); await click("详情", row("verified")); await fill("别名（每行一个）", "Verified alias"); await click("保存", document.querySelector('[role="dialog"]')); assert.ok(!("name" in writes[1].body)); assert.deepEqual(writes[1].body.aliases, ["Verified alias"]);
    });
    await t.test("skin edit Dialog corrects a verified name only with original identity and evidence", async () => {
      await mount(); await click("编辑", row("verified")); assert.match(document.querySelector('[role="dialog"]').textContent,/编辑皮肤词条/);
      await fill("皮肤本名","New"); await saveRow(); assert.equal(writes.length,0,"evidence is still required"); assert.match(document.body.textContent,/证据/);
      await review(); await saveRow(); assert.equal(writes.length,1);const body=writes[0].body;assert.equal(body.confirmIdentity,true);assert.equal(body.baseName,"New");assert.deepEqual(body.ownerRef,{kind:"AGENT",id:"agent"});assert.equal(body.expectedCatalogRevision,"10");assert.ok(!("sourceNamespace" in body));
    });
    await t.test("skin edit Dialog cancel discards only unsaved edits; missing reason stays local", async () => {
      await mount(); await click("编辑",row("legacy"));await fill("名称","Unsaved display");
      await act(async()=>byText("保存").click());assert.equal(writes.length,0);assert.match(document.body.textContent,/改名原因|修改原因/);
      await click("取消");await click("放弃修改");await click("编辑",row("legacy"));assert.notEqual(field("名称").value,"Unsaved display");assert.equal(writes.length,0);
    });
    await t.test("both source-name inputs expose the server's 100-character limit", async () => {
      await mount(); await click("详情", row("legacy"));
      assert.match(document.body.textContent, /先保存词条并绑定平台图片，再记录图片来源/);
      assert.equal(field("品质来源名称").maxLength, 100);
      await fill("更新图片来源", "填写本次来源"); assert.equal(field("图片来源名称").maxLength, 100);
      assert.equal(writes.length, 0);
    });
    await t.test("source attaches only by explicit choice and keeps exact old token", async () => {
      await mount(); await click("编辑", row("legacy")); await click("详情"); const box = document.querySelector('[role="dialog"] [role="checkbox"]'); await act(async () => box.click()); await fill("来源命名空间", "legacy.sg_zzsh"); assert.equal(field("来源字段").readOnly, true); assert.equal(field("原始来源值").readOnly, true); await review(); await click("保存", document.querySelector('[role="dialog"]')); assert.equal(writes[0].body.sourceToken, " raw legacy "); assert.equal(writes[0].body.sourceField, "agent_skin"); assert.equal(writes[0].body.sourceNamespace, "legacy.sg_zzsh");
    });
    await t.test("missing identity or firearm-owner contract never invents options or writes", async () => {
      await mount({ missing: true }); assert.match(document.body.textContent, /完整皮肤身份/); const createBtn = byText("新增皮肤"); assert.ok(createBtn === undefined || createBtn.disabled === true); assert.equal(writes.length, 0);
      for (const option of [{ missingFirearms: true }, { badFirearms: true }]) {
        await mount(option); await click("确认身份", row("pending")); await fill("皮肤类型", "FIREARM"); assert.match(document.body.textContent, /枪械归属未接入/); assert.equal(field("所属对象").disabled, true); await review(); await fill("皮肤本名", "Name"); await click("保存", document.querySelector('[role="dialog"]')); assert.equal(writes.length, 0); assert.ok(!reads.some(p => p.endsWith('/firearms')));
      }
    });
    await t.test("catalog-only administrator confirms FIREARM through returned catalog ids", async () => {
      await mount(); await click("确认身份", row("pending")); await fill("皮肤类型", "FIREARM"); await fill("所属对象", "Gun"); await fill("皮肤本名", "Gun base"); await review(); await click("保存", document.querySelector('[role="dialog"]'));
      assert.deepEqual(writes[0].body.ownerRef, { kind: "FIREARM", id: "gun" }); assert.ok(!("name" in writes[0].body)); assert.match(document.body.textContent, /Gun-Gun base/);
      assert.ok(!identity.permissions.includes("supply.gunsmith.manage")); assert.ok(!reads.some(path => path.endsWith("/firearms")));
    });
    await t.test("late catalog GET cannot expose the prior identity and permission loss starts no new reads", async () => {
      await mount(); model.skins[0].name = "Private old catalog"; policy = "delay-read";
      await act(async () => root.render(createElement(View, { snapshot: identity, refreshNonce: 1, onDirtyChange: value => dirty.push(value) }))); const resolve = pendingRead; assert.ok(resolve);
      model.skins[0].name = "Current identity catalog";
      await act(async () => root.render(createElement(View, { snapshot: actor("admin-b"), onDirtyChange: value => dirty.push(value) }))); await flush(); await act(async () => resolve());
      assert.doesNotMatch(document.body.textContent, /Private old catalog/); assert.match(document.body.textContent, /Current identity catalog/);
      const readCount = reads.length;
      await act(async () => root.render(createElement(View, { snapshot: { ...actor("admin-b"), permissions: [] }, onDirtyChange: value => dirty.push(value) })));
      assert.match(document.body.textContent, /没有供给目录维护权限/); assert.equal(reads.length, readCount); assert.equal(writes.length, 0);
    });
    await t.test("409 preserves modified input, requires explicit version adoption and a new key", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Kept input"); await fill("操作原因", "Row reason"); policy = "conflict"; await saveRow(); assert.equal(field("名称").value, "Kept input"); assert.equal(writes[0].body.expectedCatalogRevision, "10"); assert.equal(byText("保存").disabled, true);
      policy = "ok"; await click("读取最新目录"); assert.equal(writes.length, 1); assert.equal(field("名称").value, "Kept input"); await click("采用当前版本并保留输入"); await saveRow(); assert.equal(writes[1].body.expectedCatalogRevision, "11"); assert.notEqual(writes[1].key, writes[0].key); assert.equal(writes[1].body.name, "Kept input");
    });
    await t.test("409 adoption preserves concurrent metadata while keeping only the operator's edited fields", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Alias-only editing"); await fill("操作原因", "Keep concurrent metadata"); policy = "conflict"; await saveRow();
      Object.assign(model.skins.find(skin => skin.id === "legacy"), { isCollectible: true, defaultState: "NON_DEFAULT" });
      policy = "ok"; await click("读取最新目录"); await click("采用当前版本并保留输入"); await saveRow();
      assert.equal(writes[1].body.name, "Alias-only editing");
      assert.equal(Object.hasOwn(writes[1].body, "isCollectible"), false); assert.equal(Object.hasOwn(writes[1].body, "defaultState"), false);
    });
    await t.test("Delta melee confirms a standalone appearance without a parent selector or pending-parent warning", async () => {
      await mount(); await click("确认身份", row("pending")); await fill("皮肤类型", "MELEE_TYPE");
      const dialog = document.querySelector('[role="dialog"]');
      assert.equal(dialog.querySelector('[aria-label="所属对象"]'), null); assert.match(dialog.textContent, /近战外观独立维护/); assert.doesNotMatch(dialog.textContent, /刀型|具体.*待核/);
      await fill("皮肤本名", "Synthetic melee"); await review(); await click("保存", dialog);
      assert.equal(writes.length, 1); assert.equal(writes[0].body.ownerKind, "MELEE_TYPE"); assert.equal(writes[0].body.ownerRef, null);
    });

    await t.test("Delta owner maintenance hides legacy melee rows and offers only agent creation", async () => {
      await mount(); await click("所属对象");
      assert.match(document.querySelector('tbody').textContent, /agent_code/); assert.doesNotMatch(document.querySelector('tbody').textContent, /melee_code|Blade/);
      await click("新增所属对象"); await act(async () => field("所属对象类型").click()); await flush();
      const options = [...document.querySelectorAll('[role="option"]')]; assert.equal(options.length, 1); assert.match(options[0].textContent, /干员/);
      assert.equal(writes.length, 0);
    });
    for (const mode of ["network", "invalid-receipt"]) await t.test(`${mode} restores the original method/body/key even after catalog refresh`, async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Unknown result"); await fill("操作原因", "Row reason"); policy = mode; await saveRow(); assert.equal(field("名称").disabled, true); assert.ok(byText("核对原提交")); model.game.catalogRevision = "99";
      await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: value => dirty.push(value), refreshNonce: 1 })));
      await click("核对原提交"); assert.equal(writes.length, 2); assert.equal(writes[0].raw, writes[1].raw); assert.equal(writes[0].key, writes[1].key); assert.equal(writes[1].body.expectedCatalogRevision, "10"); assert.equal(model.game.catalogRevision, "99", "recovery does not create a second mutation");
    });
    await t.test("closing UNKNOWN keeps original recovery and blocks a new create", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Unknown close recovery"); await fill("操作原因", "Row reason"); policy = "network"; await saveRow();
      const original = structuredClone(writes[0]); assert.ok(byText("核对原提交"));
      await click("关闭编辑（稍后核对原结果）"); assert.ok(byText("核对原提交")); assert.equal(byText("新增皮肤").disabled, true);
      await click("核对原提交"); assert.equal(writes.length, 2); assert.deepEqual(writes[1], original, "recovery reuses the original request instead of creating a new one");
    });
    await t.test("closing SAVING keeps the original intent recoverable after response loss", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Saving close recovery"); await fill("操作原因", "Row reason");
      const baseFetch = globalThis.fetch; let release;
      globalThis.fetch = async (input, init = {}) => {
        if (init.method && init.method !== "GET") await new Promise(resolve => { release = resolve; });
        return baseFetch(input, init);
      };
      try {
        policy = "network"; await saveRow(); assert.ok(release, "the initial POST is in flight");
        await click("关闭编辑（稍后核对原结果）");
        assert.equal(byText("新增皮肤").disabled, true, "closing does not open a second operation");
        release(); await flush();
        const original = structuredClone(writes[0]);
        assert.ok(byText("核对原提交"), "the lost result remains recoverable after close");
        globalThis.fetch = baseFetch;
        await click("核对原提交"); await flush();
        const replay = writes[1]; assert.ok(replay); assert.equal(writes.length, 2); assert.equal(replay.raw, original.raw); assert.equal(replay.key, original.key);
      } finally { globalThis.fetch = baseFetch; }
    });
    await t.test("retrying UNKNOWN remains recoverable through close and tab change", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Retry close recovery"); await fill("操作原因", "Row reason"); policy = "network"; await saveRow();
      const original = structuredClone(writes[0]); await click("关闭编辑（稍后核对原结果）");
      const baseFetch = globalThis.fetch; let release; let loseRetryResponse = true;
      globalThis.fetch = async (input, init = {}) => {
        if (init.method && init.method !== "GET") {
          await new Promise(resolve => { release = resolve; });
          const response = await baseFetch(input, init);
          if (loseRetryResponse) { loseRetryResponse = false; throw new Error("lost retry response"); }
          return response;
        }
        return baseFetch(input, init);
      };
      try {
        policy = "ok"; await click("核对原提交"); await flush(); assert.ok(release);
        await click("计费物品"); assert.equal(byText("新增计费物品").disabled, true, "tab change cannot open a new operation while retrying");
        release(); await flush(); await flush(); assert.ok(byText("核对原提交"), "a lost retry remains recoverable");
        globalThis.fetch = baseFetch; await click("核对原提交"); await flush();
        assert.equal(writes.length, 3); assert.equal(writes[1].raw, original.raw); assert.equal(writes[1].key, original.key); assert.equal(writes[2].raw, original.raw); assert.equal(writes[2].key, original.key);
      } finally { globalThis.fetch = baseFetch; }
    });
    await t.test("successful write with failed readback retries only GET", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Committed"); await fill("操作原因", "Row reason"); policy = "readback-fail"; await saveRow(); assert.match(document.body.textContent, /提交已成功/); assert.ok(byText("重新读取目录")); assert.equal(writes.length, 1); await click("重新读取目录"); assert.equal(writes.length, 1); assert.match(document.body.textContent, /Committed/);
    });
    await t.test("duplicate submit and identity/object/unmount changes isolate delayed responses", async () => {
      for (const change of ["identity", "object", "game", "unmount"]) {
        await mount(); await click("编辑", row("legacy")); await fill("名称", "Late original"); await fill("操作原因", "Row reason"); policy = "delay"; await saveRow(); await saveRow(); assert.equal(writes.length, 1); const resolve = pending; assert.ok(resolve);
        if (change === "identity") await act(async () => root.render(createElement(View, { snapshot: actor("admin-b"), onDirtyChange: value => dirty.push(value) })));
        if (change === "object") { await click("关闭编辑（稍后核对原结果）"); const pendingEdit = byText("编辑", row("pending")); assert.equal(pendingEdit.disabled, true, "an unresolved write blocks switching to a new object"); }
        if (change === "game") await fill("游戏", "Other game");
        if (change === "unmount") { await act(async () => root.unmount()); root = null; }
        await act(async () => resolve()); await flush(); assert.equal(writes.length, 1);
        if (change === "object") assert.match(document.body.textContent, /皮肤已保存/);
        else assert.doesNotMatch(document.body.textContent, /皮肤已保存/);
      }
    });
    await t.test("owner create is narrow and item media binding only writes on save", async () => {
      await mount(); await click("所属对象"); await click("新增所属对象"); await fill("稳定 code", "new_owner"); await fill("名称", "New owner"); await fill("所属对象类型", "AGENT"); await fill("操作原因", "Owner create"); await click("详情"); await review(); await click("保存", document.querySelector('[role="dialog"]') ); assert.match(writes[0].path, /skin-owners$/); assert.equal(writes[0].body.kind, "AGENT"); assert.ok(!("sourceField" in writes[0].body));
      await click("计费物品"); const itemRow = [...document.querySelectorAll('tbody tr')][0]; await click("编辑", itemRow); await click("详情", itemRow); await click("绑定图片"); assert.ok(reads.some(p => p.includes('media-options'))); assert.match(document.body.textContent, /没有可绑定图片/); await click("取消");
    });
    await t.test("skin row reuses the public SKIN_MEDIA picker and sends a binding only on save", async () => {
      await mount(); await click("编辑", row("verified")); await click("详情", row("verified")); await click("绑定图片");
      assert.ok(reads.some(p => p.includes("media-options") && p.includes("SKIN_MEDIA")));
      const candidate = buttons().find(button => button.textContent.includes("skin-media"));
      assert.ok(candidate, "skin media candidate");
      await act(async () => candidate.click());
      assert.equal(writes.length, 0);
      await fill("操作原因", "Media bind");
      await click("保存", document.querySelector('[role="dialog"]'));
      assert.equal(writes[0].body.mediaId, "skin-media");
    });
    await t.test("dirty row edit blocks object switch until discarded or kept", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Guarded draft");
      await click("品质");
      assert.match(document.body.textContent, /切换将放弃未保存修改/);
      await click("保留编辑");
      assert.equal(field("名称").value, "Guarded draft");
      await click("品质"); await click("放弃修改并切换");
      assert.equal(writes.length, 0);
      assert.match(document.body.textContent, /品质/);
    });
    await t.test("Sheet close protects aliases together with row input", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Kept row"); await click("详情", row("legacy")); await fill("别名（每行一个）", "Kept alias");
      await act(async () => document.querySelector('[aria-label="关闭详细信息"]').click());
      assert.match(document.body.textContent, /放弃未保存修改/); await click("继续编辑");
      assert.equal(field("别名（每行一个）").value, "Kept alias"); assert.equal(field("名称").value, "Kept row");
      await act(async () => document.querySelector('[aria-label="关闭详细信息"]').click()); await click("放弃修改");
      assert.equal(writes.length, 0); assert.ok(!document.querySelector('[data-editing="true"]'));
    });
    await t.test("UNKNOWN survives refresh; persisted commands recover with authorized GET only", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Persisted original"); await fill("操作原因", "Original reason"); policy = "network"; await saveRow();
      const original = structuredClone(writes[0]), stored = JSON.parse(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"));
      assert.equal(stored.key, original.key); assert.equal(stored.body.expectedCatalogRevision, "10"); assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
      await remount(); assert.ok(byText("核对原提交")); assert.equal(byText("新增皮肤").disabled, true);
      await click("核对原提交"); assert.equal(writes.length, 1); assert.ok(reads.some(path => path.includes("/operation-result?") && path.includes("supply.catalog.skins.update") && path.includes(`fingerprint=${stored.fingerprint}`)));
      assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), null); assert.equal(model.game.catalogRevision, "11");
    });
    await t.test("UNKNOWN stays visible across games without opening new writes", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Across games"); await fill("操作原因", "Original reason"); policy = "network"; await saveRow();
      await fill("游戏", "Other game"); assert.match(document.body.textContent, /另一游戏有待核提交/); assert.equal(byText("核对原提交").disabled, true); assert.equal(byText("新增皮肤").disabled, true);
      assert.equal(writes.length, 1); await click("返回原游戏核对"); await click("核对原提交"); assert.equal(writes.length, 1); assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), null);
    });
    await t.test("identity isolation and rejected recovery preserve original intent", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Actor A original"); await fill("操作原因", "Private operation reason"); policy = "network"; await saveRow();
      const key = "zzsh.admin.catalog.pending.v1:admin-a", original = browser.localStorage.getItem(key);
      await remount(actor("admin-b")); assert.ok(!byText("核对原提交")); assert.equal(browser.localStorage.getItem(key), original);
      await remount({ ...identity, permissions: [] }); assert.match(document.body.textContent, /没有供给目录维护权限/); assert.doesNotMatch(document.body.textContent, /Private operation reason/); assert.equal(browser.localStorage.getItem(key), original);
      await remount(identity); policy = "recovery-denied"; await click("核对原提交"); assert.ok(byText("核对原提交")); assert.equal(byText("新增皮肤").disabled, true); assert.equal(writes.length, 1); assert.equal(browser.localStorage.getItem(key), original);
      policy = "ok"; await click("核对原提交"); assert.equal(writes.length, 1);
    });
    await t.test("accepted readback failure survives refresh and never repeats POST", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Accepted original"); await fill("操作原因", "Original reason"); policy = "readback-fail"; await saveRow();
      assert.equal(JSON.parse(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a")).accepted, true);
      await remount(); assert.ok(byText("重新读取目录")); assert.ok(!byText("核对原提交")); await click("重新读取目录"); assert.equal(writes.length, 1); assert.ok(reads.some(path => path.includes("operation-result"))); assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), null);
    });
    await t.test("storage write failure blocks the command before HTTP", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Not sent"); await fill("操作原因", "Original reason");
      const storage = browser.localStorage, original = Object.getOwnPropertyDescriptor(browser, "localStorage");
      Object.defineProperty(browser, "localStorage", { configurable: true, get: () => ({ getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error("storage unavailable"); } }) });
      try { await saveRow(); assert.equal(writes.length, 0); assert.equal(byText("新增皮肤").disabled, true); }
      finally { Object.defineProperty(browser, "localStorage", original); }
    });
    await t.test("unresolved or tampered recovery never creates a replacement command", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Unknown original"); await fill("操作原因", "Original reason"); policy = "network"; await saveRow();
      receipts.clear(); await remount(); await click("核对原提交"); assert.match(document.body.textContent, /不能据此判定未执行/); assert.equal(writes.length, 1);
      const key = "zzsh.admin.catalog.pending.v1:admin-a", stored = JSON.parse(browser.localStorage.getItem(key)); stored.body.name = "Tampered body"; browser.localStorage.setItem(key, JSON.stringify(stored));
      await remount(); const count = reads.filter(path => path.includes("operation-result")).length; await click("核对原提交"); assert.match(document.body.textContent, /指纹不匹配/); assert.equal(reads.filter(path => path.includes("operation-result")).length, count); assert.equal(writes.length, 1); assert.equal(byText("新增皮肤").disabled, true);
    });
    await t.test("low-frequency game creation shares durable original-key recovery", async () => {
      await mount(); identity = { ...identity, security: { ...identity.security, isBoss: true } }; await remount(identity);
      await click("管理游戏"); await fill("稳定 code", "new_game"); await fill("名称", "New game"); policy = "network"; await click("创建游戏");
      assert.equal(writes.length, 1); const original = structuredClone(writes[0]); assert.equal(original.path, "/api/bff/admin/supply/games");
      await remount(identity); assert.ok(byText("核对原提交")); await click("核对原提交"); assert.equal(writes.length, 1);
      const recovery = reads.find(path => path.includes("operation=supply.game.create")); assert.ok(recovery); assert.ok(!recovery.includes("resourceId=")); assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), null);
    });
    await t.test("fingerprints follow the backend operation, original resource and exact raw body", async () => {
      const { catalogFingerprint, parsePendingCatalog } = await vite.ssrLoadModule("/src/views/supply-catalog/model.ts");
      const body = { expectedCatalogRevision: "10", aliases: [" a ", "B"], reason: "中文原因" };
      for (const [kind, id, operation, resource] of [["skins", "legacy", "supply.catalog.skins.update", "legacy"], ["skin-owners", undefined, "supply.catalog.skin_owners.create", "game"], ["games", undefined, "supply.game.create", null]]) {
        assert.equal(await catalogFingerprint({ kind, id, gameId: "game", body }), createHash("sha256").update(JSON.stringify([operation, resource, body])).digest("hex"));
      }
      assert.throws(() => parsePendingCatalog(JSON.stringify({ schema: 1, adminId: "admin-a", gameId: "game", kind: "skins", method: "POST", path: "/supply/games/game/items", key: "idem_key", body, fingerprint: "a".repeat(64), accepted: false }), "admin-a"), /无法识别/);
    });
    await t.test("stopping a catalog item requires an explicit confirmation and cancel sends nothing", async () => {
      await mount(); await click("计费物品"); await click("停用"); assert.equal(writes.length, 0); assert.match(document.body.textContent, /停用计费物品/); await click("取消", document.querySelector('[role="dialog"]')); assert.equal(writes.length, 0); assert.equal(model.items[0].enabled, true);
    });
    await t.test("conflicted input still guards object switch and new editors", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Conflicted draft"); await fill("操作原因", "Row reason"); policy = "conflict"; await saveRow();
      assert.equal(byText("新增皮肤").disabled, true); await click("品质"); assert.match(document.body.textContent, /切换将放弃未保存修改/); await click("保留编辑"); assert.equal(field("名称").value, "Conflicted draft"); assert.equal(writes.length, 1);
    });
    await t.test("initial game preference uses returned stable code and keeps an existing choice", async () => {
      const { preferredCatalogGame } = await vite.ssrLoadModule("/src/views/supply-catalog/model.ts");
      const testGame = (id, code, enabled) => ({ id, code, name: id, enabled });
      const values = [testGame("local", "a_fixture", true), testGame("delta-id", "delta", true)];
      assert.equal(preferredCatalogGame(values, "", true), "delta-id"); assert.equal(preferredCatalogGame(values, "local", true), "local"); assert.equal(preferredCatalogGame(values, "", false), "local");
      assert.equal(preferredCatalogGame([testGame("off", "delta", false), values[0]], "", true), "local"); assert.equal(preferredCatalogGame([testGame("off", "other", false)], "", true), "off"); assert.equal(preferredCatalogGame([], "", true), "");
    });
    await t.test("late fingerprint rejection cannot replace the new scope pending state", async () => {
      const originalDigest = crypto.subtle.digest;
      for (const change of ["identity", "game"]) {
        await mount(); await click("编辑", row("legacy")); await fill("名称", "Old actor draft"); await fill("操作原因", "Original reason");
        let rejectDigest; crypto.subtle.digest = () => new Promise((_, reject) => { rejectDigest = reject; });
        try {
          await saveRow(); assert.ok(rejectDigest); assert.equal(writes.length, 0);
          const adminId = change === "identity" ? "admin-b" : "admin-a", targetGame = change === "game" ? "other" : "game", body = { name: "New scope pending", expectedCatalogRevision: "10" };
          const record = { schema: 1, adminId, gameId: targetGame, kind: "skins", id: "legacy", path: "/supply/skins/legacy", method: "PUT", body, key: "idem_newscope", fingerprint: createHash("sha256").update(JSON.stringify(["supply.catalog.skins.update", "legacy", body])).digest("hex"), accepted: false };
          browser.localStorage.setItem(`zzsh.admin.catalog.pending.v1:${adminId}`, JSON.stringify(record));
          if (change === "identity") await act(async () => root.render(createElement(View, { snapshot: actor("admin-b"), onDirtyChange: value => dirty.push(value) })));
          else await fill("游戏", "Other game");
          await flush(); assert.ok(byText("核对原提交")); rejectDigest(new Error("old fingerprint rejected")); await flush();
          assert.ok(byText("核对原提交")); assert.equal(byText("新增皮肤").disabled, true); assert.doesNotMatch(document.body.textContent, /old fingerprint rejected/); assert.equal(writes.length, 0);
        } finally { crypto.subtle.digest = originalDigest; }
      }
    });
    await t.test("game 2xx bad identities or missing readback remain accepted and never repeat POST", async () => {
      for (const mode of ["game-empty-id", "game-wrong-code", "game-missing-readback"]) {
        await mount(); identity = { ...identity, security: { ...identity.security, isBoss: true } }; await remount(identity);
        await click("管理游戏"); await fill("稳定 code", "new_game"); await fill("名称", "New game"); policy = mode; await click("创建游戏");
        const key = "zzsh.admin.catalog.pending.v1:admin-a"; assert.equal(writes.length, 1); assert.equal(JSON.parse(browser.localStorage.getItem(key)).accepted, true); assert.ok(byText("重新读取目录"));
        if (mode === "game-missing-readback") { await click("重新读取目录"); assert.ok(browser.localStorage.getItem(key)); createdGames = [{ ...model.game, id: "created-game", code: "new_game" }]; }
        policy = "ok"; await click("重新读取目录"); assert.equal(writes.length, 1); assert.equal(browser.localStorage.getItem(key), null);
      }
    });
    await t.test("an unavailable cross-window lock sends no new command and keeps the draft", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Locked draft"); await fill("操作原因", "Original reason");
      const lockName = "zzsh:supply-write:zzsh.admin.catalog.pending.v1:admin-a"; heldSupplyLocks.add(lockName);
      try { await saveRow(); assert.equal(writes.length, 0); assert.equal(field("名称").value, "Locked draft"); assert.match(document.body.textContent, /另一窗口/); assert.match(document.body.textContent, /本次请求尚未发送/); assert.doesNotMatch(document.body.textContent, /未能确认提交结果/); assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), null); }
      finally { heldSupplyLocks.delete(lockName); }
      await saveRow(); assert.equal(writes.length, 1);
    });
    await t.test("the lock spans readback and never clears another slot occupant", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Original locked write"); await fill("操作原因", "Original reason");
      const baseFetch = globalThis.fetch, key = "zzsh.admin.catalog.pending.v1:admin-a", lockName = `zzsh:supply-write:${key}`;
      let releaseReadback;
      globalThis.fetch = async (input, init = {}) => {
        if ((!init.method || init.method === "GET") && String(input).endsWith("/catalog") && writes.length === 1) await new Promise(resolve => { releaseReadback = resolve; });
        return baseFetch(input, init);
      };
      try {
        await saveRow(); await flush(); assert.ok(releaseReadback); assert.equal(writes.length, 1); assert.ok(heldSupplyLocks.has(lockName), "the write lock remains held until readback settles");
        const original = JSON.parse(browser.localStorage.getItem(key)), other = { ...original, key: "idem_other_window", accepted: false }, rawOther = JSON.stringify(other);
        browser.localStorage.setItem(key, rawOther);
        await act(async () => releaseReadback()); await flush(); assert.ok(!heldSupplyLocks.has(lockName)); assert.equal(browser.localStorage.getItem(key), rawOther); assert.ok(byText("重新读取目录"));
        globalThis.fetch = baseFetch; const recoveryCount = reads.filter(path => path.includes("operation-result")).length; await click("重新读取目录");
        assert.equal(reads.filter(path => path.includes("operation-result")).length, recoveryCount); assert.equal(writes.length, 1); assert.equal(browser.localStorage.getItem(key), rawOther); assert.match(document.body.textContent, /另一窗口已保存其它原提交/);
      } finally { releaseReadback?.(); globalThis.fetch = baseFetch; }
    });
    await t.test("skin Dialog closure restores a live row action or the list heading", async () => {
      const settleFocus = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
      await mount(); let opener = byText("详情", row("legacy")); opener.focus(); await click("详情", row("legacy"));
      assert.equal(opener.isConnected, true, "Dialog keeps its original row trigger live");
      await click("取消", document.querySelector('[data-slot="dialog-content"]')); await settleFocus();
      assert.equal(document.activeElement === byText("详情", row("legacy")), true, "cancel returns to the recreated live detail entry");
      opener = byText("详情", row("legacy")); opener.focus(); await click("详情", row("legacy"));
      assert.equal(document.querySelector('[data-editing="true"]'), null, "skin editing stays in one Dialog, not duplicate row inputs");
      await click("取消", document.querySelector('[data-slot="dialog-content"]')); await settleFocus(); assert.equal(document.activeElement === opener, true);
      await click("详情", row("legacy")); model.skins = model.skins.filter(skin => skin.id !== "legacy");
      await act(async () => root.render(createElement(View, { snapshot: identity, refreshNonce: 1, onDirtyChange: value => dirty.push(value) })));
      await click("取消", document.querySelector('[data-slot="dialog-content"]')); await settleFocus();
      const heading = [...document.querySelectorAll("h4")].find(node => node.textContent.trim() === "皮肤"); assert.ok(heading); assert.equal(document.activeElement === heading, true, "missing source row falls back to the stable list heading");
      assert.equal(writes.length, 0);
    });
    await t.test("dirty keep preserves Dialog focus; unresolved close returns to a safe heading", async () => {
      const settleFocus = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
      await mount(); await click("详情", row("legacy")); await fill("别名（每行一个）", "Unsubmitted alias");
      await click("取消", document.querySelector('[data-slot="dialog-content"]')); await click("继续编辑"); await settleFocus();
      assert.equal(document.querySelector('[data-slot="dialog-content"]').contains(document.activeElement), true); assert.equal(field("别名（每行一个）").value, "Unsubmitted alias");
      await click("取消", document.querySelector('[data-slot="dialog-content"]')); await click("放弃修改"); await settleFocus();
      assert.equal(document.activeElement === byText("详情", row("legacy")), true); assert.equal(writes.length, 0);
      await click("详情", row("legacy")); await fill("别名（每行一个）", "Unknown alias"); policy = "network"; await click("保存", document.querySelector('[data-slot="dialog-content"]'));
      const original = browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"); assert.ok(original); await click("关闭编辑（稍后核对原结果）", document.querySelector('[data-slot="dialog-content"]')); await settleFocus();
      const heading = [...document.querySelectorAll("h4")].find(node => node.textContent.trim() === "皮肤"); assert.equal(document.activeElement === heading, true);
      assert.equal(byText("详情", row("legacy")).disabled, true); assert.ok(byText("核对原提交")); assert.equal(browser.localStorage.getItem("zzsh.admin.catalog.pending.v1:admin-a"), original); assert.equal(writes.length, 1);
    });
    await t.test("mobile main-column details returns to the rebuilt main-column entry", async () => {
      const previousSize = { width: browser.innerWidth, height: browser.innerHeight };
      try {
        await act(async () => browser.happyDOM.setWindowSize({ width: 390, height: 844 })); await mount();
        const opener = row("legacy").querySelector('[aria-label="查看详情 旧名 legacy"]'); assert.ok(opener); await act(async () => opener.click());
        assert.equal(opener.isConnected, true); await click("取消", document.querySelector('[data-slot="dialog-content"]'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
        const replacement = row("legacy").querySelector('[aria-label="查看详情 旧名 legacy"]'); assert.equal(document.activeElement === replacement, true, "mobile details keeps focus in the main column rather than the offscreen action column"); assert.equal(writes.length, 0);
      } finally { await act(async () => browser.happyDOM.setWindowSize(previousSize)); }
    });
  } finally {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = originalFetch; await vite.close(); await browser.happyDOM.abort();
  }
});
