import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";

test("large resource JSON is bounded to its two management prefixes without raising other API limits", async () => {
  const app = await createApp({ health: { dependencies: { postgres: { check: async () => {}, close: async () => {} }, redis: { check: async () => {}, close: async () => {} } } } });
  try {
    const http = app.getHttpAdapter().getInstance();
    const accepted = (_request: unknown, response: { json: (body: unknown) => void }) => response.json({ accepted: true });
    http.post("/api/bff/admin/content/resources/probe", accepted);
    http.put("/api/v1/admin/content/resources/probe", accepted);
    http.post("/api/not-content", accepted);
    http.post("/api/bff/admin/content/resources-other", accepted);
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    for (const [path, method, bytes, expected] of [
      ["/api/bff/admin/content/resources/probe", "POST", 195000, 200],
      ["/api/v1/admin/content/resources/probe", "PUT", 195000, 200],
      ["/api/bff/admin/content/resources/probe", "POST", 270000, 413],
      ["/api/not-content", "POST", 195000, "rejected"],
      ["/api/bff/admin/content/resources-other", "POST", 195000, "rejected"],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(bytes) }) });
      // Other APIs retain their existing error mapping; they must never reach the success handler above.
      if (expected === "rejected") assert.ok(response.status >= 400, `${method} ${path}`);
      else assert.equal(response.status, expected, `${method} ${path}`);
      await response.arrayBuffer();
    }
  } finally { await app.close(); }
});
