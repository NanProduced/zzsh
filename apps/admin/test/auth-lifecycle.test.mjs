import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const apiSource = source("api.ts");
const mainSource = source("main.tsx");
const supportSource = source("views/im-support-view.tsx");

test("admin protected auth failures refresh the session without turning 403 into logout", () => {
  assert.match(apiSource, /ADMIN_AUTH_FAILURE_EVENT/);
  assert.match(apiSource, /response\.status === 401 \|\| response\.status === 423/);
  assert.match(apiSource, /path !== "\/session" && !path\.startsWith\("\/auth\/"\)/);
  assert.match(mainSource, /window\.addEventListener\(ADMIN_AUTH_FAILURE_EVENT/);
  assert.match(mainSource, /refreshSession\(status === 401\)/);
  assert.match(supportSource, /snapshot\.session\.locked/);
  assert.match(supportSource, /blockedConsultations/);
});
