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
