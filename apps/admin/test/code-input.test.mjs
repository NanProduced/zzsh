import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeCodePaste } from "../src/components/smoothui/code-input.ts";

test("TOTP paste preserves leading zeroes and removes copied separators", () => {
  assert.equal(normalizeCodePaste(" 012 345\n"), "012345");
  assert.equal(normalizeCodePaste("012-345"), "012345");
});

test("backup paste preserves exact case and all ten characters", () => {
  assert.equal(normalizeCodePaste(" AWtNQ-x8Fl8\r\n"), "AWtNQx8Fl8");
  assert.equal(normalizeCodePaste("aBcDExYz09"), "aBcDExYz09");
  assert.notEqual(normalizeCodePaste("aBcDE-xYz09"), "ABCDEXYZ09");
});
