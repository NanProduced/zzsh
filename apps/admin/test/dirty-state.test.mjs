import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { applyDirtyMap, clearDirtyForTabs } from "../src/workspace/dirty-state.ts";
import { tabsRemovedBy, tabFromLocation } from "../src/workspace/tab-model.ts";

test("dirty map returns the same object when the flag does not change", () => {
  const empty = {};
  assert.equal(applyDirtyMap(empty, "roles", false), empty);
  const dirty = applyDirtyMap(empty, "roles", true);
  assert.notEqual(dirty, empty);
  assert.equal(applyDirtyMap(dirty, "roles", true), dirty);
  const cleared = applyDirtyMap(dirty, "roles", false);
  assert.equal("roles" in cleared, false);
  assert.deepEqual(cleared, {});
  assert.equal(clearDirtyForTabs(cleared, ["roles", "account"]), cleared);
  assert.equal(clearDirtyForTabs(empty, ["roles"]), empty);
  const bothDirty = applyDirtyMap(applyDirtyMap(empty, "roles", true), "account", true);
  const afterClose = clearDirtyForTabs(bothDirty, ["roles", "account"]);
  assert.deepEqual(afterClose, {});
  assert.notEqual(afterClose, bothDirty);
});

test("batch close inspects every tab that would actually close", () => {
  const tabs = [tabFromLocation("/workbench"), tabFromLocation("/admins"), tabFromLocation("/roles"), tabFromLocation("/account")];
  assert.deepEqual(tabsRemovedBy(tabs, "self", "workbench").map((tab) => tab.id), []);
  assert.deepEqual(tabsRemovedBy(tabs, "self", "admins").map((tab) => tab.id), ["admins"]);
  assert.deepEqual(tabsRemovedBy(tabs, "others", "admins").map((tab) => tab.id).sort(), ["account", "roles"]);
  assert.deepEqual(tabsRemovedBy(tabs, "right", "admins").map((tab) => tab.id), ["roles", "account"]);
});

test("mounted dirty reporter does not re-render in a feedback loop", async () => {
  const window = new Window({ url: "http://127.0.0.1/workbench" });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;

  let parentRenders = 0;
  function Child({ onDirtyChange }) {
    const [name, setName] = useState("ops");
    useEffect(() => {
      onDirtyChange(name !== "ops");
    }, [name, onDirtyChange]);
    useEffect(() => {
      setName("ops");
    }, []);
    return createElement("button", { onClick: () => setName("changed") }, name);
  }
  function Parent() {
    parentRenders += 1;
    const [dirtyIds, setDirtyIds] = useState({});
    const onDirtyChange = useCallback((dirty) => {
      setDirtyIds((current) => applyDirtyMap(current, "roles", dirty));
    }, []);
    return createElement("div", { "data-dirty": String(Boolean(dirtyIds.roles)) }, createElement(Child, { onDirtyChange }));
  }

  const rootNode = window.document.createElement("div");
  window.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  root.render(createElement(Parent));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(parentRenders >= 1 && parentRenders < 8, `unexpected render count ${parentRenders}`);
  root.unmount();
});
