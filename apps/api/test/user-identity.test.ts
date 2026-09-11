import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createFakeRealNameProvider, FAKE_REAL_NAME_SCENARIOS } from "../src/auth/user-identity";

test("fake real-name provider has deterministic safe outcomes", async () => {
  const input = { userId: "user_fixture", fullName: "Fixture User", documentNumber: "fixture-document" };
  const expected = {
    VERIFIED_ADULT: { status: "VERIFIED", ageStatus: "ADULT" },
    VERIFIED_MINOR: { status: "VERIFIED", ageStatus: "MINOR" },
    REJECTED: { status: "REJECTED", ageStatus: "UNKNOWN" },
    UNKNOWN: { status: "UNKNOWN", ageStatus: "UNKNOWN" },
  } as const;
  for (const scenario of FAKE_REAL_NAME_SCENARIOS) {
    if (scenario === "FAULT") {
      await assert.rejects(() => createFakeRealNameProvider(scenario).verify(input), /fault/);
      continue;
    }
    const first = await createFakeRealNameProvider(scenario).verify(input);
    const second = await createFakeRealNameProvider(scenario).verify(input);
    assert.deepEqual({ status: first.status, ageStatus: first.ageStatus }, expected[scenario]);
    assert.deepEqual(first, second);
    assert.doesNotMatch(first.providerReference ?? "", /fixture-document|Fixture User/);
  }
});
