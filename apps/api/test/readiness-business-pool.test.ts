import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
test("ready fails on the actual exhausted/queued/closed business pool even while independent SELECT1 succeeds", async () => {
  let ended = 0;
  const pool = { totalCount: 10, idleCount: 0, waitingCount: 0, ending: false, ended: false, options: { max: 10 }, end: async () => { ended++; } };
  const dependency = { check: async () => undefined, close: async () => undefined };
  const app = await createApp({ health: { dependencies: { postgres: dependency, redis: dependency } }, database: { pool: pool as unknown as Pool } });
  await app.listen(0, "127.0.0.1");
  try {
    const url = await app.getUrl();
    assert.equal((await fetch(url + "/api/health")).status, 200);
    assert.equal((await fetch(url + "/api/ready")).status, 503);
    pool.idleCount = 1; assert.equal((await fetch(url + "/api/ready")).status, 200);
    pool.waitingCount = 1; assert.equal((await fetch(url + "/api/ready")).status, 503);
    pool.waitingCount = 0; pool.ending = true; assert.equal((await fetch(url + "/api/ready")).status, 503);
    pool.ending = false; pool.ended = true; assert.equal((await fetch(url + "/api/ready")).status, 503);
    pool.ended = false; pool.totalCount = 0; pool.idleCount = 0; assert.equal((await fetch(url + "/api/ready")).status, 200);
  } finally { await app.close(); }
  assert.equal(ended, 1);
});
