import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workspace = await readFile(new URL("../src/components/order/order-workspace.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/lib/order-client.ts", import.meta.url), "utf8");
const account = await readFile(new URL("../src/components/supply-workspaces.tsx", import.meta.url), "utf8");

test("order workspace covers read-only projection, four states, and existing group entry", () => {
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
  assert.doesNotMatch(workspace, /orderApi\.create|orderApi\.cancel|paymentOpen|cancelOpen/);
  assert.doesNotMatch(client, /POST|orderApi\.create|orderApi\.cancel|sessionStorage|localStorage/);
});

test("account route passes order navigation inputs into the workspace", () => {
  assert.match(account, /OrderWorkspace/);
  assert.match(account, /orderId=\{orderId\}/);
  assert.match(account, /status=\{status\}/);
});
