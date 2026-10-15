// 薄适配映射检查：路径/方法/正文/Idempotency-Key 覆盖默认随机 key；不判定业务成功。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: adminRoot,
  configFile: false,
  plugins: [],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { securityCommands } = await vite.ssrLoadModule("/src/views/security-self/security-commands-api.ts");
after(async () => { await vite.close(); });

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), method: init.method, headers: new Headers(init.headers), body: init.body });
  return new Response(JSON.stringify({ status: "OK" }), { status: 200, headers: { "content-type": "application/json" } });
};

test("five thin functions map path, method, body and command identity exactly", async () => {
  calls.length = 0;
  await securityCommands.changePassword({ commandId: "cmd_test_1", currentPassword: "old-pass", newPassword: "new-pass-1234" });
  await securityCommands.setPin({ commandId: "cmd_test_2", pin: "123456" });
  await securityCommands.changePin({ commandId: "cmd_test_3", currentPin: "123456", newPin: "654321" });
  await securityCommands.generateBackupCodes({ commandId: "cmd_test_4", password: "old-pass" });
  await securityCommands.readOperation({ commandId: "cmd_test_5" });

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["POST", "/api/bff/admin/auth/change-password"],
    ["POST", "/api/bff/admin/security/pin/set"],
    ["POST", "/api/bff/admin/security/pin/change"],
    ["POST", "/api/bff/admin/auth/two-factor/generate-backup-codes"],
    ["POST", "/api/bff/admin/security/operation"],
  ]);
  // 四条命令：commandId 只进 Idempotency-Key，覆盖 adminRequest 的默认随机 key；不混入命令业务正文。
  // operation 是原结果查询：commandId 就是业务参数，键由适配器默认生成即可。
  assert.deepEqual(calls.slice(0, 4).map((call) => call.headers.get("idempotency-key")), ["cmd_test_1", "cmd_test_2", "cmd_test_3", "cmd_test_4"]);
  assert.match(calls[4].headers.get("idempotency-key"), /^idem_[0-9a-f]+$/);
  assert.deepEqual(JSON.parse(calls[0].body), { currentPassword: "old-pass", newPassword: "new-pass-1234", revokeOtherSessions: true });
  assert.deepEqual(JSON.parse(calls[1].body), { pin: "123456" });
  assert.deepEqual(JSON.parse(calls[2].body), { currentPin: "123456", newPin: "654321" });
  assert.deepEqual(JSON.parse(calls[3].body), { password: "old-pass" });
  assert.deepEqual(JSON.parse(calls[4].body), { commandId: "cmd_test_5" });
  for (const call of calls.slice(0, 4)) assert.equal(call.body.includes("cmd_test_"), false, "commandId must not enter the command body");
  assert.equal(calls[0].headers.get("content-type"), "application/json");
});
