import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReturnTo } from "../src/lib/safe-return.ts";

test("only same-site absolute paths survive as post-login return targets", () => {
  for (const value of [
    "https://evil.invalid/account",
    "http://evil.invalid",
    "//evil.invalid/account",
    "/\\evil.invalid",
    "javascript:alert(1)",
    "/account\u0000",
    "/account\nx",
    `/${"a".repeat(600)}`,
    "account",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeReturnTo(value), undefined, `must reject ${JSON.stringify(value)}`);
  }
  for (const value of ["/", "/accounts/42", "/publish?mode=fast", "/account?view=favorites#list"]) {
    assert.equal(safeReturnTo(value), value);
  }
  assert.equal(safeReturnTo("  /accounts/42  "), "/accounts/42");
});
