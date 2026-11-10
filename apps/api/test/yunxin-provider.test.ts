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

test("single-message verification preserves an unquoted 64-bit ID and keeps order callbacks free of message text",async()=>{
  const api=new YunxinServerApiClient({appKey:APP_KEY,appSecret:APP_SECRET,fetch:async()=>new Response('{"code":200,"data":{"message_server_id":4301644928884146185,"message_client_id":"cid","sender_id":"sender","team_id":64099504484,"create_time":1793447398308,"message_type":0,"text":"confirmed A"}}',{status:200})});
  const input={teamId:"64099504484",operatorAccountId:"manager",messageServerId:"4301644928884146185",messageTime:1793447398308};
  const receipt=await api.readSupportMessage(input);assert.equal(receipt?.messageServerId,input.messageServerId);assert.equal(receipt?.text,"confirmed A");
  const order=await api.readTeamMessage(input);assert.equal(order?.messageServerId,input.messageServerId);assert.equal("text" in order!,false);
});

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

test("former-member history uses the viewer account and precise cursor without restoring hidden messages",async()=>{
  let calls=0;
  const api=new YunxinServerApiClient({appKey:APP_KEY,appSecret:APP_SECRET,fetch:async(_url,init)=>{
    calls++;const body=new URLSearchParams(String(init?.body));
    assert.equal(body.get("accid"),"staff-1");assert.equal(body.get("checkTeamValid"),"false");assert.equal(body.get("includeNoSenseMsg"),"false");
    assert.equal(body.get("excludeMsgid"),"4301564702653153303");assert.equal(body.get("endtime"),"30");
    return new Response('{"code":200,"msgs":[{"msgid":4301564702653153302,"from":"user-1","sendtime":20,"type":1,"body":{"url":"https://nos.example/image.png","w":32,"h":24,"size":100}},{"msgid":4301564702653153301,"from":"staff-1","sendtime":19,"type":0,"body":{"msg":"reply"}}]}',{status:200});
  }});
  const rows=await api.readSupportMemberHistory({teamId:"123",accountId:"staff-1",limit:50,before:{id:"4301564702653153303",time:30}});
  assert.deepEqual(rows.map(row=>row.messageServerId),["4301564702653153302","4301564702653153301"]);
  assert.equal(rows[0]!.attachment!.width,32);assert.equal(rows[0]!.attachment!.height,24);assert.equal(rows[1]!.text,"reply");
  await assert.rejects(api.readSupportMemberHistory({teamId:"123",accountId:"staff-1",limit:101}));
  await assert.rejects(api.readSupportMemberHistory({teamId:"123",accountId:"staff-1",limit:50,before:{id:"invalid",time:30}}));
  assert.equal(calls,1);
});

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
  assert.ok(calls.every(({ url }) => new URL(url).hostname === "open.yunxinapi.com"));
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
  assert.throws(
    () => new YunxinServerApiClient({ appKey: APP_KEY, appSecret: APP_SECRET, v2Endpoint: "https://api.yunxinapi.com" }),
    /not allowlisted/,
  );
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

test("accepts an omitted empty list only when the other list fully covers the request", async () => {
  // Measured V2 shape: every requested account is missing, so success_list is omitted.
  const measured = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({
      code: 200,
      data: { failed_list: [{ account_id: "missing-1", error_code: 103404 }] },
    }),
  });
  assert.deepEqual(await measured.getProfiles(["missing-1"]), {
    profiles: [],
    failed: [{ accountId: "missing-1", providerCode: 103404 }],
  });

  // Inferred symmetric path: failed_list omitted while success_list covers the request.
  const failedOmitted = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({
      code: 200,
      data: { success_list: [{ account_id: "staff-1", name: "客服一号" }] },
    }),
  });
  assert.deepEqual(await failedOmitted.getProfiles(["staff-1"]), {
    profiles: [{ accountId: "staff-1", name: "客服一号" }],
    failed: [],
  });

  const bothOmitted = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: {} }),
  });
  await assert.rejects(bothOmitted.getProfiles(["staff-1"]), YunxinApiError);

  const nullList = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { success_list: null, failed_list: [] } }),
  });
  await assert.rejects(nullList.getProfiles(["staff-1"]), YunxinApiError);

  const partialCoverage = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({
      code: 200,
      data: { failed_list: [{ account_id: "missing-1", error_code: 103404 }] },
    }),
  });
  await assert.rejects(partialCoverage.getProfiles(["missing-1", "missing-2"]), YunxinApiError);

  // getOnlineStatuses shares the adapter; its omission shape is inferred, not measured.
  const statuses = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({
      code: 200,
      data: { failed_list: [{ account_id: "missing-1", error_code: 103404 }] },
    }),
  });
  assert.deepEqual(await statuses.getOnlineStatuses(["missing-1"]), {
    statuses: [],
    failed: [{ accountId: "missing-1", providerCode: 103404 }],
  });
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
  const calls: Array<{ url: string; method: string; body: unknown; headers?: HeadersInit }> = [];
  const serverExtension = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method), body: init?.body, headers: init?.headers });
      if (url.endsWith("/im/v2.1/teams")) {
        return jsonResponse({ code: 200, data: { failed_list: [], team_info: { team_id: 2366886326, owner_account_id: "system-1" } } });
      }
      if (url.endsWith("/im/v2/team_members")) return jsonResponse({ code: 200, data: { success_list: ["staff-1"], failed_list: [] } });
      if (url.includes("/im/v2/team_members/actions/kick_member")) return jsonResponse({ code: 200, data: {} });
      if (url.includes("/im/v2.1/teams/2366886326?")) return jsonResponse({ code: 200, data: {} });
      if (url.endsWith("/nimserver/team/query.action")) return jsonResponse({ code: 200, tinfos: [{ tid: 2366886326, owner: "system-1", members: ["user-1", "staff-1"], clientCustom: serverExtension }] });
      if (url.endsWith("/nimserver/team/joinTeams.action")) return jsonResponse({ code: 200, count: 1, infos: [{ tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: serverExtension }] });
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
    { url: "https://open.yunxinapi.com/im/v2.1/teams", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/query.action", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/joinTeams.action", method: "POST" },
    { url: "https://api.yunxinapi.com/nimserver/team/query.action", method: "POST" },
    { url: "https://open.yunxinapi.com/im/v2/team_members", method: "POST" },
    { url: "https://open.yunxinapi.com/im/v2/team_members/actions/kick_member?operator_id=system-1&team_id=2366886326&team_type=1&kick_account_ids=staff-1", method: "DELETE" },
    { url: "https://open.yunxinapi.com/im/v2.1/teams/2366886326?team_type=1&operator_id=system-1", method: "DELETE" },
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
  assert.equal(calls[5]!.body, undefined);
  assert.deepEqual(Object.fromEntries(new URL(calls[5]!.url).searchParams), {
    operator_id: "system-1",
    team_id: "2366886326",
    team_type: "1",
    kick_account_ids: "staff-1",
  });
  assert.equal(new Headers(calls[5]!.headers).get("Content-Type"), null);
});

test("uses the exact V2 team read for close absence and fails closed on non-absence results", async () => {
  const marker = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "close-1" });
  let requestUrl = "";
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      requestUrl = String(input);
      return jsonResponse({ code: 200, data: { team_info: {
        team_id: 2366886340,
        team_type: 1,
        owner_account_id: "system-1",
        server_extension: marker,
      } } });
    },
  });
  assert.deepEqual(await api.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }), {
    status: "FOUND",
    team: { teamId: "2366886340", teamType: 1, ownerAccountId: "system-1", serverExtension: marker },
  });
  assert.equal(requestUrl, "https://open.yunxinapi.com/im/v2.1/teams/2366886340?team_type=1");

  for (const [body, status] of [
    [{ code: 108404 }, 200],
    [{ code: 109404 }, 200],
    [{ code: 108404 }, 404],
    [{ code: 414, data: {} }, 200],
  ] as const) {
    const candidate = new YunxinServerApiClient({ appKey: APP_KEY, appSecret: APP_SECRET, fetch: async () => jsonResponse(body, status) });
    if (status === 200 && body.code === 108404) {
      assert.deepEqual(await candidate.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }), { status: "ABSENT" });
    } else {
      await assert.rejects(
        candidate.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }),
        (error: unknown) => error instanceof YunxinApiError && error.httpStatus === status && error.providerCode === body.code,
      );
    }
  }

  const ambiguous = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { team_info: {
      team_id: 2366886340,
      team_type: 1,
      owner_account_id: "system-1",
      server_extension: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "other-app", consultationId: "close-1" }),
    } } }),
  });
  assert.deepEqual(await ambiguous.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }), { status: "AMBIGUOUS" });

  const malformed = new YunxinServerApiClient({ appKey: APP_KEY, appSecret: APP_SECRET, fetch: async () => new Response("{", { status: 200 }) });
  await assert.rejects(
    malformed.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }),
    (error: unknown) => error instanceof YunxinApiError && error.httpStatus === 200 && error.providerCode === null,
  );

  const wrongTeam = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { team_info: {
      team_id: 2366886341,
      team_type: 1,
      owner_account_id: "system-1",
      server_extension: marker,
    } } }),
  });
  assert.deepEqual(await wrongTeam.readSupportTeamExistence({ appId: "provider-test", consultationId: "close-1", ownerAccountId: "system-1", teamId: "2366886340" }), { status: "AMBIGUOUS" });
});

test("parses the observed standard-team clientCustom and implicit-owner shape", async () => {
  const serverExtension = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "client-custom-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/query.action")) {
        return jsonResponse({
          code: 200,
          tinfos: [{ tid: 2366886328, owner: "system-1", members: ["user-1", "staff-1"], clientCustom: serverExtension }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.getSupportTeam("2366886328"), {
    teamId: "2366886328",
    ownerAccountId: "system-1",
    memberAccountIds: ["system-1", "user-1", "staff-1"],
    serverExtension,
  });
});

test("ignores unrelated historical teams and selects the uniquely matching marker", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/joinTeams.action")) {
        return jsonResponse({ code: 200, count: 3, infos: [
          { tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" }) },
          { tid: 2366886327, owner: "system-1", members: ["system-1", "user-2"], custom: null },
          { tid: 2366886328, owner: "system-1", members: ["system-1", "user-3"], custom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-2" }) },
        ] });
      }
      if (url.endsWith("/nimserver/team/query.action")) {
        return jsonResponse({ code: 200, tinfos: [
          { tid: 2366886326, owner: "system-1", members: ["system-1", "user-1", "staff-1"], custom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" }) },
        ] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), {
    status: "FOUND",
    team: { teamId: "2366886326", ownerAccountId: "system-1", memberAccountIds: ["system-1", "user-1", "staff-1"], serverExtension: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" }) },
  });
});

test("fails closed when two owner-scoped teams carry the same consultation marker", async () => {
  const marker = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/joinTeams.action")) {
        return jsonResponse({ code: 200, count: 2, infos: [
          { tid: 2366886326, owner: "system-1", members: ["system-1", "user-1"], custom: marker },
          { tid: 2366886327, owner: "system-1", members: ["system-1", "user-2"], custom: marker },
        ] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "AMBIGUOUS" });
});

test("treats teams with other markers or unparsable extensions as absent for this consultation", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/joinTeams.action")) {
        return jsonResponse({ code: 200, count: 3, infos: [
          { tid: 2366886326, owner: "system-1", members: ["system-1", "user-1"], custom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-other" }) },
          { tid: 2366886327, owner: "system-1", members: ["system-1", "user-2"], custom: null },
          { tid: 2366886328, owner: "system-1", members: ["system-1", "user-3"], custom: "not-json" },
        ] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "ABSENT" });
});

test("accepts an advanced-team empty result with the observed omitted infos field", async () => {
  for (const payload of [{ code: 200, count: 0 }, { code: 200, count: 0, infos: [] }]) {
    const api = new YunxinServerApiClient({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/nimserver/team/joinTeams.action")) return jsonResponse(payload);
        throw new Error(`unexpected URL ${url}`);
      },
    });

    assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "ABSENT" });
  }
});

test("rejects an advanced-team response with missing infos or inconsistent count", async () => {
  for (const payload of [
    { code: 200, count: 2, infos: [] },
    { code: 200, count: 1 },
    { code: 200, infos: [] },
  ]) {
    const api = new YunxinServerApiClient({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/nimserver/team/joinTeams.action")) return jsonResponse(payload);
        throw new Error(`unexpected URL ${url}`);
      },
    });

    await assert.rejects(
      api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }),
      (error: unknown) => error instanceof YunxinApiError && error.operation === "find-support-team" && error.providerCode === null && !error.retryable,
    );
  }
});

test("does not select duplicated clientCustom markers", async () => {
  const marker = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/joinTeams.action")) return jsonResponse({ code: 200, count: 2, infos: [
        { tid: 2366886326, owner: "system-1", members: ["user-1"], clientCustom: marker },
        { tid: 2366886327, owner: "system-1", members: ["user-1"], clientCustom: marker },
      ] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "AMBIGUOUS" });
});

test("does not match a clientCustom marker with the wrong owner or consultation", async () => {
  const cases = [
    { tid: 2366886330, owner: "other-owner", clientCustom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" }) },
    { tid: 2366886331, owner: "system-1", clientCustom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "other-app", consultationId: "consult-1" }) },
    { tid: 2366886332, owner: "system-1", clientCustom: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "other-consultation" }) },
  ];
  for (const candidate of cases) {
    const api = new YunxinServerApiClient({
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/nimserver/team/joinTeams.action")) {
          return jsonResponse({ code: 200, count: 1, infos: [{ ...candidate, members: ["user-1"] }] });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });

    assert.deepEqual(await api.findSupportTeam({ appId: "provider-test", consultationId: "consult-1", ownerAccountId: "system-1" }), { status: "ABSENT" });
  }
});

test("fails closed when distinct team extension fields conflict", async () => {
  const marker = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "provider-test", consultationId: "consult-1" });
  const otherMarker = JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: "other-app", consultationId: "consult-1" });
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/query.action")) {
        return jsonResponse({
          code: 200,
          tinfos: [{ tid: 2366886333, owner: "system-1", members: ["user-1"], custom: otherMarker, clientCustom: marker }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(
    api.getSupportTeam("2366886333"),
    (error: unknown) => error instanceof YunxinApiError && error.operation === "team-response" && !error.retryable,
  );
});

test("rejects a duplicated owner in the returned member list", async () => {
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/nimserver/team/query.action")) {
        return jsonResponse({ code: 200, tinfos: [{ tid: 2366886334, owner: "system-1", members: ["system-1", "system-1"], clientCustom: null }] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await assert.rejects(
    api.getSupportTeam("2366886334"),
    (error: unknown) => error instanceof YunxinApiError && error.operation === "team-response" && !error.retryable,
  );
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

test("automatic Team text forwards its stable id through the official message field",async()=>{
  const bodies:unknown[]=[];
  const api=new YunxinServerApiClient({appKey:APP_KEY,appSecret:APP_SECRET,fetch:async(_url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({code:200,data:{sender_id:"review_sender",conversation_type:2,message_type:0,create_time:1793447398308,receiver_id:"900001"}}),{status:200});
  }});
  const input={teamId:"900001",senderAccountId:"review_sender",text:"自动通知",messageClientId:"support_notice_original"};
  await api.sendSupportTeamText(input);await api.sendSupportTeamText(input);
  assert.deepEqual(bodies,[{message:{message_type:0,text:input.text,message_client_id:input.messageClientId}},{message:{message_type:0,text:input.text,message_client_id:input.messageClientId}}]);
});

test("automatic Team cards use a type-100 custom message with a minimal raw payload",async()=>{
  const bodies:unknown[]=[];
  const api=new YunxinServerApiClient({appKey:APP_KEY,appSecret:APP_SECRET,fetch:async(_url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({code:200,data:{message_server_id:"4301644928884146190",sender_id:"review_sender",conversation_type:2,message_type:100,create_time:1793447398308,receiver_id:"900001"}}),{status:200});
  }});
  const card={kind:"ORDER_OPENING" as const,orderId:"order_stage_1",cardId:"im_card_event_1"};
  await api.sendSupportTeamCard({teamId:"900001",senderAccountId:"review_sender",card,text:"开租确认卡",messageClientId:"im_card_event_1"});
  assert.equal(bodies.length,1);
  const message=(bodies[0] as {message:Record<string,unknown>}).message;
  assert.equal(message.message_type,100);
  assert.equal(message.text,"开租确认卡");
  assert.equal(message.message_client_id,"im_card_event_1");
  assert.deepEqual(JSON.parse(String((message.attachment as {raw:string}).raw)),{schema:"zzsh.order-card",version:1,...card});
  await assert.rejects(api.sendSupportTeamCard({teamId:"900001",senderAccountId:"review_sender",card:{...card,orderId:"../private"},text:"开租确认卡",messageClientId:"im_card_event_1"}));
});

test("cloud conversation pages are bounded and keep only the monitoring fields", async () => {
  const urls: string[] = [];
  const api = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async (input) => {
      urls.push(String(input));
      return jsonResponse({ code: 200, data: { has_more: false, next_token: null, items: [
        { conversation_id: "staff-1|2|123", stick_top: true, type: 2, update_time: 1 },
        { conversation_id: "staff-1|2|456", stick_top: false, type: 2, update_time: 2 },
      ] } });
    },
  });
  const page = await api.listCloudConversations({ accountId: "staff-1", limit: 100 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.stickTop, true);
  assert.equal(page.items[1]!.stickTop, false);
  assert.equal(page.hasMore, false);
  assert.match(urls[0]!, /\/im\/v2\.1\/conversations\?account_id=staff-1&limit=100$/);
  await assert.rejects(api.listCloudConversations({ accountId: "bad id" }));

  const malformed = new YunxinServerApiClient({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => jsonResponse({ code: 200, data: { has_more: false, items: [
      { conversation_id: "staff-1|2|123", stick_top: "yes", type: 2, update_time: 1 },
    ] } }),
  });
  await assert.rejects(malformed.listCloudConversations({ accountId: "staff-1" }), YunxinApiError);
});
