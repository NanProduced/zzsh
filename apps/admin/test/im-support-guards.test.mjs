import assert from "node:assert/strict";
import { test } from "node:test";

const { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, shouldBlockCurrentForbidden } = await import("../src/views/im-support-guards.ts");

const request = { generation: 4, operator: "admin:session", consultationId: "consultation-a", conversationId: "account-a|2|team-a" };

test("a forbidden response blocks only the current consultation after permission recheck", () => {
  assert.equal(shouldBlockCurrentForbidden({
    status: 403,
    expected: request,
    current: request,
    permissionConfirmedAbsent: true,
  }), true);
  assert.equal(shouldBlockCurrentForbidden({
    status: 403,
    expected: request,
    current: { ...request, consultationId: "consultation-b" },
    permissionConfirmedAbsent: true,
  }), false);
  assert.equal(shouldBlockCurrentForbidden({
    status: 403,
    expected: request,
    current: request,
    permissionConfirmedAbsent: false,
  }), false);
  assert.equal(isCurrentImRequest(request, { ...request, generation: 5 }), false);
  assert.equal(isCurrentImRequest({ ...request, sendCapability: "blocked" }, { ...request, sendCapability: "allowed" }), false);
  assert.equal(isCurrentImRequest({ ...request, sendCapability: "allowed" }, { ...request, sendCapability: "allowed" }), true);
});

test("forbidden recheck calls the BFF with the current NIM conversation id", async () => {
  const paths = [];
  const blocked = await confirmCurrentForbidden({
    originalStatus: 403,
    expected: request,
    current: request,
    getCurrent: () => request,
    recheck: async (path) => { paths.push(path); throw Object.assign(new Error("forbidden"), { status: 403 }); },
  });
  assert.equal(blocked, true);
  assert.deepEqual(paths, [messageAccessPath(request.conversationId, "send")]);
  assert.deepEqual(paths, ["/im/message-access?conversationId=account-a%7C2%7Cteam-a&operation=send"]);
});

test("stale consultation/operator, recovered permission, and non-permission errors do not block", async () => {
  const paths = [];
  assert.equal(await confirmCurrentForbidden({
    originalStatus: 403,
    expected: request,
    current: { ...request, consultationId: "consultation-b", conversationId: "account-b|2|team-b" },
    getCurrent: () => request,
    recheck: async (path) => { paths.push(path); throw Object.assign(new Error("forbidden"), { status: 403 }); },
  }), false);
  assert.equal(await confirmCurrentForbidden({
    originalStatus: 403,
    expected: request,
    current: { ...request, operator: "other:session" },
    getCurrent: () => request,
    recheck: async (path) => { paths.push(path); throw Object.assign(new Error("forbidden"), { status: 403 }); },
  }), false);
  assert.equal(await confirmCurrentForbidden({
    originalStatus: 403,
    expected: request,
    current: request,
    getCurrent: () => request,
    recheck: async (path) => { paths.push(path); },
  }), false);
  assert.equal(await confirmCurrentForbidden({
    originalStatus: 500,
    expected: request,
    current: request,
    getCurrent: () => request,
    recheck: async (path) => { paths.push(path); throw Object.assign(new Error("forbidden"), { status: 403 }); },
  }), false);
  assert.deepEqual(paths, [messageAccessPath(request.conversationId, "send")]);
});
