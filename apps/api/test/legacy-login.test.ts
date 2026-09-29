import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readPasswordSetupRequired } from "../src/auth/legacy-login";

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

test("a migrated user with a preserved legacy credential but no local password must set one", async () => {
  const fake = db([{ migrated: true, legacyCredential: true }]);
  assert.equal(await readPasswordSetupRequired(fake, "user-1"), true);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.values, ["user-1"]);
});

test("a user without a legacy credential is never told to set a password", async () => {
  assert.equal(await readPasswordSetupRequired(db([{ migrated: true, legacyCredential: false }]), "user-1"), false);
  assert.equal(await readPasswordSetupRequired(db([{ migrated: false, legacyCredential: true }]), "user-1"), false);
  assert.equal(await readPasswordSetupRequired(db([{ migrated: null, legacyCredential: null }]), "user-1"), false);
  assert.equal(await readPasswordSetupRequired(db([]), "user-1"), false);
});
