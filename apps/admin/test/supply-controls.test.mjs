import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("the four supply pages use shared controls and their suites stay registered", () => {
  const root = new URL("../src/views/", import.meta.url);
  const files = ["supply-rules-view.tsx", "supply-catalog-view.tsx", "supply-listing-review-view.tsx", "supply-gunsmith-view.tsx", "supply-review/action-bar.tsx", "supply-review/detail-pane.tsx"];
  for (const directory of ["supply-rules", "supply-catalog", "supply-accounts", "supply-gunsmith"]) {
    files.push(...readdirSync(new URL(`${directory}/`, root)).filter(file => file.endsWith(".tsx")).map(file => `${directory}/${file}`));
  }
  for (const file of files) {
    assert.doesNotMatch(readFileSync(new URL(file, root), "utf8"), /<(?:button|input|select|textarea|details|summary|dialog|table)\b/, `${file} has an unwrapped control`);
  }
  const script = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.test;
  for (const file of ["supply-controls", "supply-write-lock", "supply-accounts-model", "supply-accounts-component", "supply-gunsmith-component", "supply-rules-edit"]) assert.ok(script.includes(`test/${file}.test.mjs`), file);
});

test("shared supply controls preserve empty filters, checkbox and textarea behavior", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const { createRoot } = await import("react-dom/client");
  const el = document.createElement("div"); document.body.append(el);
  const root = createRoot(el);
  try {
    const { SupplySelect } = await vite.ssrLoadModule("/src/components/supply/supply-select.tsx");
    const { Checkbox } = await vite.ssrLoadModule("/src/components/ui/checkbox.tsx");
    const { Textarea } = await vite.ssrLoadModule("/src/components/ui/textarea.tsx");
    function Controls() {
      const [value, setValue] = useState(""), [checked, setChecked] = useState(false);
      return createElement("div", null,
        createElement(SupplySelect, { label: "游戏范围", value, onValueChange: setValue, options: [{ value: "", label: "全部游戏" }, { value: "delta", label: "三角洲行动" }, { value: "closed", label: "待接入游戏", disabled: true }] }),
        createElement(Checkbox, { id: "supply-check", "aria-label": "确认核对", checked, onCheckedChange: setChecked }),
        createElement("label", { htmlFor: "supply-check" }, "已核对当前资料"),
        createElement(Textarea, { "aria-label": "说明", defaultValue: "原说明", maxLength: 500, disabled: checked }));
    }
    await act(async () => root.render(createElement(Controls)));
    const select = () => document.querySelector('[aria-label="游戏范围"]');
    const choose = async label => {
      await act(async () => select().click());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent === label);
      assert.ok(option, label);
      await act(async () => option.click());
    };
    assert.match(select().textContent, /全部游戏/);
    await choose("三角洲行动"); assert.match(select().textContent, /三角洲行动/);
    await choose("全部游戏"); assert.match(select().textContent, /全部游戏/);
    const checkbox = document.querySelector('[aria-label="确认核对"]');
    assert.equal(checkbox.getAttribute("aria-checked"), "false");
    await act(async () => checkbox.click());
    assert.equal(checkbox.getAttribute("aria-checked"), "true");
    const textarea = document.querySelector('[aria-label="说明"]');
    assert.equal(textarea.value, "原说明");
    assert.equal(textarea.maxLength, 500);
    assert.equal(textarea.disabled, true);
    await act(async () => document.querySelector('label[for="supply-check"]').click());
    assert.equal(checkbox.getAttribute("aria-checked"), "false");
    assert.equal(textarea.disabled, false);
  } finally {
    await act(async () => root.unmount());
    el.remove(); await vite.close(); await browser.happyDOM.close();
  }
});
