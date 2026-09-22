import assert from "node:assert/strict";
import test from "node:test";
import { appendUniqueListings } from "../src/lib/listing-feed-utils.ts";

const listing = (id) => ({ id });

test("cursor page append removes existing and same-page duplicate account IDs", () => {
  const result = appendUniqueListings(
    [listing("first"), listing("existing"), listing("existing")],
    [listing("existing"), listing("second"), listing("second"), listing("third")],
  );

  assert.deepEqual(result.map(({ id }) => id), ["first", "existing", "second", "third"]);
});
