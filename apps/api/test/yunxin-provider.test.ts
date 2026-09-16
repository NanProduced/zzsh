import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createYunxinDynamicToken,
  YunxinApiError,
  YunxinServerApiClient,
  YunxinTransportError,
} from "../src/im/yunxin-provider";

const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";

test("creates the short-lived dynamic token payload required by Web login", () => {
  const issuedAt = 1_700_000_000_000;
  const token = createYunxinDynamicToken({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    accountId: "staff-1",
    now: () => issuedAt,
  });
  const payload = JSON.parse(Buffer.from(token.token, "base64").toString("utf8")) as Record<string, unknown>;

  assert.deepEqual(payload, {
    signature: createHash("sha1")
      .update(`${APP_KEY}staff-1${issuedAt}600${APP_SECRET}`)
      .digest("hex"),
    curTime: issuedAt,
    ttl: 600,
  });
  assert.equal(token.issuedAt, issuedAt);
  assert.equal(token.expiresAt, issuedAt + 600_000);
  assert.equal(token.ttlSeconds, 600);
  assert.doesNotMatch(token.token, new RegExp(APP_SECRET));
});

test("rejects unsafe dynamic token credentials, account IDs, clocks and TTLs", () => {
  assert.throws(() => createYunxinDynamicToken({ appKey: "", appSecret: APP_SECRET, accountId: "staff-1" }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: "secret\n", accountId: "staff-1" }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: APP_SECRET, accountId: "bad id" }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: APP_SECRET, accountId: "staff-1", ttlSeconds: 59 }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: APP_SECRET, accountId: "staff-1", ttlSeconds: 901 }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: APP_SECRET, accountId: "staff-1", now: () => Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => createYunxinDynamicToken({ appKey: APP_KEY, appSecret: APP_SECRET, accountId: "staff-1", now: () => Number.MAX_SAFE_INTEGER }));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("signs Server API requests without putting AppSecret in the request", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    now: () => 1_700_000_000_000,
    nonce: () => "nonce-1",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse({ code: 200, info: { accid: "staff-1", token: "provider-token" } });
    },
  });

  const created = await api.createAccount({ accountId: "staff-1", name: "客服一号" });
  const headers = new Headers(requestInit?.headers);
  const body = new URLSearchParams(String(requestInit?.body));
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(requestUrl, "https://api.yunxinapi.com/nimserver/user/create.action");
  assert.equal(body.get("accid"), "staff-1");
  assert.equal(body.get("name"), "客服一号");
  assert.equal(headers.get("AppKey"), APP_KEY);
  assert.equal(headers.get("Nonce"), "nonce-1");
  assert.equal(headers.get("CurTime"), "1700000000");
  assert.equal(
    headers.get("CheckSum"),
    createHash("sha1").update(`${APP_SECRET}nonce-11700000000`).digest("hex"),
  );
  assert.doesNotMatch(JSON.stringify({ requestUrl, requestInit }), new RegExp(APP_SECRET));
  assert.deepEqual(created, {
    accountId: "staff-1",
    token: "provider-token",
    profile: { accountId: "staff-1" },
  });
});

test("normalizes profiles, account state, online status and the sensitive token operation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    nonce: () => "nonce-2",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/im/v2/users?")) {
        return jsonResponse({
          code: 200,
          data: {
            success_list: [{ account_id: "staff-1", name: "客服一号", avatar: "avatar-id", gender: 1 }],
            failed_list: [{ account_id: "missing-1", code: 102404 }],
          },
        });
      }
      if (url.endsWith("/im/v2/users/staff-1")) {
        return jsonResponse({ code: 200, data: { account_id: "staff-1", name: "客服一号", extension: "{\"team\":\"support\"}" } });
      }
      if (url.endsWith("/im/v2/accounts/staff-1")) {
        return jsonResponse({
          code: 200,
          data: {
            account_id: "staff-1",
            configuration: { enabled: false, p2p_chat_banned: true },
          },
        });
      }
      if (url.endsWith("/actions/refresh_token")) return jsonResponse({ code: 200, data: { token: "new-token" } });
      if (url.endsWith("/online_status")) {
        return jsonResponse({
          code: 200,
          data: {
            success_list: [{ account_id: "staff-1", online_status: [{ client_type: 4, login_time: 1700000000 }] }],
            failed_list: [],
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.getProfile("staff-1"), {
    accountId: "staff-1",
    name: "客服一号",
    extension: "{\"team\":\"support\"}",
  });
  assert.deepEqual(await api.getProfiles(["staff-1", "missing-1"]), {
    profiles: [{ accountId: "staff-1", name: "客服一号", avatar: "avatar-id", gender: 1 }],
    failed: [{ accountId: "missing-1", providerCode: 102404 }],
  });
  assert.deepEqual(await api.getAccount("staff-1"), {
    accountId: "staff-1",
    enabled: false,
    p2pChatBanned: true,
    teamChatBanned: null,
    chatroomChatBanned: null,
    qchatChatBanned: null,
  });
  assert.deepEqual(await api.refreshAccountToken("staff-1"), { accountId: "staff-1", token: "new-token" });
  assert.deepEqual(await api.getOnlineStatuses(["staff-1"]), {
    statuses: [{
      accountId: "staff-1",
      online: true,
      sessions: [{ clientType: 4, loginTime: 1700000000 }],
    }],
    failed: [],
  });
  assert.equal(calls.length, 5);
});

test("updates account enablement with an explicit kick option", async () => {
  let requestInit: RequestInit | undefined;
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (_input, init) => {
      requestInit = init;
      return jsonResponse({ code: 200, data: { account_id: "staff-1", configuration: { enabled: true } } });
    },
  });

  assert.deepEqual(await api.setAccountEnabled("staff-1", true, true), {
    accountId: "staff-1",
    enabled: true,
    p2pChatBanned: null,
    teamChatBanned: null,
    chatroomChatBanned: null,
    qchatChatBanned: null,
  });
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    configuration: { enabled: true },
    need_kick: true,
  });
});

test("fails closed for invalid endpoints, batches and provider failures", async () => {
  for (const endpoint of [
    "https://evil.example",
    "https://api.yunxinapi.com:8443",
    "https://user:pass@api.yunxinapi.com",
  ]) {
    assert.throws(
      () => new YunxinServerApiClient({ appKey: APP_KEY, appSecret: APP_SECRET, endpoint }),
      /not allowlisted/,
    );
  }
  const api = new YunxinServerApiClient({ appKey: APP_KEY, appSecret: APP_SECRET, fetch: async () => jsonResponse({ code: 102449 }, 200) });
  await assert.rejects(api.getProfiles([]), /batch size/);
  await assert.rejects(
    api.getProfile("staff-1"),
    (error: unknown) => error instanceof YunxinApiError && error.providerCode === 102449 && error.retryable && !error.message.includes(APP_SECRET),
  );
});

test("rejects missing business codes, incomplete batches and mismatched account IDs", async () => {
  const missingCode = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ data: {} }),
  });
  await assert.rejects(
    missingCode.updateProfile("staff-1", { name: "客服一号" }),
    (error: unknown) => error instanceof YunxinApiError && error.providerCode === null,
  );

  const incompleteBatch = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { success_list: [] } }),
  });
  await assert.rejects(incompleteBatch.getProfiles(["staff-1"]), YunxinApiError);

  const mismatched = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { account_id: "other-user" } }),
  });
  await assert.rejects(mismatched.getProfile("staff-1"), YunxinApiError);

  const extraBatchAccount = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({
      code: 200,
      data: {
        success_list: [{ account_id: "other-user" }],
        failed_list: [],
      },
    }),
  });
  await assert.rejects(extraBatchAccount.getProfiles(["staff-1"]), YunxinApiError);
});

test("keeps malformed JSON, HTTP failures, transport failures and timeouts generic", async () => {
  const malformed = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => new Response("{", { status: 200 }),
  });
  await assert.rejects(
    malformed.getProfile("staff-1"),
    (error: unknown) => error instanceof YunxinApiError && !error.message.includes(APP_SECRET),
  );

  const httpFailure = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 500, msg: APP_SECRET }, 503),
  });
  await assert.rejects(
    httpFailure.getProfile("staff-1"),
    (error: unknown) => error instanceof YunxinApiError && error.retryable && !error.message.includes(APP_SECRET),
  );

  const transportFailure = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => { throw new Error(APP_SECRET); },
  });
  await assert.rejects(
    transportFailure.getProfile("staff-1"),
    (error: unknown) => error instanceof YunxinTransportError && !error.message.includes(APP_SECRET),
  );

  const timeout = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    timeoutMs: 100,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing timeout signal"));
      if (signal.aborted) return reject(new Error(APP_SECRET));
      signal.addEventListener("abort", () => reject(new Error(APP_SECRET)), { once: true });
    }),
  });
  await assert.rejects(
    timeout.getProfile("staff-1"),
    (error: unknown) => error instanceof YunxinTransportError && !error.message.includes(APP_SECRET),
  );
});

test("uses the advanced-team server API for one consultation scope", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const serverExtension = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method), body: init?.body });
      if (url.endsWith("/im/v2.1/teams")) {
        return jsonResponse({ code: 200, data: { failed_list: [], team_info: { team_id: 2366886326, owner_account_id: "system-1" } } });
      }
      if (url.endsWith("/im/v2/team_members")) return jsonResponse({ code: 200, data: { success_list: ["staff-1"], failed_list: [] } });
      if (url.includes("/im/v2/team_members/actions/kick_member")) return jsonResponse({ code: 200, data: {} });
      if (url.includes("/im/v2.1/teams/2366886326?")) return jsonResponse({ code: 200, data: {} });
      if (url.endsWith("/nimserver/team/query.action")) return jsonResponse({ code: 200, tinfos: [{ tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: serverExtension }] });
      if (url.endsWith("/nimserver/team/joinTeams.action")) return jsonResponse({ code: 200, tinfos: [{ tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: serverExtension }] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.createSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1", memberAccountIds: ["user-1", "staff-1"] }), { teamId: "2366886326" });
  assert.deepEqual(await api.getSupportTeam("2366886326"), { teamId: "2366886326", ownerAccountId: "system-1", memberAccountIds: ["system-1", "user-1", "staff-1"], serverExtension });
  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "FOUND", team: { teamId: "2366886326", ownerAccountId: "system-1", memberAccountIds: ["system-1", "user-1", "staff-1"], serverExtension } });
  await api.addSupportTeamMember("2366886326", "system-1", "staff-2");
  await api.removeSupportTeamMember("2366886326", "system-1", "staff-1");
  await api.dismissSupportTeam("2366886326", "system-1");
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
    { url: "https://api.yunxinapi.com/im/v2.1/teams", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/query.action", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/joinTeams.action", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/query.action", method: "POST" },
    { url: "https://api.yunxinapi.com/im/v2/team_members", method: "POST" },
    { url: "https://api.yunxinapi.com/im/v2/team_members/actions/kick_member", method: "DELETE" },
    { url: "https://api.yunxinapi.com/im/v2.1/teams/2366886326?team_type=1&operator_id=system-1", method: "DELETE" },
  ]);
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
    owner_account_id: "system-1",
    team_type: 1,
    name: "洲洲商行客服咨询-consult-1",
    members_limit: 4,
    server_extension: serverExtension,
    invite_account_ids: ["user-1", "staff-1"],
    invite_msg: "洲洲商行客服咨询邀请",
    extension: JSON.stringify({ consultationId: "consult-1" }),
    configuration: { join_mode: 2, agree_mode: 1, invite_mode: 0, update_team_info_mode: 0, update_extension_mode: 0 },
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[1]!.body))), { tids: JSON.stringify(["2366886326"]), ope: "1" });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[2]!.body))), { accid: "system-1" });
});

test("does not guess a support team when an owner-scoped candidate lacks a marker", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/joinTeams.action")) {
        return jsonResponse({ code: 200, tinfos: [
          { tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" }) },
          { tid: 2366886327, owner: "system-1", members: ["system-1", "user-2"], custom: null },
        ] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "AMBIGUOUS" });
});

test("does not treat a different team response as the requested team being absent", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/query.action")) {
        return jsonResponse({ code: 200, tinfos: [{ tid: 2366886327, owner: "system-1", members: ["system-1", "user-2"], custom: null }] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(
    api.getSupportTeam("2366886326"),
    (error: unknown) => error instanceof YunxinApiError && error.operation === "get-support-team" && !error.retryable,
  );
});

test("rejects duplicate or extra team objects in a single-team query", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, tinfos: [
      { tid: 2366886326, owner: "system-1", members: ["system-1"], custom: null },
      { tid: 2366886326, owner: "system-1", members: ["system-1"], custom: null },
    ] }),
  });

  await assert.rejects(
    api.getSupportTeam("2366886326"),
    (error: unknown) => error instanceof YunxinApiError && error.operation === "get-support-team" && !error.retryable,
  );
});
