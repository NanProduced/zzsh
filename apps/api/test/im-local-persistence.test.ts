import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { InMemoryMessageTransport } from "./im-local-fixtures";

test("local review messages survive a transport restart without changing team history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zzsh-im-local-"));
  const persistPath = join(directory, "messages.json");
  try {
    const first = new InMemoryMessageTransport(() => 1_700_000_000_000, { persistPath });
    await first.sendText({ conversationId: "viewer|2|900001", senderAccountId: "viewer", receiverAccountId: "900001", text: "第一句", messageClientId: "client-1" });

    const restarted = new InMemoryMessageTransport(() => 1_700_000_001_000, { persistPath });
    const history = await restarted.history({ conversationId: "viewer|2|900001", viewerAccountId: "viewer", limit: 50 });
    assert.deepEqual(history.map((message) => message.text), ["第一句"], "history is read after restart");
    assert.equal(history[0]!.conversationId, "viewer|2|900001", "the viewer-specific conversation id is restored at read time");

    const next = await restarted.sendText({ conversationId: "viewer|2|900001", senderAccountId: "viewer", receiverAccountId: "900001", text: "第二句", messageClientId: "client-2" });
    assert.equal(next.messageServerId, "fixture-server-000002", "the id sequence continues instead of colliding");
    const third = new InMemoryMessageTransport(() => 1_700_000_002_000, { persistPath });
    assert.deepEqual((await third.history({ conversationId: "viewer|2|900001", viewerAccountId: "viewer", limit: 50 })).map((message) => message.text), ["第一句", "第二句"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
