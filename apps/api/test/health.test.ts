import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createApp } from "../src/app";
test("HTTP liveness is explicit; business routes do not exist", async () => {
  const app = await createApp();
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const health = await fetch(url + "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "zzsh-api", scope: "liveness" });
    assert.equal((await fetch(url + "/api/orders", { method: "POST" })).status, 404);
    const spec = await (await fetch(url + "/docs-json")).json() as { paths: Record<string, unknown> };
    assert.ok(spec.paths["/api/health"]);
  } finally { await app.close(); }
});
