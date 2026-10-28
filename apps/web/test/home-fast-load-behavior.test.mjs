import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "package.json"));
const ts = require("typescript");
const source = readFileSync(path.join(tree, "apps/web/src/components/home/live-home.tsx"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

async function loadFast(value, errorStatus) {
  let run;
  const values = [];
  class SupplyRequestError extends Error { constructor(status) { super("synthetic"); this.status = status; } }
  const mocks = {
    react: { useState: initial => [initial, next => values.push(next)], useEffect() {}, useCallback: fn => (run = fn) },
    "@/components/portal-home": { PortalHome: () => null },
    "@/lib/supply-client": { supplyApi: {
      games: async () => ({ games: [{ id: "synthetic" }] }),
      listingFilters: async () => ({ available: true }),
      publishingOptions: async () => { if (errorStatus) throw new SupplyRequestError(errorStatus); return value; },
    } },
    "@/lib/home-fast-accounts": { collectFastAccounts: async () => ({ accounts: [], historicalAccounts: [], hasMore: false }), HOME_FAST_MAX_PAGES: 3, HOME_FAST_DISPLAY_LIMIT: 4, HOME_FAST_PAGE_LIMIT: 50 },
    "@/lib/listing-filters": { listingQuery: () => ({}) },
    "@/lib/supply-games": { selectDeltaGame: games => games[0] },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), mod, mod.exports);
  mod.exports.LiveHome();
  await run();
  return values.findLast(item => item && typeof item === "object" && "fastEnabled" in item)?.fastEnabled;
}

test("FAST-REPAIR F2 LiveHome turns only explicit booleans into open/closed", async () => {
  assert.equal(await loadFast({ rentalModes: { fast: { enabled: true } } }), true);
  assert.equal(await loadFast({ rentalModes: { fast: { enabled: false } } }), false);
  assert.equal(await loadFast({ pricingSchema: "haff-ratio-v2", rentalModes: {} }), null);
  assert.equal(await loadFast({ rentalModes: { fast: { enabled: "false" } } }), null);
  assert.equal(await loadFast(undefined, 404), null);
  assert.equal(await loadFast(undefined, 500), null);
});
