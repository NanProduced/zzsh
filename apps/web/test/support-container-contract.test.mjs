import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("mounts one persistent support rail and force-mounts the shared dialog portal", () => {
  const layout = read("app/layout.tsx");
  const rail = read("components/support/support-rail.tsx");
  assert.match(layout, /<SupportRail\s*\/>/);
  assert.match(rail, /<Dialog\.Root[^>]*modal=\{false\}/);
  assert.match(rail, /<Dialog\.Portal forceMount>/);
  assert.match(rail, /<Dialog\.Content forceMount/);
  assert.match(rail, /usePathname/);
  assert.doesNotMatch(read("components/portal-home.tsx"), /SupportRail/);
  assert.doesNotMatch(read("components/layout/service-shell.tsx"), /SupportRail/);
  assert.doesNotMatch(read("app/support/page.tsx"), /CustomerSupportWorkspace/);
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
