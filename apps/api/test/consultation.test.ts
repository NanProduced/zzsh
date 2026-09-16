import assert from "node:assert/strict";
import { test } from "node:test";

import { MessageScopeRecoveryLifecycle, parseConsultationBody, parseLimit, parsePresenceBody, parseSupportType, startMessageScopeRecovery, toView } from "../src/im/consultation";

test("consultation input accepts only the supported type and safe subject reference", () => {
  assert.deepEqual(parseConsultationBody({ type: "SERVICE", subjectRef: "listing_01" }), { type: "SERVICE", subjectRef: "listing_01" });
  assert.deepEqual(parseConsultationBody({ type: "COMPLAINT" }), { type: "COMPLAINT", subjectRef: null });
  assert.throws(() => parseConsultationBody({ type: "SERVICE", subjectRef: "../private" }), /Subject reference is invalid/);
  assert.throws(() => parseConsultationBody({ type: "SERVICE", extra: true }), /unknown field/);
  assert.throws(() => parseSupportType("CHAT"), /Support type is invalid/);
});

test("presence and queue limits reject values outside the server contract", () => {
  assert.deepEqual(parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED" }), { availability: "AVAILABLE", connectionState: "CONNECTED" });
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit("100"), 100);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED", adminUserId: "other" }), /unknown field/);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "ONLINE" }), /Connection state is invalid/);
  assert.throws(() => parseLimit("101"), /Limit is invalid/);
});

test("consultation views project the authorized team from each account and never self-address", () => {
  const row = {
    id: "consult-1",
    userId: "user-1",
    kind: "SERVICE" as const,
    state: "ACTIVE" as const,
    userAccountId: "user_im_1",
    peerAccountId: "staff_im_1",
    assignedAdminId: "admin-1",
    subjectRef: "listing-1",
    version: 2,
    lastMessageAt: null,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    updatedAt: new Date("2026-09-16T00:00:00.000Z"),
    userName: "用户一",
    userUsername: "user-1",
    adminName: "客服一",
    appId: "provider-test",
    messageScopeType: "TEAM" as const,
    messageScopeId: "900001",
    messageScopeState: "READY" as const,
    messageScopeVersion: 1,
  };

  const userView = toView(row, "user_im_1");
  assert.equal(userView.peerAccountId, "staff_im_1");
  assert.equal(userView.conversationId, "user_im_1|2|900001");

  const adminView = toView(row, "staff_im_1", true, "admin-1");
  assert.equal(adminView.peerAccountId, "user_im_1");
  assert.equal(adminView.conversationId, "staff_im_1|2|900001");
  assert.notEqual(adminView.peerAccountId, "staff_im_1");

  const oldAdminView = toView(row, "old_staff_im", true, "admin-2");
  assert.equal(oldAdminView.peerAccountId, "user_im_1");
  assert.equal(oldAdminView.conversationId, null);

  assert.equal(toView({ ...row, state: "CLOSED" }, "user_im_1").conversationId, null);
});

test("scope recovery shutdown waits for the in-flight batch and prevents later ticks", async () => {
  let queryCount = 0;
  let releaseQuery!: () => void;
  let queryStarted!: () => void;
  const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
  const startedGate = new Promise<void>((resolve) => { queryStarted = resolve; });
  const client = {
    query: async () => { queryCount += 1; queryStarted(); await queryGate; return { rows: [] }; },
    release: () => undefined,
  };
  const options = {
    pool: { query: client.query, connect: async () => client },
    appId: "provider-test",
    provider: {} as never,
    supportManager: {} as never,
  } as never;
  const lifecycle = new MessageScopeRecoveryLifecycle();
  lifecycle.start(options, 1);
  await startedGate;
  let stopped = false;
  const shutdown = lifecycle.beforeApplicationShutdown().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  releaseQuery();
  await shutdown;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, true);
  assert.ok(queryCount >= 1);
});

test("scope recovery reports a safe failure class when the batch query fails", async () => {
  let failureClass: string | undefined;
  const options = {
    pool: { query: async () => { throw new Error("private database failure"); } },
    appId: "provider-test",
    provider: {} as never,
    supportManager: {} as never,
  } as never;
  const stop = startMessageScopeRecovery(options, 1, (value) => { failureClass = value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stop();
  assert.equal(failureClass, "RECOVERY_UNEXPECTED");
});
