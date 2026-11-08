import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { nextAdminLogin, nextBossLogin } from "../src/auth/admin-directory";
import { SecurityApiError } from "../src/auth/security-core";

test("the two Boss logins are fixed and inconsistent Boss identities are rejected", () => {
  assert.deepEqual(nextBossLogin([]), { username: "zz00001", displayUsername: "ZZ00001" });
  assert.equal(nextBossLogin(["zz00001"]).username, "zz00002");
  assert.equal(nextBossLogin(["ZZ00002"]).username, "zz00001");
  for (const existing of [["zz00001", "zz00002"], ["zz00005"], [null], ["zz00001", "zz00001"]]) {
    assert.throws(() => nextBossLogin(existing), (error) => error instanceof SecurityApiError && error.status === 409);
  }
});

test("staff allocation skips both Boss numbers and occupied staff numbers", async () => {
  let sequence = 0;
  const checked: string[] = [];
  const client = { async query(sql: string, params?: string[]) {
    if (sql.includes("nextval")) return { rows: [{ value: String(++sequence) }] };
    assert.ok(sql.includes('FROM "zzsh_auth_admin"."user"'));
    checked.push(params![0]!);
    return { rows: params![0] === "zz00003" ? [{}] : [] };
  } } as unknown as PoolClient;
  assert.deepEqual(await nextAdminLogin(client), { username: "zz00004", displayUsername: "ZZ00004" });
  assert.deepEqual(checked, ["zz00003", "zz00004"]);
});
