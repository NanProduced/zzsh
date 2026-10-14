import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

const EMBLA_STUB = `
const handlers = {};
function emit(name) { (handlers[name] || []).slice().forEach((fn) => fn(api)); }
const api = {
  container: null,
  index: 0,
  calls: [],
  on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
  off(name, fn) { handlers[name] = (handlers[name] || []).filter((item) => item !== fn); },
  selectedScrollSnap: () => api.index,
  scrollSnapList: () => Array.from({length:10}, (_, i) => i / 9),
  scrollProgress: () => api.index / 9,
  scrollTo(next, immediate) { api.index = next; api.calls.push([next, immediate === true]); emit("select"); emit("scroll"); },
  scrollPrev() { api.scrollTo(api.index - 1); },
  scrollNext() { api.scrollTo(api.index + 1); },
  reInit() { emit("reInit"); },
  slideNodes: () => [],
  containerNode: () => api.container,
  canScrollPrev: () => api.index > 0,
  canScrollNext: () => api.index < 5,
};
globalThis.__mcEmbla = api;
export default function useEmblaCarousel() {
  return [(node) => { api.container = node; }, api];
}
`;

const DIALOG_STUB = `
import { createElement } from "react";
export const Root = ({ children }) => createElement("div", { "data-dialog-root": true }, children);
export const Trigger = ({ children }) => children;
export const Portal = ({ children }) => children;
export const Overlay = () => null;
export const Content = ({ children }) => createElement("div", { role: "dialog" }, children);
export const Title = ({ children }) => createElement("h2", null, children);
export const Close = ({ children }) => children;
`;

const LINK_STUB = `
import { createElement } from "react";
export default function Link(props) {
  const { children, ...rest } = props;
  return createElement("a", rest, children);
}
`;

const stubs = {
  name: "membership-center-stubs",
  enforce: "pre",
  resolveId(id) {
    if (id === "embla-carousel-react") return "\0mc-embla";
    if (id === "@radix-ui/react-dialog") return "\0mc-dialog";
    if (id === "next/link") return "\0mc-link";
    return null;
  },
  load(id) {
    if (id === "\0mc-embla") return EMBLA_STUB;
    if (id === "\0mc-dialog") return DIALOG_STUB;
    if (id === "\0mc-link") return LINK_STUB;
    return null;
  },
};

const comparison = [
  { tier: "普通会员", deposit: "租客押金按账号条件缴纳", pricing: "价格方案未就绪" },
  { tier: "银卡会员", deposit: "租客押金按账号条件缴纳", pricing: "价格方案未就绪" },
  { tier: "金卡会员", deposit: "租客押金按账号条件缴纳", pricing: "价格方案未就绪" },
  { tier: "铂金会员", deposit: "免租客押金", pricing: "完整方案可比价" },
  { tier: "钻石会员", deposit: "免租客押金", pricing: "完整方案可比价" },
];

function ready(overrides = {}) {
  return {
    status: "ready",
    data: {
      tier: "GOLD",
      rollingPoints: "12480",
      lifetimePoints: "28600",
      asOf: "2026-10-11T00:00:00.000Z",
      windowStart: "2026-07-13T00:00:00.000Z",
      benefitsState: "CONFIGURED",
      nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "7520" },
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [{ label: "租客押金", value: "租客押金按账号条件缴纳" }],
      comparison,
      entitlements: [],
      contributions: [{ label: "租赁结算消费", effectiveAt: "2026-10-11T11:30:00.000Z", amountCents: "12000", exitsAt: "2027-01-09T00:00:00.000Z", kind: "CONSUMPTION" }],
      pendingCount: 0,
      ...overrides,
    },
  };
}

async function loadView() {
  const browser = new Window({ url: "http://127.0.0.1:4360/account?view=membership" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    matchMedia: (query) => browser.matchMedia(query),
    self: browser,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  });
  const vite = await createServer({
    configFile: false,
    root: rootPath,
    plugins: [react(), stubs],
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ["embla-carousel-react", "@radix-ui/react-dialog", "next/link"] },
  });
  const { MembershipCenterView } = await vite.ssrLoadModule("/src/components/account/membership-center.tsx");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  return {
    browser,
    host,
    async render(props) {
      await act(async () => root.render(createElement(MembershipCenterView, props)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async click(selector) {
      const target = host.querySelector(selector);
      assert.ok(target, `missing ${selector}`);
      await act(async () => {
        target.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, button: 0 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return target;
    },
    async key(selector, key) {
      const target = host.querySelector(selector);
      assert.ok(target, `missing ${selector}`);
      await act(async () => {
        target.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      await vite.close();
      await browser.happyDOM.abort();
    },
  };
}

const checkedTier = (host) => host.querySelector('.mc-node[aria-checked="true"]')?.getAttribute("data-tier");

test("membership center focuses the actual tier and keeps personal facts while previewing", async () => {
  const view = await loadView();
  try {
    const state = ready({
      entitlements: [{ id: "e1", kind: "PRESTIGE", label: "尊享礼遇", scope: "DELTA_ACCOUNT_RENTAL", startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-12-31T00:00:00.000Z", state: "ACTIVE", depositWaived: true }],
    });
    await view.render({ state });
    assert.match(view.host.textContent, /当前：金卡会员/);
    assert.equal(checkedTier(view.host), "GOLD");
    assert.match(view.host.querySelector(".mc-card-img").getAttribute("src"), /gold-card\.webp/);
    assert.match(view.host.textContent, /距铂金还差/);
    assert.match(view.host.textContent, /12,480 \/ 20,000/);
    assert.match(view.host.textContent, /我的金卡权益/);
    assert.match(view.host.textContent, /租客押金按账号条件缴纳/);
    assert.equal(view.host.querySelector(".mc-return").style.visibility, "hidden");
    assert.equal(view.host.querySelector(".mc-return").disabled, true);
    const entitlementBefore = view.host.querySelector(".mc-entitlement-row").textContent;

    await view.click('.mc-node[data-tier="PLATINUM"]');
    assert.equal(checkedTier(view.host), "PLATINUM");
    assert.match(view.host.querySelector(".mc-card-img").getAttribute("src"), /platinum-card\.webp/);
    assert.match(view.host.textContent, /铂金权益预览/);
    assert.match(view.host.textContent, /尚未达到/);
    assert.match(view.host.textContent, /达到铂金还差/);
    assert.match(view.host.textContent, /12,480/);
    assert.equal(view.host.querySelector(".mc-entitlement-row").textContent, entitlementBefore);
    assert.match(view.host.textContent, /返回当前等级/);

    await view.click(".mc-return");
    assert.equal(checkedTier(view.host), "GOLD");
    assert.equal(view.host.querySelector(".mc-return").style.visibility, "hidden");
    assert.equal(view.host.querySelector(".mc-return").disabled, true);

    await view.key('[role="radiogroup"]', "ArrowRight");
    assert.equal(checkedTier(view.host), "PLATINUM");
    await view.key('[role="radiogroup"]', "End");
    assert.equal(checkedTier(view.host), "BLACK_GOLD");
    assert.equal(view.host.querySelector(".mc-arrow--next").disabled, true);
    await view.key('[role="radiogroup"]', "Home");
    assert.equal(checkedTier(view.host), "STANDARD");
    assert.equal(view.host.querySelector(".mc-arrow--prev").disabled, true);
    assert.equal(view.browser.document.activeElement?.getAttribute?.("data-tier"), "STANDARD");
    assert.match(view.host.textContent, /普通等级不设成长门槛/);
    assert.equal(view.host.querySelector(".mc-progress"), null);

    await view.key('[role="radiogroup"]', "End");
    assert.equal(checkedTier(view.host), "BLACK_GOLD");
    await view.key('[role="radiogroup"]', "ArrowLeft");
    assert.equal(checkedTier(view.host), "DIAMOND");
    await view.click(".mc-return");
    assert.equal(checkedTier(view.host), "GOLD");
    assert.equal(view.browser.document.activeElement?.getAttribute?.("data-tier"), "GOLD");
  } finally {
    await view.dispose();
  }
});

test("ghost snaps beyond the real tiers snap back immediately without moving the selection", async () => {
  const view = await loadView();
  try {
    await view.render({ state: ready() });
    assert.equal(checkedTier(view.host), "GOLD");
    const api = globalThis.__mcEmbla;
    await view.render({ state: ready() });
    api.calls.length = 0;
    await act(async () => {
      api.scrollTo(7);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(checkedTier(view.host), "BLACK_GOLD");
    assert.deepEqual(api.calls.at(-1), [5, true]);
    api.calls.length = 0;
    await act(async () => {
      api.scrollTo(7);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(checkedTier(view.host), "BLACK_GOLD");
    assert.deepEqual(api.calls.at(-1), [5, true]);
    api.calls.length = 0;
    await act(async () => {
      api.scrollTo(-1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(checkedTier(view.host), "STANDARD");
    assert.deepEqual(api.calls.at(-1), [0, true]);
  } finally {
    await view.dispose();
  }
});

test("a standard member sees the server next-tier gap and progress on their own tier", async () => {
  const view = await loadView();
  try {
    await view.render({ state: ready({ tier: "STANDARD", rollingPoints: "1000", lifetimePoints: "1000", nextTier: { tier: "SILVER", threshold: "5000", remaining: "4000" } }) });
    assert.equal(checkedTier(view.host), "STANDARD");
    assert.match(view.host.textContent, /距银卡还差/);
    assert.match(view.host.textContent, /4,000/);
    assert.match(view.host.textContent, /1,000 \/ 5,000/);
    assert.equal(view.host.querySelector(".mc-progress-bar").getAttribute("aria-valuenow"), "20");
  } finally {
    await view.dispose();
  }
});

test("black gold uses the lifetime basis and grace gaps never render null as zero", async () => {
  const view = await loadView();
  try {
    const blackGold = ready({
      tier: "BLACK_GOLD",
      rollingPoints: "300",
      lifetimePoints: "52000",
      nextTier: null,
    });
    await view.render({ state: blackGold });
    assert.equal(checkedTier(view.host), "BLACK_GOLD");
    assert.match(view.host.textContent, /累计成长/);
    assert.match(view.host.textContent, /52,000/);
    assert.match(view.host.textContent, /终身资格已保留/);
    assert.match(view.host.textContent, /累计成长进度/);
    assert.equal(view.host.querySelector('.mc-progress-bar').getAttribute("aria-valuenow"), "100");
    assert.doesNotMatch(view.host.textContent, /300 \/ 50,000/);

    const grace = ready({
      tier: "DIAMOND",
      rollingPoints: "8000",
      nextTier: null,
      grace: { state: "ACTIVE", fromTier: "DIAMOND", until: "2026-10-18T00:00:00.000Z", gapPoints: null },
    });
    await view.render({ state: grace });
    assert.match(view.host.textContent, /权益保留至/);
    assert.match(view.host.textContent, /待确认/);
    assert.doesNotMatch(view.host.textContent, /门槛 0 分/);
  } finally {
    await view.dispose();
  }
});

test("entitlements keep server states, scopes and periods separate from tier preview", async () => {
  const view = await loadView();
  try {
    const state = ready({
      entitlements: [
        { id: "e1", kind: "PRESTIGE", label: "尊享礼遇", scope: "DELTA_ACCOUNT_RENTAL", startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-12-31T00:00:00.000Z", state: "ACTIVE", depositWaived: true },
        { id: "e2", kind: "FRIEND", label: "挚友礼遇", scope: "game:mystery", startsAt: "2026-02-01T00:00:00.000Z", endsAt: "2026-11-30T00:00:00.000Z", state: "ACTIVE", depositWaived: false },
        { id: "e3", kind: "FRIEND", label: "挚友礼遇", scope: "ALL_PLATFORM", startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z", state: "EXECUTED_PENDING_START", depositWaived: false },
        { id: "e4", kind: "PRESTIGE", label: "尊享礼遇", scope: "ALL_PLATFORM", startsAt: "2025-01-01T00:00:00.000Z", endsAt: "2025-06-01T00:00:00.000Z", state: "EXPIRED", depositWaived: false },
        { id: "e5", kind: "UNKNOWN", label: "未知礼遇", scope: "ALL_PLATFORM", startsAt: "2026-03-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z", state: "UNKNOWN", depositWaived: false },
      ],
    });
    await view.render({ state });
    const activeRows = view.host.querySelectorAll(".mc-entitlement-list:not(.mc-entitlement-list--history) > li");
    assert.equal(activeRows.length, 2);
    assert.match(activeRows[0].textContent, /尊享礼遇/);
    assert.match(activeRows[0].textContent, /生效中/);
    assert.match(activeRows[0].textContent, /三角洲租赁/);
    assert.match(activeRows[0].textContent, /有效至 2026\.12\.31/);
    assert.match(activeRows[1].textContent, /范围待确认/);
    assert.match(view.host.textContent, /待生效与历史礼遇（3）/);
    assert.match(view.host.textContent, /状态待确认/);
    assert.doesNotMatch(view.host.textContent, /game:mystery/);
    assert.equal(view.host.querySelectorAll(".account-entitlement-badge-icon").length, 1);

    const empty = ready({ entitlements: [] });
    await view.render({ state: empty });
    assert.match(view.host.textContent, /暂无生效中的专属礼遇/);
    assert.equal(view.host.querySelector(".mc-details"), null);
    assert.equal(view.host.querySelector(".mc-entitlement-list"), null);
  } finally {
    await view.dispose();
  }
});

test("points ledger separates real consumption records from unavailable event deltas", async () => {
  const view = await loadView();
  try {
    await view.render({ state: ready() });
    assert.match(view.host.textContent, /积分变动明细暂不可用/);
    assert.match(view.host.textContent, /当前窗口有效消费记录/);
    assert.match(view.host.textContent, /¥120\.00/);
    assert.match(view.host.textContent, /统计窗口 2026\.07\.13 – 2026\.10\.11/);
    assert.doesNotMatch(view.host.textContent, /暂无变动/);
    assert.equal(view.host.querySelector(".mc-ledger-row"), null);

    await view.render({
      state: ready({ contributions: [] }),
      pointEvents: [
        { id: "p1", at: "2026-10-11T11:30:00.000Z", reason: "租赁结算", rollingDelta: "240", lifetimeDelta: "240" },
        { id: "p2", at: "2026-10-09T00:00:00.000Z", reason: "消费退出90天", rollingDelta: "-300", lifetimeDelta: "0" },
      ],
    });
    const rows = view.host.querySelectorAll(".mc-ledger-row");
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /\+240/);
    assert.match(rows[1].textContent, /−300/);
    assert.match(rows[1].textContent, /不变/);
    assert.match(view.host.textContent, /当前窗口没有有效消费记录/);
  } finally {
    await view.dispose();
  }
});

test("benefits distinguish unpublished policy from read failures and unknown states", async () => {
  const view = await loadView();
  try {
    await view.render({ state: ready({ benefitsState: "NOT_CONFIGURED" }) });
    assert.match(view.host.textContent, /具体政策待公布/);
    await view.render({ state: ready({ comparison: [{ tier: "VIP会员", deposit: "免租客押金", pricing: "完整方案可比价" }] }) });
    assert.match(view.host.textContent, /租客押金按账号条件缴纳/);
    await view.click('.mc-node[data-tier="SILVER"]');
    assert.match(view.host.textContent, /该档权益暂时无法展示/);
    assert.doesNotMatch(view.host.textContent, /免租客押金/);
    await view.render({ state: ready({ tier: "UNKNOWN" }) });
    assert.match(view.host.textContent, /资格待确认/);
    assert.equal(view.host.querySelector(".mc-track"), null);
    assert.equal(view.host.querySelector(".mc-card-img"), null);
    assert.doesNotMatch(view.host.textContent, /0 分/);

    await view.render({ state: { status: "permission", message: "当前身份没有查看成长档案的权限" } });
    assert.match(view.host.textContent, /无法查看/);
    await view.render({ state: { status: "unknown", message: "消费来源尚未完成核验，暂不展示成长积分" } });
    assert.match(view.host.textContent, /消费来源尚未完成核验/);
    assert.doesNotMatch(view.host.textContent, /普通会员/);
    await view.render({ state: { status: "error", message: "会员成长暂时无法读取", retryable: true }, onRetry: () => {} });
    const retry = view.host.querySelector("[data-testid=retry-membership-center]");
    assert.ok(retry);
    await view.render({ state: { status: "loading" } });
    assert.match(view.host.textContent, /正在读取成长档案/);
  } finally {
    await view.dispose();
  }
});


test("tier dots keep actual identity while previewing and progress uses the accessible primitive", async () => {
  const view = await loadView();
  try {
    await view.render({ state: ready({ tier: "STANDARD", rollingPoints: "0", lifetimePoints: "0", nextTier: { tier: "SILVER", threshold: "5000", remaining: "5000" } }) });
    assert.equal(view.host.querySelectorAll('.mc-node-dot').length, 6);
    const progress = view.host.querySelector('[data-slot="progress"]');
    assert.equal(progress.getAttribute('role'), 'progressbar');
    assert.equal(progress.getAttribute('aria-valuenow'), '0');
    assert.equal(progress.getAttribute('aria-valuetext'), '0 / 5,000');
    assert.equal(progress.querySelector('[data-slot="progress-indicator"]').style.width, '0%');
    await view.click('.mc-node[data-tier="PLATINUM"]');
    assert.equal(view.host.querySelector('.mc-node[data-current]')?.getAttribute('data-tier'), 'STANDARD');
    assert.equal(view.host.querySelector('.mc-node[data-current] .mc-node-current').textContent, '当前');
    assert.equal(checkedTier(view.host), 'PLATINUM');
    assert(globalThis.__mcEmbla.calls.some(([snap, immediate]) => snap === 3 && !immediate), 'user selection must animate rather than reinitialize immediately');
  } finally { await view.dispose(); }
});
