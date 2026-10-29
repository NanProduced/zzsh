import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire, Module } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 2026-03-05T16:30:00Z is 2026-03-06 00:30 in Asia/Shanghai (UTC+8, no DST).
// Hand-computed so the assertion is an absolute fact, not a re-run of the implementation.
const INSTANT = "2026-03-05T16:30:00Z";
const BEIJING_CLOCK = "00:30";
const BEIJING_DAY = "3月6日";

const here = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(here, "../../..");
const require = createRequire(path.join(tree, "package.json"));
const ts = require("typescript");
const CHILD = "ZZSH_BEIJING_DISPLAY_CHILD";

function loadFormatters() {
  const file = path.join(tree, "apps/admin/src/api.ts");
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(tree);
  m.require = (name) => (name.endsWith(".css") ? {} : require(name));
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    file,
  );
  return m.exports;
}

if (process.env[CHILD]) {
  process.stdout.write(loadFormatters().formatDate(INSTANT));
} else {
  // Re-run this file in a child whose host zone is deliberately not UTC+8.
  // Without the child, the assertion would pass or fail depending on the operator's machine.
  const renderUnder = (zone) =>
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: zone, [CHILD]: "1" },
      encoding: "utf8",
    }).trim();

  test("formatDate renders Beijing time regardless of the host zone", () => {
    for (const zone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
      const rendered = renderUnder(zone);
      assert.ok(rendered.includes(BEIJING_CLOCK), `TZ=${zone} rendered "${rendered}", expected the ${BEIJING_CLOCK} Beijing clock`);
      // The defect is a calendar-day shift, not only an offset: 16:30Z is 00:30 on the NEXT Beijing day.
      assert.ok(rendered.includes(BEIJING_DAY), `TZ=${zone} rendered "${rendered}", expected the Beijing calendar day ${BEIJING_DAY}`);
    }
  });

  test("formatDate keeps its existing missing-value contract", () => {
    const { formatDate } = loadFormatters();
    assert.equal(formatDate(null), "未提供");
    assert.equal(formatDate(""), "未提供");
    assert.equal(formatDate("not-a-time"), "时间未知");
  });
}
