import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// ADM-OPS-UNIFIED-REPAIR-1：管理员目录页 R1–R9 的真实组件反例。
// 所有 POST 由本地 fetch fixture 应答；不连服务端，不产生任何真实治理写。

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4303/admins" });
for (const name of ["window", "document", "HTMLElement", "Element", "ShadowRoot", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "getComputedStyle", "localStorage", "sessionStorage"]) {
  globalThis[name] = name === "window" ? browser : name === "getComputedStyle" ? browser[name].bind(browser) : browser[name];
}
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  cacheDir: path.resolve(adminRoot, '../../tmp/admin-test-cache/admin-directory'),
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src"), "@brand": path.resolve(adminRoot, "../../assets/brand") } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { AdminDirectoryView } = await vite.ssrLoadModule("/src/views/admin-directory-view.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const networkFailure = () => Promise.reject(new TypeError("fetch failed"));

const ACTIVE_ROLE = { id: "role-a", code: "ops", name: "运营", description: null, status: "ACTIVE", permissionCodes: ["order.read"] };
const DISABLED_ROLE = { id: "role-d", code: "legacy", name: "旧角色", description: null, status: "DISABLED", permissionCodes: [] };
const CATALOG_PERMISSIONS = [
  { code: "order.read", name: "订单核心读取", description: null },
  { code: "supply.rules.activate", name: "规则生效", description: null },
];
const GAMES = [{ id: "game-1", code: "g1", name: "游戏一", description: null, enabled: true, catalogRevision: "1", currentReleaseId: null, coverMediaId: null }];
const TARGET = { id: "admin-2", username: "ZZ00002", name: "测试运营", status: "ACTIVE", isBoss: false, createdAt: "2026-09-01T00:00:00Z", lastFullAuthenticatedAt: null };
const ALLOWED_ACTIONS = ["update", "assign", "scope", "freeze", "unfreeze", "force-logout"].map((action) => ({ action, allowed: true, reasonCode: "OK", needsReauthentication: ["freeze", "unfreeze", "force-logout"].includes(action), needsFullGrantBaseline: action === "assign" }));

function detailFixture(overrides = {}) {
  return {
    ...TARGET,
    actions: ALLOWED_ACTIONS,
    roles: [ACTIVE_ROLE, DISABLED_ROLE],
    allowPermissions: [],
    denyPermissions: [],
    effectivePermissions: ["order.read"],
    scope: { mode: "SELECTED_GAMES", gameIds: ["game-1"] },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, twoFactorEnabled: true, bootstrapExpiresAt: null, bootstrapUsedAt: null, firstActivatedAt: "2026-09-01T00:00:00Z" },
    sessionSummary: { activeCount: 1, lockedCount: 0, lastSessionCreatedAt: "2026-09-02T00:00:00Z" },
    ...overrides,
  };
}

function snap(permissions = ["admin.account.read", "admin.account.update", "admin.account.create", "admin.account.freeze", "admin.permission.grant", "admin.role.read", "admin.permission.read", "admin.audit.read"], adminUserId = "admin-boss", sessionId = "session-1") {
  return {
    authenticated: true,
    adminUserId,
    user: { name: "操作者", username: "ZZ00009", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: sessionId, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

/** 路由键为「方法 + 去前缀路径」；handler 收到该路由此前的调用次数，便于一次失败一次成功。 */
function useServer(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = String(init.method ?? (init.body ? "POST" : "GET")).toUpperCase();
    const route = `${method} ${url.pathname.replace("/api/bff/admin", "")}`;
    const index = calls.push({ route, body: init.body ? JSON.parse(String(init.body)) : null, query: Object.fromEntries(url.searchParams) }) - 1;
    const handler = routes[route];
    if (!handler) return json({ error: { code: "NOT_FOUND" } }, 404);
    return handler(calls.slice(0, index).filter((call) => call.route === route).length, url);
  };
  return calls;
}

function baseRoutes(detailBody, overrides = {}) {
  return {
    "GET /security/admins": () => json({ admins: [TARGET], createScopeRequired: true }),
    "GET /security/roles": () => json({ roles: [ACTIVE_ROLE, DISABLED_ROLE], permissions: CATALOG_PERMISSIONS }),
    "GET /supply/games": () => json({ games: GAMES }),
    "GET /security/admins/detail": () => json(detailBody),
    "GET /security/audit/events": () => json({ events: [{ eventId: "audit-default", action: "admin.frozen", actor: { name: "操作者" }, occurredAt: "2026-09-03T00:00:00Z", outcome: "SUCCESS" }], scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" }),
    ...overrides,
  };
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(fn, timeout = 3000) {
  // 第二个位置参数是毫秒数。误传说明文字会让 deadline 变成 NaN 并永远转圈。
  assert.equal(typeof timeout, "number", "waitFor 的第二个参数必须是超时毫秒数");
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("component condition timed out");
    await settle();
  }
}

// 独立详情页与聚焦编辑器分别定位；安全确认也不能靠 DOM 顺序猜。

const detailPage = () => browser.document.querySelector('[data-admin-detail]');
// 信息窗口的标题是 DialogTitle，不再是整页 h1。
const detailTitle = () => detailPage()?.querySelector('[data-slot="dialog-title"]');
// 信息窗口按内部页签分区，取某个分区前先切过去。
async function gotoTab(page, label) {
  const tab = [...page.querySelectorAll("[role=tab]")].find((node) => node.textContent === label);
  if (tab && tab.getAttribute("aria-selected") !== "true") await click(tab);
  return page;
}
const editDialog = () => dialogWith("只修改当前分区");
const dialogWith = (marker) => [...browser.document.querySelectorAll('[data-slot="dialog-content"]')].find((node) => node.textContent.includes(marker));
// 只匹配真正的可点击元素：标题文案可能与按钮同名（如「新增管理员」）。
const controls = (node = browser.document.body) => [...(node ?? browser.document).querySelectorAll("button,a")];
const btn = (text, node = browser.document.body) => controls(node).find((b) => b.textContent.trim() === text);
const rowButtons = (text) => [...browser.document.querySelectorAll("tbody button")].filter((b) => b.textContent.trim() === text);
// 编辑器复用分区表单，按标题定位，不能猜第一个 checkbox。
const section = (title, node = editDialog()) => [...node.querySelectorAll("section")].find((s) => (s.querySelector("h2,h3")?.textContent.trim() === title));

async function click(element, message = "expected clickable element") {
  assert.ok(element, message);
  await act(async () => {
    element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function typeInto(element, value) {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

let sessionCounter = 0;

function mount(sessionId = `session-case-${(sessionCounter += 1)}`) {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const dirty = [];
  const storageWrites = [];
  for (const store of [browser.localStorage, browser.sessionStorage]) {
    const original = store.setItem.bind(store);
    store.setItem = (key, value) => {
      storageWrites.push(`${key}=${value}`);
      return original(key, value);
    };
  }
  const view = {
    dirty,
    storageWrites,
    sessionId,
    render: async (props = {}) => {
      await act(async () => {
        root.render(createElement(AdminDirectoryView, { snapshot: snap(undefined, undefined, sessionId), initialUsername: TARGET.username, onDirtyChange: (value) => dirty.push(value), ...props }));
      });
      await settle();
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      await settle();
    },
  };
  return view;
}

async function openDetail(view, props = {}) {
  await view.render(props);
  await waitFor(() => detailPage()?.querySelector("h1"));
  return detailPage();
}

async function openEditor(view, kind = "profile", props = {}) {
  const page = await openDetail(view, props);
  const label = { profile: "编辑资料", access: "调整角色与权限", scope: "调整业务范围" }[kind];
  // 任务入口分布在不同内部页签与窗口底栏，先切到含该入口的页签。
  for (const tab of ["概览", "访问与安全", "账号变更"]) {
    if (btn(label, page)) break;
    const tabButton = [...page.querySelectorAll("[role=tab]")].find((node) => node.textContent === tab);
    if (tabButton) await click(tabButton);
  }
  await click(btn(label, page), `编辑器入口 ${label} 应可点击`);
  await waitFor(() => editDialog());
  return editDialog();
}

test("R1 取消勾选停用角色后可以保存，重新勾选后重新阻断，兄弟生效角色不受影响", async (t) => {
  const calls = useServer(baseRoutes(detailFixture()));
  const view = mount();
  t.after(view.cleanup);
  const detail = await openEditor(view, "access");

  const roleSection = () => section("角色与有效权限");
  const checkboxOf = (name) => [...roleSection().querySelectorAll("input[type=checkbox]")].find((input) => input.closest("label")?.textContent.includes(name));
  const disabledCheckbox = checkboxOf("旧角色");
  assert.ok(disabledCheckbox, "已停用角色必须显形且可取消勾选");
  assert.equal(disabledCheckbox.checked, true);
  assert.ok(btn("保存权限", detail).disabled, "草稿仍保留停用角色时必须阻断保存（服务端会拒绝）");

  await click(disabledCheckbox);
  assert.equal(btn("保存权限", editDialog()).disabled, false, "取消停用角色后保存必须解除阻断");
  await click(btn("保存权限", editDialog()));
  await waitFor(() => calls.some((call) => call.route === "POST /security/admins/assign"));
  const assign = calls.find((call) => call.route === "POST /security/admins/assign");
  assert.deepEqual(assign.body.roleIds, ["role-a"], "assign 载荷不得再包含已取消的停用角色");

  assert.equal(checkboxOf("运营").disabled, false, "生效角色始终可操作");
  await click(checkboxOf("旧角色"));
  assert.equal(btn("保存权限", editDialog()).disabled, true, "重新勾选停用角色后必须重新阻断");
});

test("R3 创建在途不可关闭，凭据未确认前计入离开保护且不落入存储", async (t) => {
  const SECRET = "Sup3r-Secret-Pw";
  let releaseCreate;
  const pending = new Promise((resolve) => {
    releaseCreate = () => resolve(json({ id: "admin-9", username: "ZZ90009", name: "新同事", status: "PENDING_ENROLLMENT", temporaryPassword: SECRET }));
  });
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/create": () => pending });
  const view = mount();
  t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await waitFor(() => browser.document.body.textContent.includes("测试运营"));

  await click(btn("新增管理员"));
  const create = dialogWith("对方首次登录必须改密");
  assert.ok(create, "创建弹窗已打开");
  typeInto(create.querySelector("input"), "新同事");
  assert.equal(view.dirty.at(-1), true, "已填写名称即进入离开保护");
  await click(browser.document.querySelector('[data-slot="dialog-content"] input[type="radio"][value="ALL_GAMES"]'));
  await click(btn("创建管理员", create));
  await settle(5);
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/create").length, 1);
  assert.ok(dialogWith("对方首次登录必须改密"), "创建请求在途时弹窗不得被 Esc/点外/取消收起");
  assert.equal(btn("取消", dialogWith("对方首次登录必须改密")).disabled, true, "结果未知时取消必须禁用");

  await act(async () => {
    releaseCreate();
    await pending;
  });
  await waitFor(() => dialogWith("交付临时凭据")?.textContent.includes(SECRET));
  assert.equal(view.dirty.at(-1), true, "未确认抄录的一次性凭据必须继续计入离开保护");
  assert.ok(!view.storageWrites.includes(SECRET) && !view.storageWrites.some((entry) => entry.includes(SECRET)), "临时密码不得写入浏览器存储");
  assert.ok(!browser.location.href.includes(SECRET), "临时密码不得进入 URL");
  assert.ok(![...browser.document.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").includes(SECRET)), "临时密码不得进入链接");

  await click(btn("我已抄录并关闭", dialogWith("交付临时凭据")));
  await settle();
  assert.equal(dialogWith("交付临时凭据"), undefined, "只有显式确认才收起交付窗口");
});

test("R4 迟到的旧对象响应不得覆盖当前对象或重开窗口", async (t) => {
  let releaseSlow;
  const slow = new Promise((resolve) => {
    releaseSlow = () => resolve(json(detailFixture({ id: "admin-slow", username: "ZZ00002", name: "慢账号不应出现" })));
  });
  const routes = baseRoutes(detailFixture({ id: "admin-3", username: "ZZ00003", name: "第二账号" }));
  const detailRoute = routes["GET /security/admins/detail"];
  let first = true;
  routes["GET /security/admins/detail"] = () => {
    if (first) {
      first = false;
      return slow;
    }
    return detailRoute();
  };
  const calls = useServer(routes);
  const view = mount();
  t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await waitFor(() => browser.document.body.textContent.includes("测试运营"));

  await click(browser.document.querySelector("tbody td"));
  assert.ok(calls.some((call) => call.route === "GET /security/admins/detail"), "第一次信息读取已发出");

  // 立刻切到另一个对象：慢请求仍在途。
  await click(btn("关闭", detailPage()), "读取期间也能关闭窗口并废弃旧响应");
  await view.render({ initialUsername: "ZZ00003" });
  await waitFor(() => detailPage()?.textContent.includes("第二账号"));

  await act(async () => {
    releaseSlow();
    await slow;
  });
  await settle();
  assert.ok(detailPage()?.textContent.includes("第二账号"), "旧对象的迟到响应不得改掉当前对象");
  assert.ok(!browser.document.body.textContent.includes("慢账号不应出现"), "迟到响应不得写回界面");
});

test("R5 写入已确认而刷新失败只降级为“显示未更新”，重试入口只发 GET", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins/detail": (n) => (n === 0 ? json(detailFixture()) : n === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json(detailFixture({ name: "已改名" }))),
    "POST /security/admins/update": () => json({ ok: true }),
  });
  const view = mount();
  t.after(view.cleanup);
  const detail = await openEditor(view);

  typeInto(detail.querySelector("input"), "已改名");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("已保存，但页面数据未能刷新"));
  const shown = editDialog();
  assert.ok(shown.textContent.includes("显示名称已更新"), "写成功必须继续表达为已确认");
  assert.ok(shown.textContent.includes("只读取，不会重复提交"), "刷新失败必须给出只读重试的说明");
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 1, "刷新失败不得触发第二次写");

  await click(btn("重试刷新", shown));
  await waitFor(() => editDialog()?.textContent.includes("已改名"));
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 1, "重试只读，不重复提交治理写");
  assert.equal(editDialog().textContent.includes("已保存，但页面数据未能刷新"), false, "刷新成功后过期提示必须撤下");
});

test("R5 网络结果未知时不得引导重复提交，并回读服务端事实", async (t) => {
  const landed = detailFixture({ name: "服务端其实已改名" });
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins/detail": (n) => (n === 0 ? json(detailFixture()) : json(landed)),
    "POST /security/admins/update": () => networkFailure(),
  });
  const view = mount();
  t.after(view.cleanup);
  const detail = await openEditor(view);

  typeInto(detail.querySelector("input"), "服务端其实已改名");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("无法确认这次修改是否已送达"));
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 1);
  // 即使回读与草稿一致，UNKNOWN 仍锁住原操作。
  await waitFor(() => btn("保存资料", editDialog()).disabled);
});

test("R6 审计读取失败、确实无记录与有记录是三种不同呈现", async (t) => {
  const scenarios = [
    { label: "读取失败", route: () => json({ error: { code: "INTERNAL_ERROR" } }, 500), expect: "操作记录读取失败" },
    { label: "确实为空", route: () => json({ events: [], scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" }), expect: "暂无该账号相关的审计事件" },
    { label: "有记录", route: () => json({ events: [{ eventId: "audit-present", action: "admin.frozen", actor: { name: "操作者" }, occurredAt: "2026-09-03T00:00:00Z", outcome: "SUCCESS" }], scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" }), expect: "冻结管理员" },
  ];
  for (const scenario of scenarios) {
    useServer({ ...baseRoutes(detailFixture()), "GET /security/audit/events": scenario.route });
    const view = mount();
    try {
      const detail = await gotoTab(await openDetail(view), "账号变更");
      assert.ok(detail.textContent.includes(scenario.expect), `${scenario.label} 应显示「${scenario.expect}」`);
      if (scenario.label === "读取失败") assert.ok(detail.textContent.includes("重试读取"), "失败必须保留只读重试入口");
      if (scenario.label === "读取失败") assert.ok(!detail.textContent.includes("暂无该账号相关的审计事件"), "失败不得冒充空记录");
      if (scenario.label === "读取失败") assert.ok(!detail.textContent.includes("你没有审计读取权限"), "失败不得冒充无权");
    } finally {
      await view.cleanup();
    }
  }
});

test("R7 缺失 scope 呈现未知并禁止修改与恢复；显式空集合仍是无业务范围", async (t) => {
  useServer(baseRoutes(detailFixture({ scope: undefined })));
  const view = mount();
  t.after(view.cleanup);
  const detail = await openDetail(view);
  assert.ok(detail.textContent.includes("未接入"), "未知范围用未接入徽标呈现");
  assert.ok(!detail.textContent.includes("可读取全部游戏的业务"), "未知范围不得说成全部游戏");
  assert.equal(detail.querySelectorAll("input[type=radio]").length, 0, "只读详情不伪造范围单选");
  assert.equal(btn("调整业务范围", detail).disabled, true, "未知范围必须阻止进入写表单与恢复");
  await click(btn("调整业务范围", detail));
  assert.equal(editDialog(), undefined, "禁用入口不得打开范围编辑器");

  await view.cleanup();
  useServer(baseRoutes(detailFixture({ scope: { mode: "SELECTED_GAMES", gameIds: [] } })));
  const emptyView = mount();
  t.after(emptyView.cleanup);
  const second = await openDetail(emptyView);
  assert.ok(second.textContent.includes("无业务范围"), "显式 SELECTED_GAMES+[] 必须继续表达为无业务范围");
  await click(btn("调整业务范围", second));
  assert.ok([...editDialog().querySelectorAll("input[type=radio]")].some((radio) => radio.checked), "明确的无范围是已知事实");
});

test("R8 同一实例权限真→假→真不抛 Hook 错误且旧投影被清理", async (t) => {
  useServer(baseRoutes(detailFixture()));
  const view = mount();
  t.after(view.cleanup);
  await openDetail(view);
  assert.ok(detailPage(), "有权限时详情正常呈现");

  await view.render({ snapshot: snap(["order.read"]) });
  assert.ok(browser.document.body.textContent.includes("当前账号没有查看管理员目录的权限"));
  assert.equal(detailPage(), null, "权限收回后不得继续保留上一账号的私有投影");

  await view.render({ snapshot: snap(), initialUsername: TARGET.username });
  await waitFor(() => detailPage()?.querySelector("h1"));
});

test("R9 缺读取能力时省略字段显示无权查看，且拒绝路径绝不发送 assign", async (t) => {
  const combinations = [
    { label: "grant + role.read 缺 permission.read", detail: detailFixture({ allowPermissions: undefined, denyPermissions: undefined, effectivePermissions: undefined }), snapshot: snap(["admin.account.read", "admin.permission.grant", "admin.role.read"]) },
    { label: "grant + permission.read 缺 role.read", detail: detailFixture({ roles: undefined }), snapshot: snap(["admin.account.read", "admin.permission.grant", "admin.permission.read"]) },
  ];
  for (const scenario of combinations) {
    const calls = useServer(baseRoutes(scenario.detail));
    const view = mount();
    try {
      const detail = await openDetail(view, { snapshot: scenario.snapshot });
      const adjust = btn("调整角色与权限", detail);
      assert.ok(adjust, `${scenario.label}：应说明调整能力`);
      assert.ok(adjust.disabled, `${scenario.label}：缺读取能力时不得打开全量替换编辑器`);
      assert.ok(detail.textContent.includes("授权基线不完整"), `${scenario.label}：必须说明禁用原因`);
      assert.ok([...detail.querySelectorAll("button[aria-label=\"为什么不能调整授权\"]")].length === 1, `${scenario.label}：完整原因收进问号 Tooltip`);
      await click(adjust);
      assert.equal(editDialog(), undefined, `${scenario.label}：不得出现可保存的授权编辑器`);
      assert.equal(calls.filter((call) => call.route === "POST /security/admins/assign").length, 0, `${scenario.label}：不得发出 assign`);
    } finally {
      await view.cleanup();
    }
  }
});

test("R2 危险操作影响与接口一致，恢复范围不再收集无用途的原因", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/scope": () => json({ ok: true }) });
  const view = mount();
  t.after(view.cleanup);
  const detail = await openDetail(view);

  await click(btn("冻结账号", detail));
  const freeze = await waitFor(() => dialogWith("冻结该管理员")) ?? dialogWith("冻结该管理员");
  assert.ok(freeze.textContent.includes("撤销该账号全部现有会话"), "冻结必须说明会话会被撤销");
  assert.ok(freeze.textContent.includes("使其未完成的账号恢复请求过期"));
  assert.ok(freeze.textContent.includes("原因（写入审计）"), "冻结原因确有服务端落点，必须保留");
  await click(btn("取消", freeze));
  assert.equal(dialogWith("冻结该管理员"), undefined, "取消不得发出冻结");
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 0);

  await click(btn("调整业务范围", detailPage()));
  await click(btn("恢复此前指定的范围", editDialog()));
  await waitFor(() => dialogWith("恢复此前指定的游戏范围"));
  const restore = dialogWith("恢复此前指定的游戏范围");
  assert.ok(restore.textContent.includes("无业务范围"), "空历史集合的结果必须说明为无范围");
  assert.equal(restore.querySelector("textarea"), null, "恢复范围的请求体不含原因，不得收集后丢弃");
  assert.equal(restore.querySelector("input[type=password]"), null, "恢复范围不撤销访问，不要求再验证凭据");
  await click(btn("确认恢复范围", restore));
  await waitFor(() => calls.some((call) => call.route === "POST /security/admins/scope"));
  assert.deepEqual(calls.find((call) => call.route === "POST /security/admins/scope").body, { username: TARGET.username, mode: "SELECTED_GAMES" }, "恢复动作省略 gameIds，由服务端恢复历史集合");
});

// ---- ADM-OPS-UNIFIED-REPAIR-1-R2：master-review 的六条反例，原样并入源测试 ----
// All requests below use the copied local fetch fixture. No API, PG or real account writes.
test("Q1 UNKNOWN followed by old GET must keep the original write locked", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/update": networkFailure });
  const view = mount(); t.after(view.cleanup);
  const detail = await openEditor(view);
  await act(async () => typeInto(detail.querySelector("input"), "Pending name"));
  await click(btn("保存资料", editDialog()));
  await waitFor(() => calls.filter(call => call.route === "GET /security/admins/detail").length >= 2);
  await settle(50);
  assert.ok(editDialog().textContent.includes("无法确认这次修改是否已送达"));
  assert.equal(calls.filter(call => call.route.startsWith("POST")).length, 1);
  assert.equal(btn("保存资料", editDialog()).disabled, true, "Old read is not a terminal result and must not invite another POST");
});

test("Q1 ACK followed by failed refresh must block re-submitting the accepted write", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins/detail": n => n === 0 ? json(detailFixture()) : json({ error: { code: "INTERNAL_ERROR" } }, 503),
    "POST /security/admins/update": () => json({ ok: true }),
  });
  const view = mount(); t.after(view.cleanup);
  const detail = await openEditor(view);
  await act(async () => typeInto(detail.querySelector("input"), "Accepted name"));
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("已保存，但页面数据未能刷新"));
  await settle();
  assert.equal(calls.filter(call => call.route.startsWith("POST")).length, 1);
  assert.equal(btn("保存资料", editDialog()).disabled, true, "Acknowledged write must not be replayed because its baseline is stale");
});

test("Q2 creation NETWORK_ERROR must hold the attempted creation instead of enabling retry", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/create": networkFailure });
  const view = mount(); t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await click(btn("新增管理员"));
  const form = dialogWith("新管理员默认全部游戏范围");
  await act(async () => typeInto(form.querySelector("input"), "Fixture create intent"));
  await click(browser.document.querySelector('[data-slot="dialog-content"] input[type="radio"][value="ALL_GAMES"]'));
  await click(btn("创建管理员", form));
  await waitFor(() => calls.some(call => call.route === "POST /security/admins/create"));
  await settle(50);
  assert.equal(calls.filter(call => call.route === "POST /security/admins/create").length, 1);
  assert.equal(btn("创建管理员", form).disabled, true, "Creation may have committed and its one-time credential cannot be replayed safely");
});

test("Q2 malformed creation response must not expose an acknowledgement for missing credentials", async (t) => {
  useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/create": () => json({ id: "fixture-new", username: "FIXTURE_NEW", name: "Fixture new", status: "PENDING_ENROLLMENT" }) });
  const view = mount(); t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await click(btn("新增管理员"));
  const form = dialogWith("新管理员默认全部游戏范围");
  await act(async () => typeInto(form.querySelector("input"), "Fixture create intent"));
  await click(browser.document.querySelector('[data-slot="dialog-content"] input[type="radio"][value="ALL_GAMES"]'));
  await click(btn("创建管理员", form));
  await settle(50);
  assert.equal(Boolean(btn("我已抄录并关闭")), false, "No temporaryPassword was delivered; a successful-delivery acknowledgement is false");
});

test("Q3 losing a read permission after full detail must invalidate the cached assignment", async (t) => {
  let roleReadable = true;
  const body = detailFixture({ roles: [ACTIVE_ROLE] });
  const calls = useServer({ ...baseRoutes(body), "GET /security/roles": () => json({ roles: roleReadable ? [ACTIVE_ROLE, DISABLED_ROLE] : [], permissions: CATALOG_PERMISSIONS }) });
  const view = mount(); t.after(view.cleanup);
  await openEditor(view, "access");
  const before = snap();
  roleReadable = false;
  await view.render({ snapshot: snap(before.permissions.filter(code => code !== "admin.role.read")) });
  await settle(50);
  await click(section("角色与有效权限").querySelector("summary"));
  const personal = [...section("角色与有效权限").querySelectorAll("fieldset")].find(node => node.querySelector("legend")?.textContent === "个人允许");
  await click(personal.querySelector("input[type=checkbox]"));
  await settle();
  assert.equal(calls.filter(call => call.route === "POST /security/admins/assign").length, 0);
  assert.equal(btn("保存权限", editDialog()).disabled, true, "Arrays cached under earlier permissions do not prove current full read authority");
});

test("Q4 edits made during another section POST must survive its refresh", async (t) => {
  let resolvePost, committed = false;
  useServer({
    ...baseRoutes(detailFixture({ roles: [ACTIVE_ROLE] })),
    "GET /security/admins/detail": () => json(detailFixture({ roles: [ACTIVE_ROLE], name: committed ? "Saved profile" : TARGET.name })),
    "POST /security/admins/update": () => new Promise(resolve => { resolvePost = () => { committed = true; resolve(json({ ok: true })); }; }),
  });
  const view = mount(); t.after(view.cleanup);
  const detail = await openEditor(view);
  await act(async () => typeInto(detail.querySelector("input"), "Saved profile"));
  await click(btn("保存资料", editDialog()));
  await waitFor(() => resolvePost);
  assert.equal(editDialog().querySelector("input").disabled, true, "提交中不能修改当前表单");
  assert.equal(btn("调整业务范围", detailPage()).disabled, true, "提交中不能打开另一分区制造新草稿");
  assert.equal(btn("调整角色与权限", detailPage()).disabled, true);
  await act(async () => resolvePost());
  await waitFor(() => detailPage()?.querySelector("h1")?.textContent === "Saved profile");
  assert.equal(editDialog(), undefined, "回读确认后收起编辑器，保留事实页");
});

test("P1-A 丢弃本地草稿不解除 UNKNOWN，也不开放第二次提交", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins/detail": (n) => (n === 0 ? json(detailFixture()) : json(detailFixture({ name: "服务端未变" }))),
    "POST /security/admins/update": networkFailure,
  });
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "本地新名字");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("无法确认这次修改是否已送达"));
  assert.equal(btn("保存资料", editDialog()).disabled, true);

  await click(btn("丢弃本地草稿重新读取（本项仍锁定）", editDialog()));
  await settle(40);
  assert.ok(editDialog().textContent.includes("无法确认这次修改是否已送达"), "丢弃草稿只影响草稿，不证明原请求已结束");
  typeInto(editDialog().querySelector("input"), "第二次修改");
  await settle();
  assert.equal(btn("保存资料", editDialog()).disabled, true, "丢弃草稿后仍不得再次提交");
  await click(btn("保存资料", editDialog()));
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/update").length, 1);
});

test("P1-A 列表核对与重开创建弹窗都不解除 UNKNOWN，也不允许重建", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/create": networkFailure });
  const view = mount();
  t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await click(btn("新增管理员"));
  const form = () => dialogWith("对方首次登录必须改密");
  typeInto(form().querySelector("input"), "Fixture create intent");
  await click(browser.document.querySelector('[data-slot="dialog-content"] input[type="radio"][value="ALL_GAMES"]'));
  await click(btn("创建管理员", form()));
  await waitFor(() => form()?.textContent.includes("无法确认这次创建请求是否已送达"));
  assert.equal(btn("创建管理员", form()).disabled, true);
  assert.equal(btn("已核对列表：没有该账号，允许重新创建", form()), undefined, "不得提供人工声明式解锁出口");

  await click(btn("刷新列表核对", form()));
  await settle(40);
  assert.equal(btn("创建管理员", form()).disabled, true, "读取列表为空不是原请求被拒绝的回执");

  await click(btn("取消", form()));
  await click(btn("新增管理员"));
  assert.ok(form().textContent.includes("无法确认这次创建请求是否已送达"), "重开弹窗仍保留待核对");
  assert.equal(btn("创建管理员", form()).disabled, true);
  await click(browser.document.querySelector('[data-slot="dialog-content"] input[type="radio"][value="ALL_GAMES"]'));
  await click(btn("创建管理员", form()));
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/create").length, 1);
});

test("P1-B 安全确认框关闭重开仍锁定同一目标同一操作", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/scope": networkFailure });
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view, "scope");
  await click(btn("恢复此前指定的范围", editDialog()));
  const dialog = () => dialogWith("恢复此前指定的游戏范围");
  await waitFor(() => dialog());
  await click(btn("确认恢复范围", dialog()));
  await waitFor(() => dialog()?.textContent.includes("无法确认"));
  await click(btn("取消", dialog()));
  await settle();

  await click(btn("恢复此前指定的范围", editDialog()));
  assert.ok(dialog(), "确认框可以重新打开以查看待核对状态");
  assert.ok(dialog().textContent.includes("无法确认"), "销毁确认框不应销毁原操作的待确认记录");
  assert.equal(btn("确认恢复范围", dialog()).disabled, true);
  await click(btn("确认恢复范围", dialog()));
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/scope").length, 1);
});

test("P1-B 工作区页面卸载再挂载不丢失同身份同会话同目标的 UNKNOWN", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture()), "POST /security/admins/update": networkFailure });
  const shared = "session-remount-shared";
  const first = mount(shared);
  await openEditor(first);
  typeInto(editDialog().querySelector("input"), "原修改");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("无法确认这次修改是否已送达"));
  await first.cleanup();

  const second = mount(shared);
  t.after(second.cleanup);
  const page = await openDetail(second);
  assert.ok(page.textContent.includes("无法确认这次操作是否已送达"), "切页/重挂载不是业务操作的终态");
  assert.equal(btn("编辑资料", page).disabled, true, "重挂载后编辑入口仍应锁定");
  await click(btn("编辑资料", page));
  assert.equal(editDialog(), undefined, "锁定期间不得再进入该项编辑器");
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/update").length, 1);
});

test("P1-B 第二分区 UNKNOWN 不解锁第一分区，两条记录并存", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture({ roles: [ACTIVE_ROLE] })),
    "POST /security/admins/update": networkFailure,
    "POST /security/admins/assign": networkFailure,
  });
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "资料未确认");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("无法确认这次修改是否已送达"));
  await click(btn("取消编辑", editDialog()));
  await settle();
  assert.equal(btn("编辑资料", detailPage()).disabled, true);

  await gotoTab(detailPage(), "访问与安全");
  await click(btn("调整角色与权限", detailPage()));
  await waitFor(() => editDialog());
  await click([...editDialog().querySelectorAll("input[type=checkbox]")].find((input) => !input.disabled));
  await click(btn("保存权限", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("无法确认这次修改是否已送达"));
  await click(btn("取消编辑", editDialog()));
  await settle();

  const banners = [...detailPage().querySelectorAll('[role="status"]')].map((node) => node.textContent);
  assert.ok(banners.some((text) => text.includes("显示名称")), "第一条记录不能被第二条覆盖");
  assert.ok(banners.some((text) => text.includes("角色与个人权限")), "两条记录应并存显示");
  assert.equal(btn("编辑资料", detailPage()).disabled, true, "第二分区未确认不得使第一分区重新可用");
  assert.equal(btn("调整角色与权限", detailPage()).disabled, true);
  assert.equal(calls.filter((call) => call.route === "POST /security/admins/update").length, 1);
});

test("正路径：ACK 后一次成功的同目标读取解除锁定", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins/detail": (n) => (n === 0 ? json(detailFixture()) : n === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json(detailFixture({ name: "已改名" }))),
    "POST /security/admins/update": () => json({ ok: true }),
  });
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "已改名");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("已保存，但页面数据未能刷新"));
  assert.equal(btn("保存资料", editDialog()).disabled, true);
  await click(btn("重试刷新", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("已保存，但页面数据未能刷新") === false);
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 1, "恢复只走 GET");
  assert.equal(btn("编辑资料", detailPage()).disabled, false, "回读成功后不应继续锁定");
});

test("正路径：明确拒绝不是未知结果，纠错后可以重试", async (t) => {
  const calls = useServer({
    ...baseRoutes(detailFixture()),
    "POST /security/admins/update": (n) => (n === 0 ? json({ error: { code: "INVALID_ARGUMENT" } }, 400) : json({ ok: true })),
  });
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "第一次尝试");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => editDialog()?.textContent.includes("查询或输入有误"));
  assert.equal(editDialog().textContent.includes("无法确认这次修改是否已送达"), false, "4xx 明确拒绝不能显示成结果未知");
  typeInto(editDialog().querySelector("input"), "合法名字");
  await settle();
  assert.equal(btn("保存资料", editDialog()).disabled, false, "明确拒绝后必须仍可纠错重试");
  await click(btn("保存资料", editDialog()));
  await waitFor(() => calls.filter((call) => call.route === "POST /security/admins/update").length === 2);
});

test("UX4 对象路由先展示只读事实，独立分区编辑取消保留草稿，显式放弃不发送 POST", async (t) => {
  const calls = useServer(baseRoutes(detailFixture({ roles: [ACTIVE_ROLE] })));
  const view = mount(); t.after(view.cleanup);
  const page = await openDetail(view, { objectOnly: true });
  assert.equal(page.querySelector("h1").textContent, TARGET.name);
  assert.equal(editDialog(), undefined, "对象页不自动打开编辑窗口");
  assert.equal(page.querySelectorAll("input,textarea,select").length, 0, "事实页不摆放编辑控件");
  assert.ok(page.textContent.includes("账号变更记录"));
  assert.ok(!page.textContent.includes("admin.frozen"), "管理操作应使用人能读懂的名称");

  await click(btn("编辑资料", page));
  assert.equal(editDialog().querySelectorAll("input").length, 1, "资料编辑器只含显示名称输入");
  assert.equal(editDialog().querySelectorAll("input[type=checkbox],input[type=radio]").length, 0, "不混入其他分区的控件");
  await act(async () => typeInto(editDialog().querySelector("input"), "尚未保存的名称"));
  await click(btn("取消编辑", editDialog()));
  assert.ok(editDialog(), "有草稿时取消先说明影响，不静默关闭");
  assert.equal(editDialog().querySelector("input").value, "尚未保存的名称");
  await click(btn("放弃修改并关闭", editDialog()));
  assert.equal(editDialog(), undefined);
  assert.equal(page.querySelector("h1").textContent, TARGET.name);
  assert.equal(calls.filter(call => call.route.startsWith("POST")).length, 0, "取消与放弃均不发治理写");
});

test("姓名与行只打开本地信息弹窗，不新增工作区对象标签，菜单触发不误触发", async (t) => {
  const calls = useServer(baseRoutes(detailFixture()));
  const opened = [];
  const view = mount(); t.after(view.cleanup);
  await view.render({ initialUsername: undefined, onOpenObject: (username, title) => opened.push({ username, title }) });
  await waitFor(() => rowButtons("管理").length >= 0 && browser.document.querySelectorAll("tbody button[aria-label$=\"的更多操作\"]").length === 1);
  await click(btn(TARGET.name));
  await waitFor(() => detailPage());
  assert.equal(opened.length, 0, "姓名点击只开本地信息弹窗，不委派对象标签");
  assert.equal(calls.filter(call => call.route === "GET /security/admins/detail").length, 1);
  await click(btn("关闭", detailPage()));
  await settle();
  assert.equal(detailPage(), null, "关闭弹窗回到列表，筛选/排序/页码保留");
  await click(browser.document.querySelectorAll("tbody td")[1]);
  await waitFor(() => detailPage());
  assert.equal(opened.length, 0, "行区域同样只开本地弹窗");
  await click(btn("关闭", detailPage()));
  await settle();
  await click(browser.document.querySelector("tbody button[aria-label$=\"的更多操作\"]"));
  await settle();
  assert.equal(detailPage(), null, "菜单触发器只开菜单，不得顺带打开信息弹窗");
});

test("UX4 当前有读取能力但响应缺字段时显示未提供，不能冒充无权或空授权", async (t) => {
  const calls = useServer(baseRoutes(detailFixture({ roles: undefined, allowPermissions: undefined, denyPermissions: undefined, effectivePermissions: undefined })));
  const view = mount(); t.after(view.cleanup);
  const page = await openDetail(view);
  assert.ok(page.textContent.includes("角色信息未提供"));
  assert.ok(page.textContent.includes("有效权限未提供"));
  assert.ok(!page.textContent.includes("无权查看角色"));
  assert.ok(!page.textContent.includes("未分配角色"));
  assert.equal(btn("调整角色与权限", page).disabled, true);
  assert.equal(calls.filter(call => call.route.startsWith("POST")).length, 0);
});

test("站点存储不可用时宁可不提交，也不放行可能重复的治理写", async (t) => {
  const calls = useServer(baseRoutes(detailFixture()));
  const view = mount();
  t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "存储不可用时的修改");
  const original = globalThis.sessionStorage;
  delete globalThis.sessionStorage;
  t.after(() => {
    globalThis.sessionStorage = original;
  });
  await click(btn("保存资料", editDialog()));
  await settle(40);
  assert.equal(calls.filter((call) => call.route.startsWith("POST")).length, 0, "记不住原操作就不能冒发这一笔写");
  assert.ok(editDialog().textContent.includes("未提交任何写请求"), "必须说明为什么没有提交");
});

test("信息弹窗底栏：可用任务必须有 hover 反馈，不可用必须显式禁用", async (t) => {
  useServer(baseRoutes(detailFixture()));
  const view = mount();
  t.after(view.cleanup);
  const page = await openDetail(view);
  const labels = ["编辑资料", "调整角色与权限", "调整业务范围", "冻结账号", "撤销全部会话"];
  const buttons = labels.map((label) => [...page.querySelectorAll("button")].find((node) => node.textContent.trim() === label)).filter(Boolean);
  assert.ok(buttons.length >= 3, "任务入口应分布在各自信息块与底栏");
  for (const button of buttons) {
    if (button.disabled) continue;
    assert.ok(/hover:/.test(button.className), `${button.textContent.trim()} 可用时必须给出 hover 反馈`);
  }
  const freeze = buttons.find((button) => button.textContent.includes("冻结账号"));
  assert.ok(freeze && /destructive/.test(freeze.className), "破坏性动作必须在视觉上与编辑动作区分");
  const accessSection = [...page.querySelectorAll("section")].find((node) => node.textContent.includes("角色与有效能力"));
  assert.ok([...accessSection.querySelectorAll("button")].some((node) => node.textContent.trim() === "调整角色与权限"), "任务按钮要放在它所属的信息块内");
});

test("P0 会话列只说事实：零会话、有会话、未接入三种呈现，且头像回退首字", async (t) => {
  useServer({
    ...baseRoutes(detailFixture()),
    "GET /security/admins": () =>
      json({
        admins: [
          { ...TARGET, image: null, sessionSummary: { activeCount: 0, lockedCount: 0, lastSessionCreatedAt: null } },
          { ...TARGET, id: "admin-3", username: "ZZ00003", name: "第二账号", image: "https://cdn.example/b.png", sessionSummary: { activeCount: 2, lockedCount: 1, lastSessionCreatedAt: "2026-10-10T08:00:00Z" } },
          { ...TARGET, id: "admin-4", username: "ZZ00004", name: "旧接口账号" },
        ],
      }),
  });
  const view = mount();
  t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await waitFor(() => browser.document.querySelectorAll("tbody tr").length === 3);
  const cells = [...browser.document.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[5]?.textContent ?? "");
  assert.ok(cells[0]?.includes("无未过期会话"), "零会话是事实，不是未接入");
  assert.ok(cells[1]?.includes("2 个未过期会话") && cells[1]?.includes("含 1 锁定"), "有会话时给出计数与锁定数");
  assert.ok(cells[2]?.includes("未接入"), "旧接口不返回会话摘要时标未接入，不冒充 0");
  const fallbacks = [...browser.document.querySelectorAll("tbody [data-slot=avatar-fallback], tbody .size-8")].map((node) => node.textContent.trim());
  assert.ok(fallbacks.includes("测") || fallbacks.includes("第"), "无头像时回退姓名首字");
  assert.ok(!browser.document.body.textContent.includes("在线"), "会话数不得被叫作在线");
  await click(browser.document.querySelector("tbody tr button"));
  await waitFor(() => detailPage());
  const modalText = detailPage().textContent;
  assert.ok(modalText.includes("未过期会话") && modalText.includes("最近建立"), "弹窗会话事实沿用列表口径");
  assert.ok(!modalText.includes("活跃会话"), "弹窗不得把未过期会话叫作活跃会话");
});

test("P1 缺预检、空预检、缺单项：快捷入口与信息窗口统一禁用，零 POST", async () => {
  for (const actions of [undefined, [], [ALLOWED_ACTIONS.find((entry) => entry.action === "assign")]]) {
    const calls = useServer({ ...baseRoutes(detailFixture({ actions })), "GET /security/admins": () => json({ admins: [{ ...TARGET, actions }] }) });
    const view = mount();
    try {
      await view.render({ initialUsername: undefined });
      await waitFor(() => browser.document.querySelector("tbody tr"));
      const shortcut = browser.document.querySelector(`button[aria-label="编辑 ${TARGET.name} 的显示名称"]`);
      assert.equal(shortcut.disabled, true);
      await click(browser.document.querySelector("tbody tr button"));
      await waitFor(() => detailPage()?.querySelector("h1"));
      for (const label of ["编辑资料", "调整业务范围", "冻结账号"]) assert.equal(btn(label, detailPage()).disabled, true, label);
      assert.equal(btn("调整角色与权限", detailPage()).disabled, !actions?.some((entry) => entry.action === "assign" && entry.allowed === true));
      assert.ok(detailPage().textContent.includes("操作资格未提供"));
      assert.equal(calls.filter((call) => call.route.startsWith("POST ")).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("P1 列表允许但详情缺资格时，不得自动打开可写编辑器", async (t) => {
  const calls = useServer({ ...baseRoutes(detailFixture({ actions: undefined })), "GET /security/admins": () => json({ admins: [{ ...TARGET, actions: ALLOWED_ACTIONS }] }) });
  const view = mount(); t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await waitFor(() => browser.document.querySelector("tbody tr"));
  await click(browser.document.querySelector(`button[aria-label="编辑 ${TARGET.name} 的显示名称"]`));
  await waitFor(() => detailPage()?.textContent.includes("操作资格未提供"));
  assert.equal(editDialog(), undefined);
  assert.equal(calls.filter((call) => call.route.startsWith("POST ")).length, 0);
});

test("P1 编辑器打开后收回当前写能力，保存禁用且不发送 POST", async (t) => {
  const calls = useServer(baseRoutes(detailFixture()));
  const view = mount(); t.after(view.cleanup);
  await openEditor(view);
  typeInto(editDialog().querySelector("input"), "本地草稿");
  await settle();
  assert.equal(btn("保存资料", editDialog()).disabled, false);
  await view.render({ snapshot: snap(["admin.account.read", "admin.role.read", "admin.permission.read"], "admin-boss", view.sessionId) });
  const save = btn("保存资料", editDialog());
  assert.ok(!save || save.disabled, "收回写能力后保留现有隐藏规则或显式禁用，均不得提交");
  if (save) await click(save);
  assert.ok(editDialog().textContent.includes("没有该操作的权限"));
  assert.equal(calls.filter((call) => call.route.startsWith("POST ")).length, 0);
});

test("P2 信息窗会话三态：缺字段标未接入，零锁定明确显示0", async () => {
  for (const sessionSummary of [undefined, { activeCount: 0, lockedCount: 0, lastSessionCreatedAt: null }]) {
    const calls = useServer(baseRoutes(detailFixture({ sessionSummary })));
    const view = mount();
    try {
      const page = await openDetail(view);
      const value = (label) => [...page.querySelectorAll("dt")].find((node) => node.textContent === label)?.parentElement.querySelector("dd")?.textContent;
      assert.equal(value("未过期会话"), sessionSummary ? "0 个" : "未接入");
      assert.equal(value("其中锁定"), sessionSummary ? "0 个" : "未接入");
      assert.equal(value("最近建立"), sessionSummary ? "无未过期会话" : "未接入");
      assert.equal(calls.filter((call) => call.route.startsWith("POST ")).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("P2 信息窗读取中与详情均有可访问名称", async (t) => {
  let finish;
  useServer({ ...baseRoutes(detailFixture()), "GET /security/admins/detail": () => new Promise((resolve) => { finish = () => resolve(json(detailFixture())); }) });
  const view = mount(); t.after(view.cleanup);
  await view.render();
  await waitFor(() => detailPage());
  const title = () => browser.document.getElementById(detailPage().getAttribute("aria-labelledby"))?.textContent;
  assert.equal(title(), "管理员信息");
  await act(async () => finish());
  await waitFor(() => detailPage()?.querySelector("h1"));
  assert.equal(title(), TARGET.name);
});

test("P2 七列表头、正文、colgroup一致，不在窄屏隐藏单独一列", async (t) => {
  useServer(baseRoutes(detailFixture()));
  const view = mount(); t.after(view.cleanup);
  await view.render({ initialUsername: undefined });
  await waitFor(() => browser.document.querySelector("tbody tr"));
  const table = browser.document.querySelector(".admin-directory-table");
  assert.equal(table.querySelectorAll("col").length, 7);
  assert.equal(table.querySelectorAll("th").length, 7);
  assert.equal(table.querySelectorAll("tbody tr:first-child td").length, 7);
  for (const cell of table.querySelectorAll("th,td")) assert.equal(cell.classList.contains("hidden"), false);
});

test("D3 创建必须显式选范围，旧接口未声明支持时拒绝发送", async () => {
  for (const supported of [true, false]) {
    const calls = useServer({ ...baseRoutes(detailFixture()), "GET /security/admins": () => json({ admins: [TARGET], ...(supported ? { createScopeRequired: true } : {}) }) });
    const view = mount();
    try {
      await view.render({ initialUsername: undefined });
      await waitFor(() => browser.document.querySelector("tbody tr"));
      await click(btn("新增管理员"));
      const dialog = dialogWith("对方首次登录必须改密");
      assert.ok(dialog);
      typeInto(dialog.querySelector("input"), "Explicit scope fixture");
      assert.equal(dialog.querySelector('input[type="radio"]:checked'), null);
      assert.equal(btn("创建管理员", dialog).disabled, true);
      await act(async () => dialog.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(calls.filter((call) => call.route.startsWith("POST ")).length, 0);
      if (!supported) assert.ok(dialog.textContent.includes("未接入创建时业务范围"));
    } finally { await view.cleanup(); }
  }
});
