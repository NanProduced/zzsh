import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendPlacement,
  clonePlacements,
  effectiveTimeRange,
  mergeGridReadback,
  movePlacement,
  normalizeDraft,
  placementsEqual,
  placementsFromGridReadback,
  resizePlacement,
  sortPlacementsForList,
  widgetCatalogEntry,
  widgetTimeBound,
} from "../src/workspace/layout-catalog.ts";
import { applyRemoteLayout, keepDraftOnConflict, reloadFromConflict, versionForOverwrite } from "../src/workspace/layout-conflict.ts";

const shortcuts = { id: "shortcuts", x: 0, y: 0, w: 6, h: 4 };
const account = { id: "account-security", x: 6, y: 0, w: 5, h: 4 };

test("cancel restores the saved layout and failed save keeps the draft", () => {
  const saved = normalizeDraft([shortcuts, account]);
  let draft = clonePlacements(saved);
  draft = normalizeDraft(draft.filter((item) => item.id !== "account-security"));
  draft.push({ id: "permission-guide", x: 0, y: 4, w: 4, h: 3, timeRange: "7d" });
  assert.equal(placementsEqual(draft, saved), false);

  const cancelled = clonePlacements(saved);
  assert.equal(placementsEqual(cancelled, saved), true);

  const failedSaveDraft = clonePlacements(draft);
  assert.equal(placementsEqual(failedSaveDraft, saved), false);
  assert.equal(failedSaveDraft.some((item) => item.id === "permission-guide"), true);
});

test("placementsEqual ignores array order but compares grid geometry", () => {
  const left = normalizeDraft([shortcuts, account]);
  const right = normalizeDraft([account, shortcuts]);
  assert.equal(placementsEqual(left, right), true);
  assert.equal(placementsEqual(left, normalizeDraft([{ ...account, x: 5 }, shortcuts])), false);
  assert.equal(placementsEqual(left, normalizeDraft([{ ...account, h: 5 }, shortcuts])), false);
});

test("409 keeps local draft until an explicit reload", () => {
  const draft = normalizeDraft([{ id: "permission-guide", x: 0, y: 0, w: 4, h: 3, timeRange: "7d" }]);
  const layout = {
    layoutKind: "admin.workspace.layout",
    layoutVersion: 2,
    version: 0,
    widgets: normalizeDraft([shortcuts]),
    filteredWidgetIds: [],
    defaults: [],
  };
  const remote = {
    ...layout,
    version: 1,
    widgets: normalizeDraft([account]),
  };
  const afterFetch = applyRemoteLayout({ layout, draft, editing: true, conflict: undefined }, remote, false);
  assert.equal(afterFetch.draft[0]?.id, "permission-guide");
  assert.equal(afterFetch.layout.version, 1);

  const conflicted = keepDraftOnConflict({ layout, draft, editing: true, conflict: undefined }, remote);
  assert.equal(conflicted.draft[0]?.id, "permission-guide");
  assert.equal(conflicted.conflict?.version, 1);
  assert.equal(versionForOverwrite(conflicted), 1);

  const reloaded = reloadFromConflict(conflicted);
  assert.equal(reloaded.draft[0]?.id, "account-security");
  assert.equal(reloaded.editing, false);
  assert.equal(reloaded.conflict, undefined);
});

test("time-bound widgets inherit the page range until explicitly overridden", () => {
  assert.equal(widgetTimeBound("pending-approvals"), false);
  assert.equal(widgetTimeBound("account-security"), false);
  assert.equal(effectiveTimeRange({ id: "pending-approvals", x: 0, y: 0, w: 6, h: 6 }, "7d"), "7d");
  assert.equal(effectiveTimeRange({ id: "pending-approvals", x: 0, y: 0, w: 6, h: 6, timeRange: "today" }, "7d"), "today");
});

test("grid readback keeps widget time ranges and drops unknown entries", () => {
  const previous = normalizeDraft([{ ...shortcuts, timeRange: "7d" }, account]);
  const readback = placementsFromGridReadback(
    [
      { id: "account-security", x: 0, y: 4, w: 5, h: 5 },
      { id: "shortcuts", x: 0, y: 0, w: 8, h: 4 },
      { id: "not-a-widget", x: 0, y: 9, w: 4, h: 3 },
    ],
    previous,
  );
  assert.deepEqual(readback, normalizeDraft([
    { id: "shortcuts", x: 0, y: 0, w: 8, h: 4, timeRange: "7d" },
    { id: "account-security", x: 0, y: 4, w: 5, h: 5 },
  ]));
});

test("grid readback restores w/h compressed away by GridStack save() when equal to minimums", () => {
  // GridStack save() 会删除与 minW/minH 相等的 w/h 字段；读回必须按目录最小尺寸还原，否则草稿会被误删。
  const previous = normalizeDraft([{ id: "account-security", x: 5, y: 6, w: 4, h: 4 }, shortcuts]);
  const readback = placementsFromGridReadback(
    [
      { id: "account-security", x: 5, y: 6, minW: 4, minH: 4 },
      { id: "shortcuts", x: 0, y: 0, w: 6, h: 4 },
    ],
    previous,
  );
  assert.deepEqual(readback, previous);
});

test("keyboard move and resize clamp to grid bounds and widget minimums", () => {
  const start = normalizeDraft([{ ...shortcuts }, { ...account }]);
  assert.deepEqual(movePlacement(start, "shortcuts", -1, -1).find((w) => w.id === "shortcuts"), { ...shortcuts, x: 0, y: 0 });
  assert.deepEqual(movePlacement(start, "shortcuts", 99, 2).find((w) => w.id === "shortcuts"), { ...shortcuts, x: 6, y: 2 });

  const minW = widgetCatalogEntry("account-security")?.minW;
  const minH = widgetCatalogEntry("account-security")?.minH;
  const shrunk = resizePlacement(start, "account-security", -99, -99).find((w) => w.id === "account-security");
  assert.equal(shrunk?.w, minW);
  assert.equal(shrunk?.h, minH);
  const widened = resizePlacement(start, "account-security", 99, 0).find((w) => w.id === "account-security");
  assert.equal(widened && widened.x + widened.w <= 12, true);
});

test("appendPlacement stacks new widgets below the current bottom with catalog defaults", () => {
  const next = appendPlacement(normalizeDraft([shortcuts, account]), "user-restore");
  assert.deepEqual(next, { id: "user-restore", x: 0, y: 4, w: 6, h: 3 });
  const catalog = widgetCatalogEntry("user-restore");
  assert.equal(next.w, catalog?.defW);
  assert.equal(next.h, catalog?.defH);
});

test("grid readback keeps an unblocked keyboard down move instead of compacting it back", () => {
  const target = normalizeDraft([{ ...shortcuts, y: 2 }, { ...account, y: 2 }]);
  const compacted = mergeGridReadback(
    target,
    normalizeDraft([{ ...shortcuts, y: 0 }, { ...account, y: 0 }]),
  );
  assert.deepEqual(compacted.find((item) => item.id === "shortcuts")?.y, 2);
  assert.deepEqual(compacted.find((item) => item.id === "account-security")?.y, 2);
});

test("grid readback still accepts collision resolution when a down move overlaps another widget", () => {
  const target = normalizeDraft([
    { id: "shortcuts", x: 0, y: 1, w: 6, h: 4 },
    { id: "account-security", x: 0, y: 0, w: 5, h: 4 },
  ]);
  const settled = normalizeDraft([
    { id: "shortcuts", x: 0, y: 0, w: 6, h: 4 },
    { id: "account-security", x: 0, y: 4, w: 5, h: 4 },
  ]);
  const merged = mergeGridReadback(target, settled);
  assert.equal(merged.find((item) => item.id === "shortcuts")?.y, 0);
});

test("narrow list order follows rows top to bottom, left to right", () => {
  const sorted = sortPlacementsForList([
    { id: "a", x: 6, y: 4, w: 4, h: 3 },
    { id: "b", x: 0, y: 4, w: 4, h: 3 },
    { id: "c", x: 0, y: 0, w: 6, h: 4 },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["c", "b", "a"]);
});
