import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collapseImSystemNotices, decodeImSystemNotice, mergeImMessages } from "../src/lib/nim-web-client.ts";

test("merges history with live messages by stable id and keeps newer delivery", () => {
  const result = mergeImMessages(
    [{ id: "history", createTime: 10, text: "历史" }, { id: "live", createTime: 30, text: "实时" }],
    [{ id: "during-history", createTime: 20, text: "历史读取期间到达" }, { id: "live", createTime: 30, text: "实时补全" }],
  );
  assert.deepEqual(result, [
    { id: "history", createTime: 10, text: "历史" },
    { id: "during-history", createTime: 20, text: "历史读取期间到达" },
    { id: "live", createTime: 30, text: "实时补全" },
  ]);
});

test("keeps the uploaded image URL when a sender echo without it arrives later", () => {
  const result = mergeImMessages(
    [{ id: "image-1", createTime: 10, messageType: 1, attachment: { imageId: "", url: "https://nim-nosdn.example/image", name: "a.png" } }],
    [{ id: "image-1", createTime: 10, messageType: 1, attachment: { name: "a.png", size: 70 } }],
  );
  assert.deepEqual(result, [{
    id: "image-1",
    createTime: 10,
    messageType: 1,
    attachment: { imageId: "", url: "https://nim-nosdn.example/image", name: "a.png", size: 70 },
  }]);
});

test("decodes NIM notification type before using the legacy ope hint", () => {
  const invite = decodeImSystemNotice({ messageType: 5, attachment: { type: 0 } });
  assert.deepEqual(invite, { kind: "MEMBER_JOINED", text: "成员已加入会话" });
  // ope:0 alone is the legacy server-created group notice.
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { ope: 0, tname: "订单群", accids: ["u-1"] } }), { kind: "TEAM_CREATED", text: "群聊已创建" });
  // A typed member/group change must never be overridden by ope:0.
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { ope: 0, type: 0 } }), { kind: "MEMBER_JOINED", text: "成员已加入会话" });
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { type: 1 } }), { kind: "MEMBER_LEFT", text: "成员已离开会话" });
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { type: 3 } }), { kind: "TEAM_UPDATED", text: "会话信息已更新" });
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { type: 4 } }), { kind: "TEAM_DISMISSED", text: "会话已解散" });
  // Super-team mirrors use the same notification type with a 4xx offset.
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { type: 405 } }), { kind: "TEAM_DISMISSED", text: "会话已解散" });
  assert.deepEqual(decodeImSystemNotice({ messageType: 5, attachment: { type: 99 } }), { kind: "UNKNOWN", text: "会话信息有变化" });
  assert.equal(decodeImSystemNotice({ messageType: 0, attachment: { type: 0 } }), null);
});

test("collapses Bot-covered and repeated system notices without inventing business facts", () => {
  const system = (id, createTime, kind, text) => ({ id, createTime, notice: { kind, text } });
  const regular = (id, createTime) => ({ id, createTime, notice: null });
  const options = { noticeOf: (message) => message.notice };
  const messages = [
    system("created", 0, "TEAM_CREATED", "群聊已创建"),
    system("joined-1", 1_000, "MEMBER_JOINED", "成员已加入会话"),
    system("joined-2", 2_000, "MEMBER_JOINED", "成员已加入会话"),
    regular("hello", 3_000),
    system("updated-1", 4_000, "TEAM_UPDATED", "会话信息已更新"),
    system("updated-2", 5_000, "TEAM_UPDATED", "会话信息已更新"),
    system("updated-3", 6 * 60_000, "TEAM_UPDATED", "会话信息已更新"),
  ];

  assert.deepEqual(
    collapseImSystemNotices(messages, { ...options, hasBotMessage: false }).map((message) => message.id),
    ["created", "hello", "updated-1", "updated-3"],
    "one fallback for team creation/member join, and same-kind bursts merge",
  );
  assert.deepEqual(
    collapseImSystemNotices(messages, { ...options, hasBotMessage: true }).map((message) => message.id),
    ["hello", "updated-1", "updated-3"],
    "Bot welcome/stage cards hide team-created and member-joined notices only",
  );
});
