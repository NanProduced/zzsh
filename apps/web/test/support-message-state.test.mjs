import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeImMessages } from "../src/lib/nim-web-client.ts";

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
