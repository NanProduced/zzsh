import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { classify, changedFiles } from "./ci-scope.mjs";

test("root and shared package changes expand to the full offline scope", () => {
  for (const file of ["package.json", "package-lock.json", "packages/ui/src/index.ts", "scripts/check-test-entries.mjs", "docs/testing.md"]) {
    assert.equal(classify([file]).full, true, file);
  }
});

test("a Web-only change does not start API, Admin or PG", () => {
  assert.deepEqual(classify(["apps/web/src/app/page.tsx"]), { full: false, api: false, web: true, admin: false, pg: false });
});

test("an API finance change selects API and PG", () => {
  assert.deepEqual(classify(["apps/api/src/finance/admin-finance-query.ts"]), { full: false, api: true, web: false, admin: false, pg: true });
});

test("a docs-only change runs no application suite", () => {
  assert.deepEqual(classify(["docs/architecture/testing-note.md"]), { full: false, api: false, web: false, admin: false, pg: false });
});

test("unknown paths fall back to full rather than silently skipping", () => {
  assert.equal(classify(["unexpected/new-file.ts"]).full, true);
  assert.equal(classify([]).full, true);
});

test("every registered PG suite and shared admission/supply helper selects PG", () => {
  const suites = JSON.parse(readFileSync(new URL("../apps/api/scripts/regression-suites.json", import.meta.url), "utf8"));
  for (const file of [...suites.map(suite => `apps/api/test/${suite}.test.ts`),
    "apps/api/src/config/test-resource.ts", "apps/api/src/supply/publishing.ts", "apps/api/src/auth/admin-context.ts",
    "apps/api/test/database-test-support.ts", "apps/api/scripts/regression-reset.mjs", "apps/api/migrations/business/meta/_journal.json"]) {
    assert.equal(classify([file]).pg, true, file);
  }
});

test("workspace entry/dependency changes and shared code cannot bypass full checks", () => {
  for (const file of ["apps/admin/package.json", "apps/web/package.json", "apps/api/package.json", "packages/ui/src/index.ts", ".node-version"]) {
    assert.equal(classify([file]).full, true, file);
    assert.equal(classify([file]).pg, true, file);
  }
});

test("changed paths include both rename sides without quoted or newline path loss", () => {
  const files = changedFiles({ BASE_SHA: "base", HEAD_SHA: "head" }, (command, args) => {
    assert.equal(command, "git"); assert.deepEqual(args, ["diff", "--no-renames", "--name-only", "-z", "base", "head", "--"]);
    return "apps/api/src/supply/publishing.ts\0docs/architecture/moved.txt\0odd\nname.ts\0";
  });
  assert.deepEqual(files, ["apps/api/src/supply/publishing.ts", "docs/architecture/moved.txt", "odd\nname.ts"]);
  assert.equal(classify(files).pg, true); assert.equal(classify(files).full, true);
  let called=false;assert.deepEqual(changedFiles({},()=>{called=true;}),[]);assert.equal(called,false);
  assert.throws(()=>changedFiles({BASE_SHA:"base",HEAD_SHA:"head"},()=>{throw Error("unavailable git diff");}),/unavailable git diff/);
});
