import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { SecurityApiError } from "../src/auth/security-core";

function actualUserOrderRead(row: Record<string, unknown> | null) {
  const file = readFileSync(resolve(__dirname, "../../src/order/order.ts"), "utf8");
  const source = ts.createSourceFile("order.ts", file, ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getMyOrder");
  assert.ok(fn, "test the actual authenticated read function, not a duplicate implementation");
  const exports: { getMyOrder?: (client: unknown, userId: string, orderId: string) => Promise<any> } = {};
  let projections = 0;
  runInNewContext(ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, ORDER_FIELDS: "fixture fields", ORDER_FROM: "fixture relation",
    notFound: () => new SecurityApiError(404, "NOT_FOUND", "Order not found"),
    projectOrder: () => { projections++; return { id: "order_1" }; },
    attachLineNames: async () => {}, readOrderUserFacts: async () => new Map(), applyOrderUserFacts: () => {},
    readSettlementStages: async () => new Map(),
  });
  const client = { query: async () => ({ rows: row ? [row] : [] }) };
  return { read: (userId: string) => exports.getMyOrder!(client, userId, "order_1"), projections: () => projections };
}

for (const [subject, party] of [["user_renter", "renter"], ["user_owner", "owner"]] as const) {
  test(`order detail navigation derives ${party} from authenticated membership`, async () => {
    const f = actualUserOrderRead({ id: "order_1", renterUserId: "user_renter", ownerUserId: "user_owner", accountId: "account_1", versionId: "version_1", contentHash: "a".repeat(64), viewerParty: "forged" });
    assert.equal((await f.read(subject)).order.viewerParty, party);
    assert.equal(f.projections(), 1);
  });
}

test("navigation identity never grants an unrelated viewer order access", async () => {
  const f = actualUserOrderRead({ id: "order_1", renterUserId: "user_renter", ownerUserId: "user_owner" });
  await assert.rejects(f.read("outsider"), (error: unknown) => (error as SecurityApiError).status === 404);
  assert.equal(f.projections(), 0);
});
