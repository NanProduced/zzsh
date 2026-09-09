import { strict as assert } from "node:assert";
import { test } from "node:test";

import { closeResource, finishDatabaseTest } from "./database-test-support";

test("identity failure closes the resource without DROP or CREATE", async () => {
  const events: string[] = [];
  let authorized = true;
  try {
    events.push("IDENTITY");
    throw new Error("wrong database identity");
  } catch {
    authorized = false;
  }
  await closeResource(
    authorized,
    { release: (destroy) => events.push(destroy ? "release:destroy" : "release") },
    async () => {
      events.push("DROP/CREATE");
    },
  );
  assert.deepEqual(events, ["IDENTITY", "release:destroy"]);
});

test("cleanup failure still closes both pools and preserves the primary error", async () => {
  const events: string[] = [];
  const primaryError = new Error("primary failure");
  await assert.rejects(
    () =>
      finishDatabaseTest(
        primaryError,
        async () => {
          events.push("reset");
          throw new Error("reset cleanup failure");
        },
        async () => {
          events.push("test:end");
        },
        async () => {
          events.push("admin:end");
        },
      ),
    (error: unknown) => error === primaryError,
  );
  assert.deepEqual(events, ["reset", "test:end", "admin:end"]);
});
