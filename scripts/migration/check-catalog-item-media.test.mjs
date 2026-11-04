import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { checkCatalogItemMedia, inspectItemImage } from "./check-catalog-item-media.mjs";

const manifest = JSON.parse(readFileSync(new URL("./catalog-item-media-manifest.json", import.meta.url), "utf8"));

test("existing Web artwork verifies and matches the publishing form's eight mappings", async () => {
  const result = await checkCatalogItemMedia(manifest);
  assert.equal(result.items.length, 8);
  const form = readFileSync(new URL("../../apps/web/src/components/supply/publish-form.tsx", import.meta.url), "utf8");
  for (const item of result.items) {
    assert.ok(form.includes(`${item.code}: "/${item.file.replace("apps/web/public/", "")}"`), item.code);
    assert.match(item.publicDerivative.sha256, /^[0-9a-f]{64}$/);
    assert.equal(item.publicDerivative.mime, item.mime);
  }
});

test("a bound public media ID takes precedence over the local artwork", () => {
  const require = createRequire(import.meta.url), React = require("react"), ts = require("typescript");
  const file = fileURLToPath(new URL("../../apps/web/src/components/supply/catalog-item-art.tsx", import.meta.url));
  const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(fileURLToPath(new URL("../../", import.meta.url)));
  mod._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  const render = mediaId => require("react-dom/server").renderToStaticMarkup(React.createElement(mod.exports.CatalogItemArt, { mediaId }, React.createElement("img", { src: "/fallback.png", alt: "" })));
  assert.match(render(null), /\/fallback\.png/);
  const bound = render("asset_catalog");
  assert.match(bound, /\/api\/supply\/media\/asset_catalog\/content/);
  assert.doesNotMatch(bound, /\/fallback\.png/);
});

test("wrong source, unit and duplicate identity fail closed", async () => {
  const badHash = structuredClone(manifest); badHash.items[0].sha256 = "0".repeat(64);
  await assert.rejects(checkCatalogItemMedia(badHash), /SOURCE_BYTES_MISMATCH/);
  const badUnit = structuredClone(manifest); badUnit.items[0].unit = "PIECE";
  await assert.rejects(checkCatalogItemMedia(badUnit), /ITEM_INVALID/);
  const duplicate = structuredClone(manifest); duplicate.items[1] = { ...duplicate.items[0] };
  await assert.rejects(checkCatalogItemMedia(duplicate), /ITEM_INVALID/);
});

test("a correctly hashed synthetic solid red image is rejected", async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#c4363a" } }).png().toBuffer();
  const item = { code: "probe", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, mime: "image/png", width: 64, height: 64 };
  await assert.rejects(inspectItemImage(bytes, item), /UNIFORM_OR_EMPTY_IMAGE/);
});
