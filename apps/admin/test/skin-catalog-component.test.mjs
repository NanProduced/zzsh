import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("actual catalog editor: skin identity, version conflicts and fixed request recovery", async t => {
  const browser = new Window({ url: "http://127.0.0.1:3101/supply/catalog" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import("react-dom/client");
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  let root, el, model, writes, reads, policy, pending, pendingRead, readFailure, identity, receipts;
  const dirty = [];
  const actor = (id = "admin-a", gunsmith = false) => ({ authenticated: true, adminUserId: id, security: { status: "ACTIVE", isBoss: false }, session: { id: "session-" + id, locked: false }, permissions: ["supply.catalog.manage", ...(gunsmith ? ["supply.gunsmith.manage"] : [])] });
  const skin = (id, namingState) => ({ id, code: "code_" + id, name: namingState === "VERIFIED" ? "Agent-Old" : "旧名 " + id, categoryId: "category", rarityCode: null, enabled: namingState !== "PENDING", formVisible: namingState !== "PENDING", mediaId: null, sortOrder: 0, sourceNamespace: null, sourceField: "agent_skin", sourceToken: " raw " + id + " ", aliases: [], baseName: namingState === "VERIFIED" ? "Old" : null, ownerRef: namingState === "VERIFIED" ? { kind: "AGENT", id: "agent" } : null, namingState });
  const fresh = () => ({ game: { id: "game", code: "delta", name: "Fixture game", enabled: true, catalogRevision: "10" }, items: [{ id: "item", code: "item_code", name: "Existing item", unit: "PIECE", quantityScale: 0, required: false, sortOrder: 0, enabled: true, mediaId: null }], rarities: [], categories: [{ id: "category", code: "category", name: "Display category", parentId: null, enabled: true, formVisible: true, sortOrder: 0 }], skins: [skin("legacy", "LEGACY"), skin("verified", "VERIFIED"), skin("pending", "PENDING")], entitlements: [], owners: [{ id: "agent", kind: "AGENT", code: "agent_code", name: "Agent", enabled: true }, { id: "melee", kind: "MELEE_TYPE", code: "melee_code", name: "Blade", enabled: true }] });
  const byText = (text, node = el) => [...node.querySelectorAll("button")].find(b => b.textContent.trim() === text);
  const row = id => [...el.querySelectorAll("tbody tr")].find(r => r.querySelector("td")?.textContent === id);
  const field = label => {
    const node = [...el.querySelectorAll("label")].find(l => l.querySelector("span")?.textContent === label);
    assert.ok(node, "field " + label); return node.querySelector("input,select,textarea");
  };
  const click = async (text, node = el) => { const b = byText(text, node); assert.ok(b, "button " + text); await act(async () => b.click()); };
  const fill = async (label, value) => act(async () => {
    const node = field(label), prototype = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : node.tagName === "SELECT" ? browser.HTMLSelectElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const submit = async () => act(async () => el.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const review = async () => { await fill("操作原因", "Reviewed mapping"); await fill("证据链接（每行一条，最多8条）", "https://example.org/one\nhttps://example.org/two"); await fill("证据核对日期", "2026-09-26"); await fill("适用地区", "CN"); await fill("证据说明", "Synthetic relation and exact legacy token reviewed"); };
  function apply(path, body) {
    model.game.catalogRevision = String(Number(model.game.catalogRevision) + 1);
    const kind = path.includes("skin-owners") ? "owners" : "skins";
    let record = model[kind].find(r => path.endsWith("/" + r.id));
    if (!record) { record = kind === "skins" ? { ...skin("created", "PENDING"), ...body, id: "created", sourceNamespace: null, sourceField: null, sourceToken: null } : { id: "created-owner", ...body, enabled: true }; model[kind].push(record); }
    else {
      Object.assign(record, body);
      if (body.confirmIdentity) { record.namingState = "VERIFIED"; record.name = (body.ownerRef.kind === "FIREARM" ? "Gun" : model.owners.find(o => o.id === body.ownerRef.id)?.name) + "-" + body.baseName; }
    }
    return { id: record.id, code: record.code, catalogRevision: model.game.catalogRevision, ...(kind === "skins" ? { namingState: record.namingState } : { kind: record.kind, enabled: record.enabled }) };
  }
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), browser.location.href).pathname;
    if (!init.method || init.method === "GET") {
      reads.push(path);
      if (path.endsWith("/games")) return Response.json({ games: [model.game, { ...model.game, id: "other", name: "Other game" }] });
      if (path.includes("media-options")) return Response.json({ items: [], nextCursor: null, limit: 20 });
      if (path.endsWith("/firearms")) return policy === "gun-denied" ? Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }) : Response.json({ firearms: [{ id: "gun", gameId: "game", name: "Gun", enabled: true }] });
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
    if (policy === "readback-fail") { policy = "ok"; readFailure = true; }
    return Response.json(result);
  };
  let View;
  async function mount(options = {}) {
    if (root) { await act(async () => root.unmount()); el.remove(); }
    model = fresh(); if (options.missing) delete model.owners;
    writes = []; reads = []; receipts = new Map(); policy = "ok"; pending = null; pendingRead = null; readFailure = false; identity = actor("admin-a", Boolean(options.gunsmith));
    el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: value => dirty.push(value) })));
    await flush(); assert.ok(byText("皮肤")); await click("皮肤");
  }
  try {
    ({ SupplyCatalogView: View } = await vite.ssrLoadModule("/src/views/supply-catalog-view.tsx"));
    await t.test("creates disabled draft, then separately confirms with reason/evidence and server name", async () => {
      await mount(); await click("新增皮肤"); await fill("稳定 code", "new_skin"); await fill("名称", "New raw"); await fill("分类", "category"); await fill("别名（每行一个）", "Alias A\nAlias B");
      await submit(); assert.equal(writes.length, 1); assert.deepEqual(writes[0].body.aliases, ["Alias A", "Alias B"]); assert.equal(writes[0].body.enabled, false); assert.equal(writes[0].body.formVisible, false); assert.equal(writes[0].body.expectedCatalogRevision, "10"); assert.ok(!("ownerRef" in writes[0].body));
      assert.match(el.textContent, /PENDING/); await click("确认身份", row("created")); await fill("所属对象", "agent"); await fill("皮肤本名", "Canonical"); await submit(); assert.equal(writes.length, 1, "missing reason/evidence never submits");
      await review(); await submit(); assert.equal(writes.length, 2); assert.deepEqual(writes[1].body.ownerRef, { kind: "AGENT", id: "agent" }); assert.equal(writes[1].body.evidenceRefs.length, 2); assert.equal(writes[1].body.confirmIdentity, true); assert.ok(!("name" in writes[1].body)); assert.ok(!("enabled" in writes[1].body)); assert.match(el.textContent, /Agent-Canonical/);
    });
    await t.test("LEGACY rename omits untouched null namespace/source; VERIFIED cannot send bare name", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Renamed"); await fill("操作原因", "Correction"); await submit(); assert.equal(writes[0].body.name, "Renamed"); for (const key of ["sourceNamespace", "sourceField", "sourceToken", "enabled", "namingState", "id", "code"]) assert.ok(!(key in writes[0].body), key);
      await click("编辑", row("verified")); assert.equal(field("名称").disabled, true); await fill("别名（每行一个）", "Verified alias"); await submit(); assert.ok(!("name" in writes[1].body)); assert.deepEqual(writes[1].body.aliases, ["Verified alias"]);
    });
    await t.test("source attaches only by explicit choice and keeps exact old token", async () => {
      await mount(); await click("编辑", row("legacy")); const box = el.querySelector('input[type="checkbox"]'); await act(async () => box.click()); await fill("来源命名空间", "legacy.sg_zzsh"); assert.equal(field("来源字段").readOnly, true); assert.equal(field("原始来源值").readOnly, true); await review(); await submit(); assert.equal(writes[0].body.sourceToken, " raw legacy "); assert.equal(writes[0].body.sourceField, "agent_skin"); assert.equal(writes[0].body.sourceNamespace, "legacy.sg_zzsh");
    });
    await t.test("missing contract and missing gunsmith capability do not invent options or write", async () => {
      await mount({ missing: true }); assert.match(el.textContent, /完整皮肤身份字段/); assert.equal(byText("新增皮肤").disabled, true); assert.equal(writes.length, 0);
      await mount(); await click("确认身份", row("pending")); await fill("所属对象类型", "FIREARM"); assert.match(el.textContent, /没有枪械目录读取权限/); assert.equal(field("所属对象").disabled, true); await review(); await fill("皮肤本名", "Name"); await submit(); assert.equal(writes.length, 0); assert.ok(!reads.some(p => p.endsWith('/firearms')));
      await mount({ gunsmith: true }); policy = "gun-denied"; await click("确认身份", row("pending")); await fill("所属对象类型", "FIREARM"); await click("读取枪械目录"); assert.match(el.textContent, /游戏范围无法读取/); assert.equal(field("所属对象").options.length, 1); assert.equal(writes.length, 0);
    });
    await t.test("authorized FIREARM selection uses actual returned ids and sends no display-name calculation", async () => {
      await mount({ gunsmith: true }); await click("确认身份", row("pending")); await fill("所属对象类型", "FIREARM"); await click("读取枪械目录"); await fill("所属对象", "gun"); await fill("皮肤本名", "Gun base"); await review(); await submit();
      assert.deepEqual(writes[0].body.ownerRef, { kind: "FIREARM", id: "gun" }); assert.ok(!("name" in writes[0].body)); assert.match(el.textContent, /Gun-Gun base/);
    });
    await t.test("late catalog GET cannot expose the prior identity and permission loss starts no new reads", async () => {
      await mount(); model.skins[0].name = "Private old catalog"; policy = "delay-read";
      await act(async () => root.render(createElement(View, { snapshot: identity, refreshNonce: 1, onDirtyChange: value => dirty.push(value) }))); const resolve = pendingRead; assert.ok(resolve);
      model.skins[0].name = "Current identity catalog";
      await act(async () => root.render(createElement(View, { snapshot: actor("admin-b"), onDirtyChange: value => dirty.push(value) }))); await flush(); await act(async () => resolve());
      assert.doesNotMatch(el.textContent, /Private old catalog/); assert.match(el.textContent, /Current identity catalog/);
      const readCount = reads.length;
      await act(async () => root.render(createElement(View, { snapshot: { ...actor("admin-b"), permissions: [] }, onDirtyChange: value => dirty.push(value) })));
      assert.match(el.textContent, /没有供给目录维护权限/); assert.equal(reads.length, readCount); assert.equal(writes.length, 0);
    });
    await t.test("409 preserves modified input, requires explicit version adoption and a new request", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Kept input"); await fill("操作原因", "Manual correction"); policy = "conflict"; await submit(); assert.equal(field("名称").value, "Kept input"); assert.equal(writes[0].body.expectedCatalogRevision, "10"); assert.equal(byText("保存").disabled, true);
      policy = "ok"; await click("读取最新目录"); assert.equal(writes.length, 1); assert.equal(field("名称").value, "Kept input"); await click("采用当前版本并保留输入"); await submit(); assert.equal(writes[1].body.expectedCatalogRevision, "11"); assert.notEqual(writes[1].key, writes[0].key); assert.equal(writes[1].body.name, "Kept input");
    });
    for (const mode of ["network", "invalid-receipt"]) await t.test(`${mode} restores the original method/body/key even after catalog refresh`, async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Unknown result"); await fill("操作原因", "Test"); policy = mode; await submit(); assert.equal(field("名称").closest('fieldset').disabled, true); assert.ok(byText("核对原提交")); model.game.catalogRevision = "99";
      await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: value => dirty.push(value), refreshNonce: 1 })));
      await click("核对原提交"); assert.equal(writes.length, 2); assert.equal(writes[0].raw, writes[1].raw); assert.equal(writes[0].key, writes[1].key); assert.equal(writes[1].body.expectedCatalogRevision, "10"); assert.equal(model.game.catalogRevision, "99", "recovery does not create a second mutation");
    });
    await t.test("closing UNKNOWN keeps original recovery and blocks a new create", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Unknown close recovery"); await fill("操作原因", "Test"); policy = "network"; await submit();
      const original = structuredClone(writes[0]); assert.ok(byText("核对原提交"));
      await click("关闭编辑（稍后核对原结果）"); assert.ok(byText("核对原提交")); assert.equal(byText("新增皮肤").disabled, true);
      await click("核对原提交"); assert.equal(writes.length, 2); assert.deepEqual(writes[1], original, "recovery reuses the original request instead of creating a new one");
    });
    await t.test("closing SAVING keeps the original intent recoverable after response loss", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Saving close recovery"); await fill("操作原因", "Test");
      const baseFetch = globalThis.fetch; let release;
      globalThis.fetch = async (input, init = {}) => {
        if (init.method && init.method !== "GET") await new Promise(resolve => { release = resolve; });
        return baseFetch(input, init);
      };
      try {
        policy = "network"; await submit(); assert.ok(release, "the initial POST is in flight");
        await click("关闭编辑（稍后核对原结果）");
        assert.equal(byText("新增皮肤").disabled, true, "closing does not open a second operation");
        release(); await flush();
        const original = structuredClone(writes[0]);
        assert.ok(byText("核对原提交"), "the lost result remains recoverable after close");
        globalThis.fetch = baseFetch;
        await click("核对原提交"); await flush();
        const replay = [...writes][1]; assert.ok(replay); assert.equal(writes.length, 2); assert.equal(replay.raw, original.raw); assert.equal(replay.key, original.key);
      } finally { globalThis.fetch = baseFetch; }
    });
    await t.test("retrying UNKNOWN remains recoverable through close and tab change", async () => {
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Retry close recovery"); await fill("操作原因", "Test"); policy = "network"; await submit();
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
      await mount(); await click("编辑", row("legacy")); await fill("名称", "Committed"); await fill("操作原因", "Test"); policy = "readback-fail"; await submit(); assert.match(el.textContent, /提交已成功/); assert.ok(byText("重新读取目录")); assert.equal(writes.length, 1); await click("重新读取目录"); assert.equal(writes.length, 1); assert.match(el.textContent, /Committed/);
    });
    await t.test("duplicate submit and identity/object/unmount changes isolate delayed responses", async () => {
      for (const change of ["identity", "object", "game", "unmount"]) {
        await mount(); await click("编辑", row("legacy")); await fill("名称", "Late original"); await fill("操作原因", "Test"); policy = "delay"; await submit(); await submit(); assert.equal(writes.length, 1); const resolve = pending; assert.ok(resolve);
        if (change === "identity") await act(async () => root.render(createElement(View, { snapshot: actor("admin-b"), onDirtyChange: value => dirty.push(value) })));
        if (change === "object") { await click("关闭编辑（稍后核对原结果）"); const pendingEdit = byText("编辑", row("pending")); assert.equal(pendingEdit.disabled, true, "an unresolved write blocks switching to a new object"); }
        if (change === "game") await fill("游戏", "other");
        if (change === "unmount") { await act(async () => root.unmount()); root = null; }
        await act(async () => resolve()); await flush(); assert.equal(writes.length, 1);
        if (change === "object") assert.match(el.textContent, /皮肤已保存/);
        else assert.doesNotMatch(el.textContent, /皮肤已保存/);
      }
    });
    await t.test("owner maintenance is narrow and existing item/media behavior remains available", async () => {
      await mount(); await click("所属对象"); await click("新增所属对象"); await fill("稳定 code", "new_owner"); await fill("名称", "New owner"); await fill("所属对象类型", "MELEE_TYPE"); await review(); await submit(); assert.match(writes[0].path, /skin-owners$/); assert.equal(writes[0].body.kind, "MELEE_TYPE"); assert.ok(!("sourceField" in writes[0].body));
      await click("计费物品"); await click("编辑", [...el.querySelectorAll('tbody tr')][0]); await click("选择图片"); assert.ok(reads.some(p => p.includes('media-options'))); assert.match(el.textContent, /没有可绑定图片/); await click("取消");
    });
  } finally {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = originalFetch; await vite.close(); await browser.happyDOM.abort();
  }
});
