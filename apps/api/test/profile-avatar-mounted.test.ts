import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { ExpressAdapter } from "@nestjs/platform-express";
import { mountProfileAvatarHandlers } from "../src/profile/profile-avatar-routes";
import { loadPresetBytes, PROFILE_AVATAR_PRESETS } from "../src/profile/profile-avatar-presets";

test("mounted Express avatar routes preserve original URL instead of slicing the stripped URL twice", async (t) => {
  const preset = PROFILE_AVATAR_PRESETS[0]!;
  const bytes = await loadPresetBytes(preset);
  const adapter = new ExpressAdapter();
  const fakePool = { connect: async () => { throw new Error("public presets must not borrow a database connection"); } };
  mountProfileAvatarHandlers({ getHttpAdapter: () => adapter } as never, {
    pool: fakePool, userOrigin: "http://127.0.0.1:4220", adminOrigin: "http://127.0.0.1:4221", apiOrigin: "http://127.0.0.1:4222",
    mediaStorage: { available: true, kind: "local", write: async () => { throw new Error("read only"); }, read: async (key: string) => { assert.equal(key, preset.contentHash); return bytes; } },
  } as never);
  const server = createServer(adapter.getInstance());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const valid = await fetch(`${base}/api/v1/profile/avatars/presets/${preset.presetId}/1/content`);
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get("content-type") ?? "", /image\/webp/);
  assert.deepEqual(Buffer.from(await valid.arrayBuffer()), bytes);
  const stale = await fetch(`${base}/api/v1/profile/avatars/presets/${preset.presetId}/2/content`);
  assert.equal(stale.status, 404);
});
