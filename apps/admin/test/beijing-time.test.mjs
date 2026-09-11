import assert from "node:assert/strict";
import { test } from "node:test";

import { beijingCalendarDate, inBeijingRange, persistTimeRange } from "../src/workspace/beijing-time.ts";

test("today is Beijing calendar date, not the browser offset", () => {
  const beforeMidnight = new Date("2026-09-10T15:59:59.000Z");
  const afterMidnight = new Date("2026-09-10T16:00:00.000Z");
  assert.equal(beijingCalendarDate(beforeMidnight), "2026-09-10");
  assert.equal(beijingCalendarDate(afterMidnight), "2026-09-11");
});

test("persisted time range keeps today semantics instead of a frozen timestamp", () => {
  assert.equal(persistTimeRange("today"), "today");
  assert.equal(persistTimeRange("7d"), "7d");
  assert.equal(persistTimeRange("2026-09-10T00:00:00.000Z"), "today");
});

test("approval createdAt is filtered by Beijing calendar range, not labels", () => {
  const now = new Date("2026-09-11T08:00:00.000Z");
  assert.equal(inBeijingRange("2026-09-11T01:00:00.000Z", "today", now), true);
  assert.equal(inBeijingRange("2026-09-10T15:00:00.000Z", "today", now), false);
  assert.equal(inBeijingRange("2026-09-10T16:30:00.000Z", "7d", now), true);
  assert.equal(inBeijingRange(null, "today", now), false);
});
