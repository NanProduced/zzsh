import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspace = await readFile(new URL("../src/components/order/order-workspace.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/lib/order-client.ts", import.meta.url), "utf8");
const intents = await readFile(new URL("../src/lib/order-intents.ts", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/components/order/order-trade-actions.tsx", import.meta.url), "utf8");
const account = await readFile(new URL("../src/components/supply-workspaces.tsx", import.meta.url), "utf8");

test("order workspace covers projection, four states, trade actions and existing group entry", () => {
  assert.match(workspace, /party: OrderParty/);
  assert.match(workspace, /identityVersion/);
  assert.match(workspace, /listController\.current\?\.abort\(\)/);
  assert.match(workspace, /detailController\.current\?\.abort\(\)/);
  assert.match(workspace, /orderId && !previous/);
  for (const status of ["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"]) assert.match(workspace, new RegExp(status));
  assert.match(workspace, /expiredAwaitingCancel/);
  assert.match(workspace, /ownerTotal/);
  assert.match(workspace, /renterName/);
  assert.match(workspace, /zzsh:order-groups/);
  assert.match(workspace, /scrollY/);
  assert.match(workspace, /status === 409/);
  assert.match(workspace, /first \? "订单列表暂时没有读取成功"/);
  assert.match(workspace, /page \? "刷新失败"/);
  assert.match(workspace, /moreError/);
  assert.match(workspace, /refreshing/);
  assert.match(client, /timeZone: "Asia\/Shanghai"/);
  assert.match(client, /timeZoneName: "longOffset"/);
  assert.match(workspace, /OrderTradeActions/);
  assert.doesNotMatch(workspace, /paymentOpen|cancelOpen/);
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
});

test("account route passes order navigation inputs into the workspace", () => {
  assert.match(account, /OrderWorkspace/);
  assert.match(account, /orderId=\{orderId\}/);
  assert.match(account, /status=\{status\}/);
});
