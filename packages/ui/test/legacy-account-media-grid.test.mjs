import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({ root: resolve(root, "apps/admin"), configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const file = resolve(root, "packages/ui/src/legacy-account-media-grid.tsx").replaceAll("\\", "/");
const { LegacyAccountMediaGrid } = await server.ssrLoadModule(`/@fs/${file}`);

test("admin grid uses account slots for display and private evidence without source paths", async () => {
  try {
    const html = renderToStaticMarkup(React.createElement(LegacyAccountMediaGrid, { accountId: "account_1", displayCount: 2, penaltyCount: 1 }));
    assert.match(html, /\/api\/bff\/admin\/supply\/accounts\/account_1\/legacy-images\/display\/0/);
    assert.match(html, /\/api\/bff\/admin\/supply\/accounts\/account_1\/legacy-images\/penalty\/0/);
    assert.doesNotMatch(html, /accountsImage|https?:\/\//);
    assert.match(renderToStaticMarkup(React.createElement(LegacyAccountMediaGrid, { accountId: "account_1", displayCount: 0, penaltyCount: 0 })), /account-media-unavailable/);
  } finally { await server.close(); }
});
