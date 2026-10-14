import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const workspace = await read("components/order/order-workspace.tsx");
const list = await read("components/order/order-list.tsx");
const detail = await read("components/order/order-detail.tsx");
const presentation = await read("components/order/order-presentation.tsx");
const client = await read("lib/order-client.ts");
const display = await read("lib/order-display.ts");
const intents = await read("lib/order-intents.ts");
const actions = await read("components/order/order-trade-actions.tsx");
const account = await read("components/supply-workspaces.tsx");

test("the workspace owns identity-scoped list/detail reads and delegates rendering", () => {
  assert.match(workspace, /party: OrderParty/);
  assert.match(workspace, /identityVersion/);
  assert.match(workspace, /listController\.current\?\.abort\(\)/);
  assert.match(workspace, /detailController\.current\?\.abort\(\)/);
  assert.match(workspace, /orderId && !previous/);
  assert.match(workspace, /scrollY/);
  assert.match(workspace, /status === 409/);
  assert.match(workspace, /moreError/);
  assert.match(workspace, /refreshing/);
  assert.match(workspace, /OrderDetail/);
  assert.match(workspace, /OrderListPanel/);
  // Eligibility comes from the server projection, never from a client-side guess in the read layer.
  assert.doesNotMatch(workspace, /paymentOpen|cancelOpen/);
  assert.doesNotMatch(list, /paymentOpen|cancelOpen/);
});

test("the order list states each party's own money basis and never invents it", () => {
  for (const status of ["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"]) {
    assert.match(list, new RegExp(status));
    assert.match(presentation, new RegExp(status));
  }
  assert.match(list, /expiredAwaitingCancel/);
  assert.match(list, /ownerTotal/);
  assert.match(list, /renterName/);
  assert.match(list, /号主报价暂不可用/);
  assert.match(list, /page \? "刷新失败"/);
  assert.match(list, /已加载/);
  assert.match(list, /data-order-id/);
});

test("the detail keeps the existing order-group entry and its data-support trigger", () => {
  assert.match(detail, /zzsh:order-groups/);
  assert.match(detail, /data-support-trigger/);
  assert.match(detail, /orderUrl/);
  assert.match(actions, /结算明细暂时无法读取/);
  assert.match(display, /最终应退/);
  assert.match(display, /本单净入账/);
  assert.match(client, /timeZone: "Asia\/Shanghai"/);
  assert.match(client, /timeZoneName: "longOffset"/);
});

test("trade writes keep the frozen-intent path and the server-reported eligibility", () => {
  // Local payment/settlement writes go through explicit paths with idempotency keys; no client-side persistence.
  assert.match(client, /idempotency-key/);
  assert.match(client, /\/payment-requests/);
  assert.match(client, /settlement-preview/);
  assert.match(client, /openings\/\$\{encodeURIComponent\(openingId\)\}\/confirm/);
  assert.match(client, /confirmationToken/);
  assert.doesNotMatch(client, /sessionStorage|localStorage/);
  // Frozen write intents are user-bound and never reused across identities.
  assert.match(intents, /zzsh\.order-intent\.v1:/);
  assert.match(intents, /parsed\.userId !== userId/);
  assert.match(intents, /loadIntent\(userId, kind, resourceId\)/);
  // Every trade write loads or reuses the frozen intent before sending a new key.
  assert.match(actions, /performGuardedWrite/);
  assert.match(actions, /loadIntent\(userId/);
  assert.match(actions, /orderIntentKey\(\)/);
  assert.doesNotMatch(actions, /localStorage/);
  // paymentOpen/cancelOpen may only widen or narrow the entry inside the guard, never replace it.
  assert.match(actions, /paymentOpen/);
  assert.match(actions, /cancelOpen/);
  assert.match(actions, /performGuardedWrite\(acting, "order\.payment"/);
});

test("account route passes order navigation inputs into the workspace", () => {
  assert.match(account, /OrderWorkspace/);
  assert.match(account, /orderId=\{orderId\}/);
  assert.match(account, /status=\{status\}/);
});
