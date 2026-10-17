import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const exists = (path) => existsSync(new URL(path, root));

test("mounts one persistent support rail and force-mounts the shared dialog portal", () => {
  const layout = read("app/layout.tsx");
  const rail = read("components/support/support-rail.tsx");
  assert.match(layout, /<SupportRail\s*\/>/);
  assert.match(rail, /<Dialog\.Root[^>]*modal=\{false\}/);
  assert.match(rail, /<Dialog\.Portal forceMount>/);
  assert.match(rail, /<Dialog\.Content forceMount/);
  assert.match(rail, /window\.addEventListener\("zzsh:open-support",open\)/);
  assert.doesNotMatch(read("components/portal-home.tsx"), /SupportRail/);
  assert.doesNotMatch(read("components/layout/service-shell.tsx"), /SupportRail/);
});

test("customer service has exactly one container: the rail dialog, never a route of its own", () => {
  // 联系客服只有右侧常驻工具列弹窗这一个容器（DESIGN.md：常驻工具含联系客服、投诉建议）。
  // 曾经存在的 /support 落地页已移除；没有路由，就没有第二套容器可以漂移。
  assert.equal(exists("app/support/page.tsx"), false, "/support must not come back as its own route");
  assert.doesNotMatch(read("components/support/support-rail.tsx"), /navigateTo|router\.push/);
  // 页面内入口统一发窗口事件，由 rail 接住；不许哪个页面自己挂一份客服工作台。
  const web = read("components/support/support-dialog-request.ts");
  assert.match(web, /zzsh:open-support/);
  for (const page of ["components/help/help-page.tsx", "components/help/help-article.tsx", "components/status/status-content.tsx"]) {
    assert.doesNotMatch(read(page), /CustomerSupportWorkspace/);
    assert.doesNotMatch(read(page), /href="\/support"/);
  }
});

test("the touch rail folds into one labelled FAB that reveals the tools only when opened", () => {
  const rail = read("components/support/support-rail.tsx");
  const nav = read("components/support/service-navigation.css");
  // The toggle is named for both states and publishes its expansion state to the stylesheet.
  assert.match(rail, /aria-expanded=\{toolsOpen\}/);
  assert.match(rail, /aria-label=\{toolsOpen \? "收起常用工具" : "展开常用工具"\}/);
  assert.match(rail, /data-expanded=\{toolsOpen \? "true" : "false"\}/);
  // Escape and choosing a tool both close the folded panel again.
  assert.match(rail, /event\.key === "Escape"/);
  assert.match(rail, /closest\("\.rail-item"\)/);
  // On touch layouts the tools stay hidden until the rail is expanded, so nothing lies across content.
  assert.match(nav, /\.rail-fab \{ display:none;/);
  assert.match(nav, /\.support-rail \.rail-item \{ display:none;/);
  assert.match(nav, /\.support-rail\[data-expanded="true"\] \.rail-item \{ display:flex; \}/);
});
