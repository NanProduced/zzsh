import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createServer({ root: resolve(root, "apps/admin"), configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const file = resolve(root, "packages/ui/src/account-media-placeholder.tsx").replaceAll("\\", "/");
const { AccountMediaPlaceholder } = await source.ssrLoadModule(`/@fs/${file}`);

test("the two explicit states render the original supplied image and accessible message", async () => {
  try {
    for (const [state, filename, alt, sha] of [
      ["PENDING_IMPORT", "account-media-migrating.png", "图片正在迁移中", "00faec351f7a63fd2a2fea4008404943578013cd1378d7c63cdb14859f96d8d4"],
      ["UNAVAILABLE", "account-media-unavailable.png", "暂无可展示的图片", "c8017f0af7760e2da91d8fbe22f42a661a6d78e3432e2dfd871a745c772cd90d"],
    ]) {
      const markup = renderToStaticMarkup(React.createElement(AccountMediaPlaceholder, { state }));
      assert.ok(markup.includes(filename)); assert.ok(markup.includes(alt)); assert.match(markup, /object-fit:contain/);
      const bytes = readFileSync(resolve(root, "packages/ui/assets", filename));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
    }
  } finally { await source.close(); }
});
