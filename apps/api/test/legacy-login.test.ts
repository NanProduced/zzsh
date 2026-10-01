import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readUserPasswordState } from "../src/auth/legacy-login";

function db(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

test("recognized legacy and modern credentials are set without forcing a replacement", async () => {
  const fake = db([{ modern: false, legacy: true }]);
  assert.equal(await readUserPasswordState(fake, "user-1"), "set");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.values, ["user-1"]);
});

test("absent passwords and unavailable credentials are distinct, and reads fail closed", async () => {
  assert.equal(await readUserPasswordState(db([{ modern: true, legacy: false }]), "user-1"), "set");
  assert.equal(await readUserPasswordState(db([{ modern: false, legacy: false }]), "user-1"), "unavailable");
  assert.equal(await readUserPasswordState(db([]), "user-1"), "not-set");
  await assert.rejects(readUserPasswordState({ query: async () => { throw new Error("read failed"); } }, "user-1"));
});
