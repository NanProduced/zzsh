import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readResponse, waitFor } from "./smoke.mjs";

test("consumed response survives another service's readiness delay; incomplete body stays bounded", { timeout: 6000 }, async () => {
  const started = performance.now();
  const server = createServer((request, response) => {
    if (request.url === "/hanging-body") { response.writeHead(200); response.write("partial"); return; }
    if (request.url === "/slow" && performance.now() - started < 1250) { response.writeHead(503); response.end("starting"); return; }
    response.end(request.url === "/fast" ? "complete-fast" : "complete-slow");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let fastFinished;
    const [fast, slow] = await Promise.all([
      waitFor({ exitCode: null }, base + "/fast", "fast").then(value => { fastFinished = performance.now(); return value; }),
      waitFor({ exitCode: null }, base + "/slow", "slow"),
    ]);
    assert.ok(performance.now() - fastFinished > 1000, "the other service finishes after the first request's deadline");
    assert.equal(fast.body, "complete-fast"); assert.equal(slow.body, "complete-slow");
    await assert.rejects(readResponse(base + "/hanging-body", "body-read"), error => error.message.includes("body-read " + base + "/hanging-body") && /TimeoutError|AbortError/.test(error.message));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
