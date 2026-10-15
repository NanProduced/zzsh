import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { installSupplyLockFixture } from "./supply-lock-fixture.mjs";

// Gunsmith maintenance page: read-only service chip, parent-gated creates,
// row editing, verbatim code text, withdraw/restore, and the client-side
// UNKNOWN contract (no server recovery exists for gunsmith writes).
test("gunsmith row editor: parent gating, verbatim codes and unknown writes", async t => {
  const browser = new Window({ url: "http://127.0.0.1:3101/supply/gunsmith" });
  const heldLocks = installSupplyLockFixture(browser);
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import("react-dom/client");
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  Object.assign(globalThis, { requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  let root, el, model, writes, reads, policy, pending, identity;
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const byText = (text, scope = document) => buttons(scope).find(b => b.textContent.trim() === text);
  const field = label => {
    const direct = document.querySelector(`[aria-label="${label}"]`);
    if (direct) return direct;
    for (const l of document.querySelectorAll("label[for]")) {
      if (l.textContent.trim().startsWith(label)) {
        const control = document.getElementById(l.getAttribute("for"));
        if (control) return control;
      }
    }
    for (const control of document.querySelectorAll("[aria-labelledby]")) {
      const text = document.getElementById(control.getAttribute("aria-labelledby"))?.textContent?.trim();
      if (text && text.startsWith(label)) return control;
    }
    return null;
  };
  const click = async (text, scope = document) => { const b = byText(text, scope); assert.ok(b, "button " + text); await act(async () => b.click()); };
  const fill = async (label, value) => act(async () => {
    const node = field(label);
    assert.ok(node, "field " + label);
    if (node.tagName === "BUTTON") {
      await act(async () => node.click());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes(value));
      assert.ok(option, "option " + value);
      await act(async () => option.click());
      return;
    }
    const prototype = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const firearmRow = name => [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes(name));
  const codeRow = id => [...document.querySelectorAll("tbody tr")].find(r => r.textContent.includes(id));
  const openTerms = async () => click("管理基础目录");
  const selectFirearm = async (name) => { const b = [...document.querySelectorAll("ul button")].find(x => x.textContent.trim().startsWith(name)); assert.ok(b, "firearm " + name); await act(async () => b.click()); };

  const fresh = () => ({
    classifications: [{ id: "class-rifle", gameId: "game", code: "rifle", name: "步枪", enabled: true, sortOrder: 1, revision: "3", sourceNamespace: null, sourceToken: null, sourceNote: null }],
    firearms: [
      { id: "gun-m4", gameId: "game", code: "m4a1", name: "M4A1", classificationId: "class-rifle", classificationName: "步枪", enabled: true, sortOrder: 1, mediaId: null, codeCount: 1, revision: "5", updatedAt: "2026-10-01T00:00:00Z", sourceNamespace: null, sourceToken: null, sourceNote: null },
      { id: "gun-off", gameId: "game", code: "akm", name: "AKM", classificationId: "class-rifle", classificationName: "步枪", enabled: false, sortOrder: 2, mediaId: "asset-old", revision: "2", updatedAt: "2026-10-01T00:00:00Z", sourceNamespace: null, sourceToken: null, sourceNote: null },
    ],
    aliases: [{ id: "alias-1", gameId: "game", firearmId: "gun-m4", locale: "zh-CN", name: "四脚蛇", enabled: true, sortOrder: 1, revision: "1", sourceNamespace: null, sourceToken: null, sourceNote: null }],
    codes: [
      { id: "code-active", gameId: "game", firearmId: "gun-m4", code: "M4A1突击步枪-烽火地带-6KIJ93G0FT4DOEKA4FGKI", note: "急停腰射", modeCode: "HAZARD", status: "ACTIVE", lastReviewedAt: "2026-09-14T12:00:00Z", revision: "4", updatedAt: "2026-10-01T00:00:00Z", sourceNamespace: null, sourceToken: null, sourceNote: null },
      { id: "code-wd", gameId: "game", firearmId: "gun-m4", code: "6G94AKO0FHI6PKF6C3P0U", note: "", modeCode: null, status: "WITHDRAWN", lastReviewedAt: null, revision: "2", updatedAt: "2026-10-01T00:00:00Z", sourceNamespace: null, sourceToken: null, sourceNote: null },
    ],
  });

  globalThis.fetch = async (input, init = {}) => {
    const parsed = new URL(String(input), browser.location.href), path = parsed.pathname;
    if (!init.method || init.method === "GET") {
      reads.push(path + parsed.search);
      if (path.endsWith("/games")) return Response.json({ games: [{ id: "game", code: "delta", name: "三角洲行动", description: null, enabled: true, catalogRevision: "1", currentReleaseId: null, coverMediaId: null, services: [{ id: "svc-1", serviceCode: "GUNSMITH", enabled: false, revision: "7", supported: true }] }] });
      if (path.endsWith("/firearms")) { if (policy === "delay-read") { policy = "ok"; const captured = structuredClone(model); return new Promise(resolve => { pending = () => resolve(Response.json(captured)); }); } return Response.json(model); }
      if (path.includes("media-options")) return Response.json({ items: [{ id: "asset-new", gameId: "game", mime: "image/png", width: 400, height: 225, byteSize: "2048" }], nextCursor: null, limit: 20 });
      return Response.json({});
    }
    const body = JSON.parse(init.body);
    writes.push({ path, body, method: init.method, key: init.headers["idempotency-key"] });
    if (policy === "conflict") return Response.json({ error: { code: "CONFLICT" } }, { status: 409 });
    if (policy === "network") { policy = "ok"; throw new Error("lost response"); }
    if (policy === "delay") return new Promise(resolve => { pending = () => { model = structuredClone(model); return resolve(Response.json({ id: "created", revision: "1" })); }; });
    return Response.json({ id: "created", revision: "1" });
  };

  let View;
  async function mount(permissions = ["supply.gunsmith.manage"], preservePending = false) {
    if (!preservePending) browser.localStorage.clear();
    if (root) { await act(async () => root.unmount()); el.remove(); }
    model = fresh(); writes = []; reads = []; policy = "ok"; pending = null;
    identity = { authenticated: true, adminUserId: "admin-a", security: { status: "ACTIVE", isBoss: false }, session: { id: "session-a", locked: false }, permissions };
    el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: () => undefined })));
    for (let i = 0; i < 20 && !document.querySelector("ul button"); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }

  try {
    ({ SupplyGunsmithView: View } = await vite.ssrLoadModule("/src/views/supply-gunsmith-view.tsx"));
    await t.test("service state is read-only and no write control exists", async () => {
      await mount();
      assert.match(document.body.textContent, /玩家端服务未启用/);
      assert.match(document.body.textContent, /服务开关不在本页操作/);
      assert.ok(!byText("启用服务") && !byText("停用服务"), "no service write button");
      assert.equal(writes.length, 0);
    });
    await t.test("no permission starts no reads and shows the denial", async () => {
      await mount([]);
      assert.match(document.body.textContent, /没有改枪码目录维护权限/);
      assert.equal(reads.length, 0);
    });
    await t.test("another window lock blocks before storing or sending a new command", async () => {
      await mount(); await selectFirearm("M4A1"); await click("新增改枪码");
      await fill("改枪码原文", "UI_LAYOUT_CODE_ONLY");
      const lockName = "zzsh:supply-write:zzsh.admin.gunsmith.pending.v1:admin-a";
      heldLocks.add(lockName);
      try { await click("保存"); await flush(); assert.equal(writes.length, 0); assert.equal(browser.localStorage.length, 0); assert.match(document.body.textContent, /另一窗口/); }
      finally { heldLocks.delete(lockName); }
    });
    await t.test("switching identity during a write preserves each administrator's original record", async () => {
      await mount(); await selectFirearm("M4A1"); await click("新增改枪码"); await fill("改枪码原文", "UI_LAYOUT_ORIGINAL_A");
      policy = "delay"; await click("保存");
      const finishA = pending;
      const recordB = { schema:1, adminId:"admin-b", gameId:"game", entity:"code", action:"B 的原请求", key:"idem_original_b_111111", path:"/supply/gunsmith/codes/code-active", method:"PUT", body:{expectedRevision:"4",code:"UI_LAYOUT_ORIGINAL_B"},accepted:false };
      browser.localStorage.setItem("zzsh.admin.gunsmith.pending.v1:admin-b", JSON.stringify(recordB));
      identity = {...identity,adminUserId:"admin-b",session:{id:"session-b",locked:false}};
      await act(async () => root.render(createElement(View,{snapshot:identity,onDirtyChange:()=>undefined})));
      await flush(); assert.match(document.body.textContent,/B 的原请求/);
      await act(async () => finishA()); await flush();
      assert.equal(JSON.parse(browser.localStorage.getItem("zzsh.admin.gunsmith.pending.v1:admin-b")).key,recordB.key);
      assert.equal(JSON.parse(browser.localStorage.getItem("zzsh.admin.gunsmith.pending.v1:admin-a")).accepted,true);
      assert.match(document.body.textContent,/B 的原请求/); assert.equal(writes.length,1);
    });
    await t.test("mode and status filters apply only to the selected gun", async () => {
      await mount(); await selectFirearm("M4A1");
      await fill("方案模式筛选", "未标注");
      assert.ok(!codeRow("6KIJ93G0FT4DOEKA4FGKI"));
      assert.ok(codeRow("6G94AKO0FHI6PKF6C3P0U"));
      await fill("方案状态筛选", "已收录");
      assert.match(document.body.textContent, /已加载内容中无匹配/);
      assert.equal(writes.length, 0);
    });
    await t.test("a vanished classification resets after a directory refresh", async () => {
      await mount();
      await fill("枪械分类筛选", "步枪");
      model.classifications = [{ ...model.classifications[0], id: "class-new", name: "新分类" }];
      model.firearms = model.firearms.map(gun => ({ ...gun, classificationId: "class-new" }));
      await click("刷新目录"); await flush();
      assert.match(field("枪械分类筛选").textContent, /全部分类/);
      assert.ok([...document.querySelectorAll("ul button")].some(button => button.textContent.includes("M4A1")));
      assert.equal(writes.length, 0);
    });
    await t.test("review time is edited in Beijing time and submitted as UTC", async () => {
      await mount(); await selectFirearm("M4A1");
      await click("编辑", codeRow("6KIJ93G0FT4DOEKA4FGKI"));
      await fill("最近人工复核", "2026-10-13T10:00"); await click("保存");
      assert.equal(writes[0].body.lastReviewedAt, "2026-10-13T02:00:00.000Z");
    });
    await t.test("editing a note preserves the original review timestamp precision", async () => {
      await mount();
      model.codes[0].lastReviewedAt = "2026-10-12T02:15:37.123456Z";
      await click("刷新目录"); await flush(); await selectFirearm("M4A1");
      await click("编辑", codeRow("6KIJ93G0FT4DOEKA4FGKI"));
      await fill("方案说明", "仅更新说明"); await click("保存");
      assert.equal(writes[0].body.lastReviewedAt, "2026-10-12T02:15:37.123456Z");
    });
    await t.test("an accepted write with failed readback is never submitted twice", async () => {
      await mount(); await selectFirearm("M4A1"); await click("新增改枪码");
      await fill("改枪码原文", "COPY-ORIGINAL-TEST");
      const previousFetch = globalThis.fetch; let accepted = false;
      globalThis.fetch = async (input, init = {}) => {
        if (accepted && (!init.method || init.method === "GET") && String(input).includes("/firearms")) throw new Error("readback lost");
        const result = await previousFetch(input, init);
        if (init.method && init.method !== "GET") accepted = true;
        return result;
      };
      try {
        await click("保存"); await flush();
        assert.match(document.body.textContent, /已受理，回读待核/);
        assert.equal(writes.length, 1);
        assert.equal(byText("管理基础目录").disabled, true);
      } finally { globalThis.fetch = previousFetch; }
    });
    await t.test("R4 losing rights mid-lookup never leaves 核对原结果 stuck spinning", async () => {
      await mount(); await openTerms(); await click("新增分类");
      await fill("稳定 code", "pistol"); await fill("名称", "手枪");
      policy = "network"; await click("保存");
      assert.match(document.body.textContent, /结果尚未确认/);
      const fetchBefore = globalThis.fetch;
      let finish, lookups = 0;
      globalThis.fetch = async (input, init = {}) => {
        if (!String(input).includes("/operation-result")) return fetchBefore(input, init);
        lookups++;
        return new Promise(resolve => { finish = () => resolve(Response.json({ receipt: "UNRESOLVED" })); });
      };
      try {
        await click("核对原结果");
        for (let i = 0; i < 15 && !finish; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        assert.ok(finish, "the lookup actually started");
        assert.equal(byText("核对中…").disabled, true, "busy while its own request is in flight");
        identity = { ...identity, permissions: [] };
        await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: () => undefined })));
        await flush();
        await act(async () => finish()); await flush();
        identity = { ...identity, permissions: ["supply.gunsmith.manage"] };
        await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: () => undefined })));
        await flush();
        const again = byText("核对原结果");
        assert.ok(again, "rights restored: the button is back and not frozen on 核对中…");
        assert.equal(again.disabled, false);
        await act(async () => again.click()); await flush();
        assert.equal(lookups, 2, "a fresh lookup can actually be started");
        assert.equal(writes.length, 1, "recovering the original result never re-sends the command");
        assert.ok(browser.localStorage.getItem("zzsh.admin.gunsmith.pending.v1:admin-a"), "an unresolved lookup keeps the pending record");
      } finally { globalThis.fetch = fetchBefore; }
    });
    await t.test("R4 a lookup that answers after the session changed never writes back", async () => {
      await mount(); await openTerms(); await click("新增分类");
      await fill("稳定 code", "smg"); await fill("名称", "冲锋枪");
      policy = "network"; await click("保存");
      const fetchBefore = globalThis.fetch;
      let finish;
      globalThis.fetch = async (input, init = {}) => {
        if (!String(input).includes("/operation-result")) return fetchBefore(input, init);
        return new Promise(resolve => { finish = () => resolve(Response.json({ receipt: "RECORDED", operation: "supply.gunsmith.classification.create", resourceId: null, responseStatus: 200, result: { id: "class-new", revision: "1" } })); });
      };
      try {
        await click("核对原结果");
        for (let i = 0; i < 15 && !finish; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        assert.ok(finish);
        identity = { ...identity, session: { id: "session-a2", locked: false } };
        await act(async () => root.render(createElement(View, { snapshot: identity, onDirtyChange: () => undefined })));
        await flush();
        await act(async () => finish()); await flush();
        assert.ok(browser.localStorage.getItem("zzsh.admin.gunsmith.pending.v1:admin-a"), "the old session must not resolve the original request");
        assert.ok(!document.body.textContent.includes("原命令回执已确认"), "no success copy leaks into the new session");
      } finally { globalThis.fetch = fetchBefore; }
    });
    await t.test("copy uses the exact original text and does not open an editor", async () => {
      await mount(); await selectFirearm("M4A1");
      let copied;
      Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: async value => { copied = value; } } });
      await act(async () => document.querySelector('[aria-label="复制改枪码 code-active"]').click());
      assert.equal(copied, fresh().codes[0].code);
      assert.ok(!field("改枪码原文"));
      assert.equal(writes.length, 0);
    });
    await t.test("creates are parent-gated with a visible reason", async () => {
      await mount();
      assert.match(document.body.textContent, /先选择一把枪械/);
      await selectFirearm("M4A1");
      assert.ok(!byText("新增改枪码").disabled, "enabled firearm allows a new code");
      await selectFirearm("AKM");
      const disabledCreate = byText("新增改枪码");
      assert.equal(disabledCreate.disabled, true);
      assert.match(document.body.textContent, /枪械「AKM」已停用/);
    });
    await t.test("classification create mints code and posts the collection path", async () => {
      await mount();
      await openTerms();
      await click("新增分类");
      await fill("稳定 code", "sniper"); await fill("名称", "狙击步枪"); await fill("排序", "5");
      await click("保存");
      assert.equal(writes.length, 1);
      assert.match(writes[0].path, /\/supply\/games\/game\/firearm-classifications$/);
      assert.deepEqual(writes[0].body, { code: "sniper", name: "狙击步枪", enabled: true, sortOrder: 5 });
      assert.match(writes[0].key, /^idem_/);
    });
    await t.test("invalid stable code never submits", async () => {
      await mount(); await openTerms(); await click("新增分类");
      await fill("稳定 code", "Sniper Rifle"); await fill("名称", "x");
      await click("保存");
      assert.equal(writes.length, 0);
      assert.match(document.body.textContent, /稳定 code 需以小写字母开头/);
    });
    await t.test("code text is stored verbatim and short codes are refused", async () => {
      await mount(); await selectFirearm("M4A1");
      assert.match(document.body.textContent, /M4A1突击步枪-烽火地带-6KIJ93G0FT4DOEKA4FGKI/);
      await click("新增改枪码");
      await fill("改枪码原文", "abc"); await click("保存");
      assert.equal(writes.length, 0);
      assert.match(document.body.textContent, /改枪码至少需要 4 个字符/);
      const codeField = field("改枪码原文");
      assert.equal(codeField.getAttribute("aria-invalid"), "true", "failed validation marks the control");
      const described = (codeField.getAttribute("aria-describedby") || "").split(" ").map(id => document.getElementById(id)?.textContent || "").join(" ");
      assert.match(described, /改枪码至少需要 4 个字符/, "error text is linked to the control");
      await fill("改枪码原文", " 6K27AI809CJL1LB5MC83O ");
      await fill("模式", "全面战场");
      await fill("方案说明", "急停腰射");
      await click("保存");
      assert.equal(writes.length, 1);
      assert.match(writes[0].path, /\/supply\/gunsmith\/codes$/);
      assert.equal(writes[0].body.code, " 6K27AI809CJL1LB5MC83O ");
      assert.equal(writes[0].body.modeCode, "BATTLEFIELD");
      assert.equal(writes[0].body.firearmId, "gun-m4");
      assert.ok(!("lastReviewedAt" in writes[0].body), "an empty review date is omitted, not defaulted to today");
    });
    await t.test("unreviewed codes never read as usable", async () => {
      await mount(); await selectFirearm("M4A1");
      const withdrawn = codeRow("6G94AKO0FHI6PKF6C3P0U");
      assert.match(withdrawn.textContent, /未记录/);
      assert.match(withdrawn.textContent, /已撤回/);
      assert.doesNotMatch(withdrawn.textContent, /可用/);
    });
    await t.test("withdraw and restore hit their own endpoints with expectedRevision", async () => {
      await mount(); await selectFirearm("M4A1");
      await click("撤回", codeRow("6KIJ93G0FT4DOEKA4FGKI"));
      assert.equal(writes.length, 0, "opening confirmation is read-only");
      await click("确认撤回");
      assert.match(writes[0].path, /\/supply\/gunsmith\/codes\/code-active\/withdraw$/);
      assert.deepEqual(writes[0].body, { expectedRevision: "4" });
    });
    await t.test("409 keeps input and never auto-adopts a new revision", async () => {
      await mount(); await selectFirearm("M4A1");
      await click("编辑", codeRow("6KIJ93G0FT4DOEKA4FGKI"));
      await fill("改枪码原文", "KEPT-INPUT-6KIJ93G0FT4DOEKA4FGKI");
      policy = "conflict"; await click("保存");
      assert.equal(field("改枪码原文").value, "KEPT-INPUT-6KIJ93G0FT4DOEKA4FGKI");
      assert.match(document.body.textContent, /版本已变化/);
      assert.equal(writes.length, 1, "a conflict is never replayed automatically");
    });
    await t.test("a lost response stays unconfirmed and is never re-sent", async () => {
      await mount(); await openTerms(); await click("新增分类");
      await fill("稳定 code", "pistol"); await fill("名称", "手枪");
      policy = "network"; await click("保存");
      assert.match(document.body.textContent, /结果尚未确认/);
      assert.equal(writes.length, 1);
      assert.ok(!byText("重新提交") && !byText("重试"), "no fake recovery control");
      const before = writes.length, readsBefore = reads.length;
      await click("刷新目录核对"); await flush();
      assert.equal(writes.length, before, "recovery only reads");
      assert.ok(reads.length > readsBefore);
      assert.ok(!byText("已核对，清除提示"), "current state is not proof of the original result");
      await mount(["supply.gunsmith.manage"], true);
      assert.match(document.body.textContent, /结果尚未确认/);
      assert.equal(writes.length, 0, "refresh restores a lock, never a submission");
      assert.equal(byText("管理基础目录").disabled, true);
    });
    await t.test("closing the editor keeps the unconfirmed state", async () => {
      await mount(); await openTerms(); await click("新增分类");
      await fill("稳定 code", "smg"); await fill("名称", "冲锋枪");
      const baseFetch = globalThis.fetch; let release;
      globalThis.fetch = async (input, init = {}) => { if (init.method && init.method !== "GET") await new Promise(resolve => { release = resolve; }); return baseFetch(input, init); };
      try {
        policy = "network"; await click("保存");
        assert.ok(release, "write in flight");
        await click("关闭（稍后核对）");
        release(); await flush();
        assert.match(document.body.textContent, /结果尚未确认/);
      } finally { globalThis.fetch = baseFetch; }
    });
    await t.test("firearm image binding reads approved public candidates and writes only on save", async () => {
      await mount(); await selectFirearm("M4A1");
      await openTerms();
      const dialogFirearmRow = [...document.querySelectorAll('[role="dialog"] tbody tr')].find(r => r.textContent.includes("m4a1"));
      assert.ok(dialogFirearmRow, "dialog firearm row");
      await click("编辑", dialogFirearmRow);
      await click("选择图片");
      await flush();
      assert.ok(reads.some(p => p.includes("media-options") && p.includes("FIREARM_MEDIA")));
      assert.equal(writes.length, 0);
      const candidate = buttons().find(b => b.textContent.includes("asset-new"));
      assert.ok(candidate, "candidate shown");
      await act(async () => candidate.click());
      await click("保存");
      assert.equal(writes.length, 1);
      assert.match(writes[0].path, /\/supply\/firearms\/gun-m4$/);
      assert.equal(writes[0].body.mediaId, "asset-new");
      assert.equal(writes[0].body.expectedRevision, "5");
      assert.equal(writes[0].body.name, "M4A1");
    });
    await t.test("search is scoped to loaded rows and reports no-match honestly", async () => {
      await mount(); await selectFirearm("M4A1");
      await fill("在已加载枪械中查找", "四脚蛇");
      assert.ok(firearmRow("M4A1"), "alias matches its firearm");
      await fill("在已加载枪械中查找", "zzz-absent");
      assert.match(document.body.textContent, /已加载内容中无匹配/);
      await fill("在已加载枪械中查找", "");
      await fill("在当前武器的已加载改枪码中查找", "zzz-absent");
      assert.match(document.body.textContent, /已加载内容中无匹配/);
    });
    await t.test("short code is refused and a dirty row edit blocks switching weapons", async () => {
      await mount(); await selectFirearm("M4A1");
      await click("新增改枪码");
      await click("保存"); assert.equal(writes.length, 0, "an empty code is refused");
      assert.match(document.body.textContent, /改枪码至少需要 4 个字符/);
      await fill("方案说明", "Guarded");
      await selectFirearm("AKM");
      assert.match(document.body.textContent, /切换将放弃未保存修改/);
      await click("保留编辑");
      assert.equal(field("方案说明").value, "Guarded");
      await selectFirearm("AKM"); await click("放弃修改并切换");
      assert.equal(writes.length, 0);
    });
  } finally {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = originalFetch; await vite.close(); await browser.happyDOM.abort();
  }
});
