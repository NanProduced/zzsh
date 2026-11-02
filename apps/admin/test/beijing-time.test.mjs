import assert from "node:assert/strict";
import { test } from "node:test";

import { beijingCalendarDate, formatBeijingDateTime, inBeijingRange, persistTimeRange } from "../src/workspace/beijing-time.ts";

test("approval expiry crosses to the correct Beijing day independently of the browser time zone", () => {
  const previous = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const value = "2026-09-10T16:30:00.000Z";
    const expected = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
    assert.equal(formatBeijingDateTime(value), expected);
    assert.match(expected, /11.*00:30/);
    assert.notEqual(formatBeijingDateTime(value), new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)));
    assert.equal(formatBeijingDateTime(null), "未提供");
    assert.equal(formatBeijingDateTime("invalid"), "时间未知");
    assert.equal(formatBeijingDateTime(value, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }), "00:30");
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

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
