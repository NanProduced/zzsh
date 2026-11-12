import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createLocalFakeNimWebClientFactory,
  createNimWebClientFactory,
  mergeImMessages,
  NimImageSendError,
  NimLoginTerminalError,
  NimMediaSendError,
  NimTextSendError,
  parseNimMessageMedia,
  oldestNimMessage,
  resolveNimSdkModule,
  validateNimMediaFile,
  encodeOrderStageCard,
  parseOrderStageCard,
  nimMessageView,
} from "../src/lib/nim-web-client.ts";

test("NIM custom message type 100 maps only the platform order-card shape", () => {
  const card = { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" };
  const raw = encodeOrderStageCard(card);
  assert.deepEqual(parseOrderStageCard(raw), card);
  assert.deepEqual(parseOrderStageCard({ raw }), card);
  assert.equal(parseOrderStageCard({ raw: JSON.stringify({ schema: "zzsh.order-card", version: 2, ...card }) }), null);
  assert.equal(parseOrderStageCard({ raw: JSON.stringify({ ...card, amount: "1" }) }), null);
  assert.equal(parseOrderStageCard({ raw: JSON.stringify({ ...card, orderId: "../private" }) }), null);
  const base = { messageClientId: "m1", messageServerId: "s1", conversationId: "bot|2|team", senderId: "bot", receiverId: "team", createTime: 1, messageType: 100, text: "开租确认卡" };
  assert.deepEqual(nimMessageView({ ...base, attachment: { raw } })?.card, card);
  assert.equal(nimMessageView({ ...base, attachment: { raw: "{\"unknown\":true}" } })?.card, undefined);
  assert.equal(nimMessageView({ ...base, revoked: true, attachment: { raw } })?.card, undefined);
});

test("history anchor keeps adjacent 64-bit IDs in order when their millisecond timestamps tie",()=>{
  const newer={messageClientId:"newer",messageServerId:"4301644928884146185",createTime:1000};
  const older={...newer,messageClientId:"older",messageServerId:"4301644928884146184"};
  assert.equal(oldestNimMessage([newer,older]),older);
  assert.equal(oldestNimMessage([]),undefined);
  const earlier={...newer,createTime:999};assert.equal(oldestNimMessage([older,earlier]),earlier);
});
import { ImClientLifecycle, ImLifecycleSupersededError } from "../src/lib/im-client-lifecycle.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeLoginService {
  listeners = new Map();
  loginStatus = 0;
  connectStatus = 0;
  loginArgs;
  logoutCalls = 0;

  on(eventName, listener) {
    const handlers = this.listeners.get(eventName) ?? new Set();
    handlers.add(listener);
    this.listeners.set(eventName, handlers);
  }

  off(eventName, listener) {
    this.listeners.get(eventName)?.delete(listener);
  }

  emit(eventName, ...args) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(...args);
  }

  async login(accountId, token, options) {
    this.loginArgs = { accountId, token, options };
    if (options?.tokenProvider) await options.tokenProvider();
    this.loginStatus = 1;
    this.connectStatus = 1;
    this.emit("onLoginStatus", 1);
    this.emit("onConnectStatus", 1);
  }

  async logout() {
    this.logoutCalls += 1;
    this.loginStatus = 0;
    this.connectStatus = 0;
    this.emit("onLoginStatus", 0);
    this.emit("onConnectStatus", 0);
  }

  getConnectStatus() {
    return this.connectStatus;
  }
}

function fakeSdk({ loginService = new FakeLoginService(), loginError, destroyError, destroyAction, messageService, messageCreator, conversationUtil, storageService, conversationService } = {}) {
  const calls = { initialize: [], destroyed: 0 };
  const sdk = {
    getInstance(initializeOptions, otherOptions) {
      calls.initialize.push({ initializeOptions, otherOptions });
      return {
        V2NIMLoginService: {
          ...loginService,
          async login(...args) {
            if (loginError) throw loginError;
            return loginService.login(...args);
          },
          async logout(...args) {
            return loginService.logout(...args);
          },
          on: loginService.on.bind(loginService),
          off: loginService.off.bind(loginService),
          getConnectStatus: loginService.getConnectStatus.bind(loginService),
        },
        V2NIMMessageService: messageService,
        V2NIMMessageCreator: messageCreator,
        V2NIMStorageService: storageService,
        V2NIMConversationIdUtil: conversationUtil,
        V2NIMConversationService: conversationService,
        async destroy() {
          calls.destroyed += 1;
          if (destroyAction) await destroyAction();
          if (destroyError) throw destroyError;
        },
      };
    },
  };
  return { sdk, calls, loginService };
}

function testContext(identity) {
  let current = true;
  return {
    context: {
      identity,
      generation: 1,
      isCurrent: () => current,
      onCurrent: (callback) => (...args) => {
        if (current) callback(...args);
      },
    },
    supersede: () => {
      current = false;
    },
  };
}

test("order-scoped authorization guards the shared SDK and forwards an exact history anchor",async()=>{
  let sends=0,reads=0,defaultCalls=0,seen;
  const anchor={messageClientId:"older",conversationId:"viewer|2|1",senderId:"viewer",receiverId:"1",createTime:1};
  const {sdk}=fakeSdk({messageService:{on(){},off(){},async getMessageList(options){reads++;seen=options;return [];},async sendMessage(){sends++;return {message:anchor};}},messageCreator:{createTextMessage:text=>({messageClientId:'text-client-1',text})}});
  const state=testContext("viewer"),handle=await createNimWebClientFactory({appKey:"test",token:"test",messageAuthorization:async()=>{defaultCalls++;}},async()=>sdk)(state.context);
  try{
    const deny=async()=>{throw Object.assign(new Error("denied"),{status:403});};
    await assert.rejects(handle.client.getMessageHistory(anchor.conversationId,50,anchor,deny),{status:403});
    await assert.rejects(handle.client.sendText(anchor.conversationId,"text",deny),{status:403});
    assert.equal(reads+sends+defaultCalls,0);
    await handle.client.getMessageHistory(anchor.conversationId,50,anchor,async()=>undefined);
    assert.deepEqual(seen,{conversationId:anchor.conversationId,limit:50,direction:0,anchorMessage:anchor});
    const gate=deferred();const pending=handle.client.sendText(anchor.conversationId,"text",()=>gate.promise);
    state.supersede();gate.resolve();await assert.rejects(pending,ImLifecycleSupersededError);assert.equal(sends,0);
  }finally{await handle.dispose();}
});

test("initializes the V2 SDK, logs in, maps connection states, and cleans up listeners", async () => {
  const { sdk, calls, loginService } = fakeSdk();
  const factory = createNimWebClientFactory(
    {
      appKey: "test-app-key",
      token: "test-token",
      debugLevel: "off",
      retryCount: 2,
      timeout: 5000,
      lbsUrls: ["https://example.test/lbs"],
      linkUrl: "https://example.test/link",
    },
    async () => sdk,
  );
  const { context } = testContext("customer-1");
  const handle = await factory(context);

  assert.deepEqual(calls.initialize[0], {
    initializeOptions: {
      appkey: "test-app-key",
      apiVersion: "v2",
      debugLevel: "off",
      enableV2CloudConversation: false,
    },
    otherOptions: {
      V2NIMLoginServiceConfig: {
        lbsUrls: ["https://example.test/lbs"],
        linkUrl: "https://example.test/link",
      },
    },
  });
  assert.equal(loginService.loginArgs.accountId, "customer-1");
  assert.equal(loginService.loginArgs.token, "test-token");
  assert.deepEqual(loginService.loginArgs.options, {
    authType: 0,
    forceMode: false,
    retryCount: 2,
    timeout: 5000,
  });
  assert.equal(handle.client.getConnectionState(), "CONNECTED");

  const states = [];
  const details = [];
  const unsubscribe = handle.client.onConnectionStateChange((state, detail) => { states.push(state); details.push(detail); });
  loginService.connectStatus = 2;
  loginService.emit("onConnectStatus", 2);
  loginService.emit("onLoginStatus", 0);
  loginService.connectStatus = 3;
  loginService.emit("onConnectStatus", 3);
  loginService.emit("onKickedOffline", { reason: 1, reasonDesc: "another desktop", clientType: 4 });
  loginService.emit("onDisconnected");
  loginService.emit("onLoginFailed", { code: 1001 });
  loginService.emit("onDisconnected");
  assert.deepEqual(states, ["CONNECTING", "DISCONNECTED", "RECONNECTING", "KICKED"], "KICKED is terminal and is not overwritten by a later login-failure event");
  assert.equal(details[1]?.kind, "LOGOUT", "a non-kicked LOGOUT is distinguishable from a transport break");
  assert.equal(details[3]?.kickedReason, 1);
  assert.equal(details[3]?.kickedReasonDesc, "another desktop");
  unsubscribe();

  await handle.dispose();
  assert.equal(loginService.logoutCalls, 1);
  assert.equal(calls.destroyed, 1);
  loginService.emit("onConnectStatus", 1);
  assert.deepEqual(states, ["CONNECTING", "DISCONNECTED", "RECONNECTING", "KICKED"]);
});

test("KICKED outranks an earlier auth failure and later events are ignored", async () => {
  const { sdk, loginService } = fakeSdk();
  const factory = createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk);
  const handle = await factory(testContext("customer-1").context);
  const states = [];
  handle.client.onConnectionStateChange((state) => states.push(state));
  loginService.emit("onLoginFailed", { code: 1001 });
  loginService.emit("onKickedOffline", { reason: 1, reasonDesc: "another desktop" });
  loginService.emit("onLoginFailed", { code: 1002 });
  loginService.emit("onDisconnected");
  assert.deepEqual(states, ["AUTH_FAILED", "KICKED"], "a real kick must cancel the auth-failure retry path");
  await handle.dispose();
});

test("cloud conversation pinning is opt-in and uses the per-account conversation ids", async () => {
  const pinned = new Set(["viewer|2|111"]);
  let syncFinished;
  const service = {
    on(eventName, listener) { if (eventName === "onSyncFinished") syncFinished = listener; },
    off() {},
    async getStickTopConversationList() { return [...pinned].map((conversationId) => ({ conversationId, stickTop: true })); },
    async stickTopConversation(conversationId, stickTop) { if (stickTop) pinned.add(conversationId); else pinned.delete(conversationId); },
  };
  const { sdk, calls } = fakeSdk({ conversationService: service });
  const { context } = testContext("viewer");
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token", enableCloudConversation: true }, async () => sdk)(context);
  assert.equal(calls.initialize[0].initializeOptions.enableV2CloudConversation, true);
  assert.deepEqual(calls.initialize[0].otherOptions, { V2NIMSyncServiceConfig: { stickTopSessions: true } });
  assert.equal(typeof syncFinished, "function");
  syncFinished();
  assert.deepEqual(await handle.client.getStickTopConversationIds(), ["viewer|2|111"]);
  await handle.client.setConversationStickTop("viewer|2|222", true);
  await handle.client.setConversationStickTop("viewer|2|111", false);
  assert.deepEqual(await handle.client.getStickTopConversationIds(), ["viewer|2|222"]);
  await handle.dispose();
});

test("unwraps the browser package's nested default export", () => {
  const sdk = { getInstance: () => ({ }) };
  const sdkFunction = Object.assign(() => undefined, sdk);
  assert.equal(resolveNimSdkModule({ default: sdk }), sdk);
  assert.equal(resolveNimSdkModule({ default: { default: sdkFunction } }), sdkFunction);
  assert.equal(resolveNimSdkModule({ default: { default: {} } }), undefined);
});

test("guards dynamic token refresh against a superseded identity", async () => {
  const tokenGate = deferred();
  const { sdk, calls, loginService } = fakeSdk();
  const factory = createNimWebClientFactory(
    {
      appKey: "test-app-key",
      tokenProvider: async () => tokenGate.promise,
    },
    async () => sdk,
  );
  const testState = testContext("customer-2");
  const opening = factory(testState.context);
  await new Promise((resolve) => setImmediate(resolve));
  testState.supersede();
  tokenGate.resolve("refreshed-token");

  await assert.rejects(opening, (error) => error instanceof ImLifecycleSupersededError);
  assert.equal(loginService.loginArgs.accountId, "customer-2");
  assert.equal(calls.destroyed, 1);
});

test("destroys an SDK instance after login failure", async () => {
  const { sdk, calls } = fakeSdk({ loginError: new Error("invalid token") });
  const factory = createNimWebClientFactory(
    { appKey: "test-app-key", token: "bad-token" },
    async () => sdk,
  );

  await assert.rejects(factory(testContext("customer-3").context), /invalid token/);
  assert.equal(calls.destroyed, 1);
});

test("lifecycle waits for the same real SDK cleanup during loading, login and active connection, including failure", async () => {
  for (const stage of ["active", "login", "loader"]) for (const failedCleanup of [false, true]) {
    const loginGate = deferred(), loaderGate = deferred(), destroyGate = deferred(), destroyStarted = deferred();
    const loginService = new FakeLoginService(), cleanupError = new Error("synthetic destroy failure");
    if (stage === "login") loginService.login = () => loginGate.promise;
    const { sdk, calls } = fakeSdk({ loginService, destroyAction: async () => {
      if (stage === "login") loginGate.reject(new Error("synthetic cancelled login"));
      destroyStarted.resolve();
      await destroyGate.promise;
    } });
    const lifecycle = new ImClientLifecycle(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, () => stage === "loader" ? loaderGate.promise : Promise.resolve(sdk)));
    const opening = lifecycle.open("customer");
    const openingResult = opening.then(value => ({ value }), error => ({ error }));
    if (stage === "active") await opening; else await new Promise(resolve => setImmediate(resolve));
    let closed = false;
    const closing = lifecycle.close().then(() => { closed = true; return null; }, error => { closed = true; return error; });
    if (stage === "loader") loaderGate.resolve(sdk);
    await destroyStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, `close must wait for SDK destroy; stage=${stage}, failure=${failedCleanup}`);
    assert.equal(calls.destroyed, 1, "the SDK is destroyed once");
    if (failedCleanup) destroyGate.reject(cleanupError); else destroyGate.resolve();
    const [opened, closeError] = await Promise.all([openingResult, closing]);
    if (stage !== "active") assert.ok(opened.error, "cancelled opening is rejected");
    if (failedCleanup) assert.equal(closeError, cleanupError, "failed cleanup prevents a successful handoff and retains the original error");
    else assert.equal(closeError, null);
    assert.equal(calls.destroyed, 1, "concurrent cleanup does not destroy twice");
  }
});

test("initial login preserves only current kicked/auth terminal events and leaves network failures unchanged", async () => {
  for (const [event, state] of [["onKickedOffline", "KICKED"], ["onLoginFailed", "AUTH_FAILED"]]) {
    const loginService = new FakeLoginService();
    const original = new Error("sensitive provider detail");
    loginService.login = async () => { loginService.emit(event, { code: 123, reason: 1 }); throw original; };
    const { sdk, calls } = fakeSdk({ loginService });
    const factory = createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk);
    await assert.rejects(factory(testContext("customer").context), error => {
      assert.ok(error instanceof NimLoginTerminalError);
      assert.equal(error.state, state);
      assert.equal(error.cause, original);
      assert.doesNotMatch(error.message, /sensitive provider detail/);
      return true;
    });
    assert.equal(calls.destroyed, 1);

    const resolvedService = new FakeLoginService();
    resolvedService.login = async () => { resolvedService.emit(event, { code: 123, reason: 1 }); };
    const resolved = fakeSdk({ loginService: resolvedService });
    await assert.rejects(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => resolved.sdk)(testContext("customer").context), error => error instanceof NimLoginTerminalError && error.state === state);
    assert.equal(resolved.calls.destroyed, 1);
  }
  const network = new Error("synthetic network outage");
  const normal = fakeSdk({ loginError: network });
  const factory = createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => normal.sdk);
  await assert.rejects(factory(testContext("customer").context), error => error === network);
  assert.equal(normal.calls.destroyed, 1);
  const networkLogin = new FakeLoginService();
  networkLogin.login = async () => { networkLogin.emit("onConnectFailed", { code: 503 }); throw network; };
  const networkEvent = fakeSdk({ loginService: networkLogin });
  await assert.rejects(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => networkEvent.sdk)(testContext("customer").context), error => error === network);
  assert.equal(networkEvent.calls.destroyed, 1);

  const cleanup = new Error("synthetic cleanup failure"), original = new Error("synthetic login failure");
  const kickedLogin = new FakeLoginService();
  kickedLogin.login = async () => { kickedLogin.emit("onKickedOffline", { reason: 1 }); throw original; };
  const failedCleanup = fakeSdk({ loginService: kickedLogin, destroyError: cleanup });
  await assert.rejects(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => failedCleanup.sdk)(testContext("customer").context), error => {
    assert.ok(error instanceof NimLoginTerminalError);assert.equal(error.state, "KICKED");
    assert.ok(error.cause instanceof AggregateError);assert.deepEqual(error.cause.errors, [original, cleanup]);
    assert.doesNotMatch(error.message, /synthetic/);return true;
  });
  const ordinaryCleanup = fakeSdk({ loginError: network, destroyError: cleanup });
  await assert.rejects(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => ordinaryCleanup.sdk)(testContext("customer").context), error => error === cleanup);

  const old = testContext("old-customer"), loginService = new FakeLoginService(), failure = new Error("old failure");
  loginService.login = async () => { loginService.emit("onKickedOffline", { reason: 1 }); old.supersede(); throw failure; };
  const superseded = fakeSdk({ loginService });
  await assert.rejects(createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => superseded.sdk)(old.context), error => error === failure && !(error instanceof NimLoginTerminalError));
  assert.equal(superseded.calls.destroyed, 1);
});

test("routes authorized P2P messages through the SDK and removes the receive listener", async () => {
  const messageListeners = new Map();
  const sent = [];
  const authorizations = [];
  const history = [{ messageClientId: "history-1", conversationId: "customer-4|1|agent-1", senderId: "agent-1", receiverId: "customer-4", createTime: 1, messageType: 0, text: "历史消息" }];
  const messageService = {
    on(eventName, listener) { messageListeners.set(eventName, listener); },
    off(eventName, listener) { if (messageListeners.get(eventName) === listener) messageListeners.delete(eventName); },
    async getMessageList(options) { assert.deepEqual(options, { conversationId: "customer-4|1|agent-1", limit: 20, direction: 0 }); return history; },
    async sendMessage(message, conversationId) { sent.push({ message, conversationId }); return { message: { ...history[0], messageClientId: "sent-1", senderId: "customer-4", text: message.text } }; },
  };
  const { sdk } = fakeSdk({
    messageService,
    messageCreator: { createTextMessage: (text) => ({ messageClientId: 'text-client-1', text, messageType: 0 }) },
    conversationUtil: { p2pConversationId: (peer) => `customer-4|1|${peer}`, teamConversationId: (teamId) => `customer-4|2|${teamId}` },
  });
  const factory = createNimWebClientFactory({
    appKey: "test-app-key",
    token: "test-token",
    messageAuthorization: async (input) => { authorizations.push(input); },
  }, async () => sdk);
  const handle = await factory(testContext("customer-4").context);
  assert.equal(handle.client.conversationIdForPeer("agent-1"), "customer-4|1|agent-1");
  assert.equal(handle.client.conversationIdForTeam("9001"), "customer-4|2|9001");
  const received = [];
  const unsubscribe = handle.client.onMessages((messages) => received.push(...messages));
  const incoming = { ...history[0], messageClientId: "incoming-1", senderId: "agent-1" };
  messageListeners.get("onReceiveMessages")([incoming]);
  assert.deepEqual(received, [incoming]);
  assert.deepEqual(await handle.client.getMessageHistory("customer-4|1|agent-1", 20), history);
  const reply = await handle.client.sendText("customer-4|1|agent-1", "收到");
  assert.equal(reply.text, "收到");
  assert.deepEqual(sent, [{ message: { messageClientId: "text-client-1", text: "收到", messageType: 0 }, conversationId: "customer-4|1|agent-1" }]);
  assert.deepEqual(authorizations, [
    { conversationId: "customer-4|1|agent-1", operation: "read" },
    { conversationId: "customer-4|1|agent-1", operation: "send", messageClientId:"text-client-1", messageType:0 },
  ]);
  unsubscribe();
  await handle.dispose();
  assert.equal(messageListeners.size, 0);
});

test("does not call the SDK when the server message authorization is rejected", async () => {
  let historyCalls = 0;
  let sendCalls = 0;
  const messageService = {
    on() {},
    off() {},
    async getMessageList() { historyCalls += 1; return []; },
    async sendMessage() { sendCalls += 1; return { message: {} }; },
  };
  const { sdk } = fakeSdk({
    messageService,
    messageCreator: { createTextMessage: (text) => ({ messageClientId: 'text-client-1', text }) },
  });
  const factory = createNimWebClientFactory({
    appKey: "test-app-key",
    token: "test-token",
    messageAuthorization: async ({ operation }) => {
      const error = new Error(`denied:${operation}`);
      error.status = 403;
      throw error;
    },
  }, async () => sdk);
  const handle = await factory(testContext("customer-denied").context);
  await assert.rejects(handle.client.getMessageHistory("customer-denied|2|9001"), (error) => error?.status === 403);
  await assert.rejects(handle.client.sendText("customer-denied|2|9001", "hello"), (error) => error?.status === 403);
  assert.equal(historyCalls, 0);
  assert.equal(sendCalls, 0);
  await handle.dispose();
});

test("passes the per-message route only for the exact authorized team and blocks stale or mismatched grants", async () => {
  const sent = [];
  const messageService = {
    on() {}, off() {},
    async sendMessage(...args) { sent.push(args); return { message: { messageClientId: `sent-${sent.length}`, conversationId: args[1] } }; },
  };
  const grant = { appId: "test-app", orderId: "order-1", teamId: "9001", conversationId: "staff-1|2|9001", routeEnvironment: "oim4d-test" };
  const { sdk } = fakeSdk({ messageService, messageCreator: { createTextMessage: (text) => ({ messageClientId: 'text-client-1', text }) } });
  const state = testContext("staff-1");
  const handle = await createNimWebClientFactory({ appKey: "test-app", token: "test-token" }, async () => sdk)(state.context);
  try {
    await handle.client.sendText(grant.conversationId, "scoped", async ({ conversationId }) => conversationId === grant.conversationId ? grant : undefined);
    await handle.client.sendText("staff-1|1|peer-1", "ordinary", async () => undefined);
    assert.deepEqual(sent[0]?.[2], { routeConfig: { routeEnabled: true, routeEnvironment: "oim4d-test" } });
    assert.equal(sent[0]?.length, 3);
    assert.equal(sent[1]?.length, 2);
    await assert.rejects(handle.client.sendText("staff-1|2|9002", "wrong-team", async () => grant), /route scope is invalid/);
    assert.equal(sent.length, 2);

    const gate = deferred();
    const stale = handle.client.sendText(grant.conversationId, "late", () => gate.promise);
    await new Promise((resolve) => setImmediate(resolve));
    state.supersede();
    gate.resolve(grant);
    await assert.rejects(stale, ImLifecycleSupersededError);
    assert.equal(sent.length, 2);
  } finally { await handle.dispose(); }
});

test("formal image adapter uses the installed V2 image creator, reports progress, and retries the same message after an unknown result", async () => {
  const sent = [];
  let first = true;
  const messageService = {
    on() {},
    off() {},
    async sendMessage(message, conversationId, params, progress) {
      sent.push({ message, conversationId, params });
      progress?.(42);
      if (first) {
        first = false;
        throw new Error("connection lost after upload");
      }
      return { message: { ...message, conversationId, senderId: "customer-image", receiverId: "9001", createTime: 2, messageType: 1, attachment: { url: "https://nos.example/image" } } };
    },
  };
  const created = [];
  const { sdk } = fakeSdk({
    messageService,
    storageService: {},
    messageCreator: {
      createImageMessage(file, name, sceneName, width, height) {
        const message = { messageClientId: "image-client-1", file, name, sceneName, width, height, messageType: 1 };
        created.push(message);
        return message;
      },
      createTextMessage: (text) => ({ messageClientId: 'text-client-1', text }),
    },
  });
  const authorizations = [];
  const progress = [];
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("customer-image").context);
  const file = new File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });
  const route = { appId: "test-app", orderId: "order-image", teamId: "9001", conversationId: "customer-image|2|9001", routeEnvironment: "oim4d-test" };
  const authorize = async (input) => { authorizations.push(input); return route; };
  await assert.rejects(handle.client.sendImage("customer-image|2|9001", file, { authorize, width: 12, height: 8, onProgress: (value) => progress.push(value) }), (error) => error instanceof NimImageSendError && error.kind === "UNKNOWN" && error.messageClientId === "image-client-1");
  const reply = await handle.client.retryImage("customer-image|2|9001", "image-client-1", { authorize, onProgress: (value) => progress.push(value) });
  assert.equal(reply.messageClientId, "image-client-1");
  assert.equal(sent[0].message, sent[1].message);
  assert.deepEqual(sent.map(call => call.params), [
    { routeConfig: { routeEnabled: true, routeEnvironment: "oim4d-test" } },
    { routeConfig: { routeEnabled: true, routeEnvironment: "oim4d-test" } },
  ]);
  assert.equal(created.length, 1);
  assert.deepEqual(authorizations, [
    { conversationId: "customer-image|2|9001", operation: "send", messageClientId:"image-client-1", messageType:1 },
    { conversationId: "customer-image|2|9001", operation: "send", messageClientId:"image-client-1", messageType:1 },
  ]);
  assert.deepEqual(progress, [0, 42, 0, 42, 100]);
  await handle.dispose();
});

test("local fake image transport sends a bounded same-origin payload and keeps the client message ID for retry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let first = true;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (first) {
      first = false;
      throw new Error("local transport interrupted");
    }
    const body = JSON.parse(init.body);
    return Response.json({ message: {
      messageClientId: body.image.messageClientId,
      messageServerId: body.image.messageClientId,
      conversationId: body.conversationId,
      senderId: "customer-local-image",
      receiverId: "9001",
      createTime: 1,
      messageType: 1,
      attachment: { imageId: "local-image-1", url: "/api/im/images/local-image-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size },
    } });
  };
  try {
    const state = testContext("customer-local-image");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-local-image" })(state.context);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "proof.jpg", { type: "image/jpeg" });
    await assert.rejects(handle.client.sendImage("customer-local-image|2|9001", file), (error) => error instanceof NimImageSendError && error.kind === "UNKNOWN");
    const reply = await handle.client.retryImage("customer-local-image|2|9001", JSON.parse(requests[0].init.body).image.messageClientId);
    const firstBody = JSON.parse(requests[0].init.body);
    const retryBody = JSON.parse(requests[1].init.body);
    assert.equal(reply.attachment.url, "/api/im/images/local-image-1");
    assert.equal(firstBody.image.messageClientId, retryBody.image.messageClientId);
    assert.equal(firstBody.image.size, 3);
    assert.match(firstBody.image.data, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(requests[0].url, "/api/im/messages");
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local fake image transport rechecks lifecycle after encoding and authorization before POST", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({}); };
  const file = (gate) => ({ name: "proof.png", type: "image/png", size: 3, arrayBuffer: () => gate.promise });
  try {
    const encoded = deferred();
    const firstState = testContext("customer-image-stale");
    const firstHandle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-image-stale" })(firstState.context);
    let authorizations = 0;
    const firstSend = firstHandle.client.sendImage("customer-image-stale|2|9001", file(encoded), { authorize: async () => { authorizations += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    firstState.supersede();
    encoded.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
    await assert.rejects(firstSend, ImLifecycleSupersededError);
    assert.equal(authorizations, 0);
    assert.equal(requests, 0);
    await firstHandle.dispose();

    const authGate = deferred();
    const secondState = testContext("customer-image-auth-stale");
    const secondHandle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-image-auth-stale" })(secondState.context);
    let secondAuthorizeCalled = false;
    const secondSend = secondHandle.client.sendImage("customer-image-auth-stale|2|9001", file({ promise: Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer) }), { authorize: async () => { secondAuthorizeCalled = true; await authGate.promise; } });
    for (let attempt = 0; attempt < 50 && !secondAuthorizeCalled; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondAuthorizeCalled, true);
    secondState.supersede();
    authGate.resolve();
    await assert.rejects(secondSend, ImLifecycleSupersededError);
    assert.equal(requests, 0);
    await secondHandle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disposed NIM client blocks protected SDK calls and keeps counters at zero", async () => {
  let historyCalls = 0;
  let sendCalls = 0;
  const messageService = {
    on() {},
    off() {},
    async getMessageList() { historyCalls += 1; return []; },
    async sendMessage() { sendCalls += 1; return { message: {} }; },
  };
  const { sdk, loginService } = fakeSdk({
    messageService,
    messageCreator: { createTextMessage: (text) => ({ messageClientId: 'text-client-1', text }) },
  });
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("disposed-client").context);
  await handle.dispose();
  await assert.rejects(handle.client.getMessageHistory("disposed-client|2|9001"), /disposed/);
  await assert.rejects(handle.client.sendText("disposed-client|2|9001", "hello"), /disposed/);
  assert.equal(historyCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(loginService.logoutCalls, 1);
});

test("rejects incomplete credentials before loading the SDK", () => {
  let loaded = false;
  const loader = async () => {
    loaded = true;
    throw new Error("must not load");
  };

  assert.throws(
    () => createNimWebClientFactory({ appKey: "test-app-key" }, loader),
    /NIM token must not be blank/,
  );
  assert.throws(
    () => createNimWebClientFactory({ appKey: "test-app-key", token: "a", tokenProvider: async () => "b" }, loader),
    /mutually exclusive/,
  );
  assert.equal(loaded, false);
});

test("local fake transport never accepts a caller-selected sender identity", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return Response.json({ message: {
      messageClientId: "server-message",
      conversationId: "customer-local|2|9001",
      senderId: "server-authorized-account",
      receiverId: "customer-local",
      createTime: 1,
      text: "已发送",
    } });
  };
  try {
    const state = testContext("customer-local");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-local" })(state.context);
    const message = await handle.client.sendText("customer-local|2|9001", "hello", { senderId: "forged-sender" });
    assert.equal(handle.client.accountId, "customer-local");
    assert.equal(message.senderId, "server-authorized-account");
    assert.equal(request.url, "/api/im/messages");
    assert.deepEqual(JSON.parse(request.init.body), { conversationId: "customer-local|2|9001", text: "hello" });
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local fake transport preserves protected HTTP status for the caller", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });
  try {
    const state = testContext("customer-status");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-status" })(state.context);
    await assert.rejects(
      handle.client.sendText("customer-status|2|9002", "hello"),
      (error) => error?.status === 403,
    );
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the SDK text message id for an unknown result and retries the same message", async () => {
  const sent = [];
  let failNext = true;
  const messageService = {
    on() {},
    off() {},
    async sendMessage(message, conversationId) {
      sent.push({ message, conversationId });
      if (failNext) { failNext = false; throw new Error("network lost"); }
      return { message: { ...message, messageServerId: "server-text-1", senderId: "customer-x", receiverId: "team-1", conversationId, createTime: Date.now() } };
    },
  };
  const { sdk } = fakeSdk({ messageService, messageCreator: { createTextMessage: (text) => ({ messageClientId: "text-client-retry", text, messageType: 0 }) } });
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token", messageAuthorization: async () => undefined }, async () => sdk)(testContext("customer-x").context);
  const first = await handle.client.sendText("customer-x|2|9001", "重试我").catch((error) => error);
  assert.ok(first instanceof NimTextSendError, "unknown text result keeps a typed error");
  assert.equal(first.kind, "UNKNOWN");
  assert.equal(first.messageClientId, "text-client-retry");
  const reply = await handle.client.retryText("customer-x|2|9001", "text-client-retry");
  assert.equal(reply.messageServerId, "server-text-1");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].message, sent[1].message, "retry sends the same SDK message object");
  assert.equal(sent[1].message.messageClientId, "text-client-retry");
  await assert.rejects(handle.client.retryText("customer-x|2|9001", "missing-id"), (error) => error instanceof NimTextSendError && error.kind === "FAILED");
  await handle.dispose();
});

function sampleMessage(overrides = {}) {
  return {
    messageClientId: "m1",
    messageServerId: "s1",
    conversationId: "customer-actions|2|9001",
    senderId: "peer-1",
    receiverId: "customer-actions",
    createTime: 1,
    messageType: 0,
    text: "原消息",
    ...overrides,
  };
}

test("local fake message actions post action bodies and preflight authorization", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (body.action === "reply") {
      return Response.json({ message: sampleMessage({ messageClientId: "reply-1", messageServerId: "reply-server", senderId: "customer-actions", text: body.text, reply: { messageId: "s1", senderId: "peer-1", text: "原消息" } }) });
    }
    if (body.action === "revoke") {
      return Response.json({ message: sampleMessage({ text: "", revoked: true }) });
    }
    return Response.json({ deleted: true });
  };
  try {
    const state = testContext("customer-actions");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-actions" })(state.context);
    const operations = [];
    const authorize = async ({ operation }) => { operations.push(operation); };
    const message = sampleMessage();

    const reply = await handle.client.replyText("customer-actions|2|9001", "收到", message, authorize);
    assert.equal(reply.text, "收到");
    assert.deepEqual(requests[0], {
      url: "/api/im/messages",
      body: { action: "reply", conversationId: "customer-actions|2|9001", text: "收到", replyTo: { messageServerId: "s1", messageClientId: "m1" } },
    });

    const revoked = await handle.client.revokeMessage("customer-actions|2|9001", message, authorize);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.text, "");
    assert.deepEqual(requests[1].body, { action: "revoke", conversationId: "customer-actions|2|9001", message: { messageServerId: "s1", messageClientId: "m1" } });

    await handle.client.deleteMessage("customer-actions|2|9001", message, authorize);
    assert.deepEqual(requests[2].body, { action: "delete", conversationId: "customer-actions|2|9001", message: { messageServerId: "s1", messageClientId: "m1" } });
    assert.deepEqual(operations, ["send", "send", "read"]);
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local fake message actions never reach transport when authorization fails", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({});
  };
  try {
    const state = testContext("customer-denied-actions");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-denied-actions" })(state.context);
    const message = sampleMessage({ conversationId: "customer-denied-actions|2|9001", receiverId: "customer-denied-actions" });
    const deny = async () => { throw Object.assign(new Error("denied"), { status: 403 }); };
    await assert.rejects(handle.client.replyText("customer-denied-actions|2|9001", "回复", message, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.revokeMessage("customer-denied-actions|2|9001", message, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.deleteMessage("customer-denied-actions|2|9001", message, deny), (error) => error?.status === 403);
    assert.equal(requests, 0);
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local fake polling pushes known messages whose content was revoked or quoted", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const base = sampleMessage();
  let history = [base];
  globalThis.fetch = async () => Response.json({ messages: history });
  try {
    const state = testContext("customer-actions");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-actions", pollMs: 100 })(state.context);
    await handle.client.getMessageHistory("customer-actions|2|9001", 50);
    const received = [];
    handle.client.onMessages((messages) => received.push(...messages));
    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(predicate(), "expected a live update");
    };

    history = [{ ...base, text: "", revoked: true }];
    await waitFor(() => received.some((message) => message.revoked === true));
    assert.equal(received.find((message) => message.revoked === true)?.text, "");

    const seen = received.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(received.length, seen, "an unchanged polled snapshot is not pushed again");

    history = [{ ...base, text: "改过", reply: { messageId: "s0", senderId: "peer-1", text: "引用" } }];
    await waitFor(() => received.some((message) => message.reply?.messageId === "s0"));
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("real adapter sends a normal text with reply metadata on the server extension, then revokes/deletes behind authorization", async () => {
  const listeners = new Map();
  const calls = { send: [], revoke: [], delete: [] };
  const messageService = {
    on(eventName, listener) { listeners.set(eventName, listener); },
    off(eventName, listener) { if (listeners.get(eventName) === listener) listeners.delete(eventName); },
    async sendMessage(message, conversationId, params) {
      calls.send.push({ message, conversationId, params });
      return { message: { messageClientId: "client-reply", messageServerId: "server-reply", conversationId, senderId: "customer-real", receiverId: "peer-1", createTime: 2, messageType: 0, text: message.text, serverExtension: message.serverExtension } };
    },
    async revokeMessage(message) { calls.revoke.push(message); },
    async deleteMessage(message) { calls.delete.push(message); },
  };
  const { sdk } = fakeSdk({ messageService, messageCreator: { createTextMessage: (text) => ({ messageClientId: "client-reply", text }) } });
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("customer-real").context);
  try {
    const operations = [];
    const authorize = async ({ operation }) => { operations.push(operation); };
    const replyTo = sampleMessage({ conversationId: "customer-real|2|9001", senderId: "peer-1", text: "长".repeat(200) });
    const reply = await handle.client.replyText("customer-real|2|9001", "回复", replyTo, authorize);
    assert.equal(calls.send.length, 1, "reply uses the ordinary text send, not the Thread-only replyMessage API");
    const extension = JSON.parse(calls.send[0].message.serverExtension);
    assert.equal(extension.schema, "zzsh.message-reply");
    assert.equal(extension.messageId, "s1");
    assert.equal(extension.senderId, "peer-1");
    assert.equal(extension.text.length, 120);
    assert.equal(reply.reply.messageId, "s1");
    assert.equal(reply.reply.senderId, "peer-1");
    assert.equal(reply.reply.text.length, 120);

    const message = sampleMessage({ conversationId: "customer-real|2|9001", senderId: "customer-real", attachment: { imageId: "ignored" } });
    const revoked = await handle.client.revokeMessage("customer-real|2|9001", message, authorize);
    assert.deepEqual(calls.revoke, [{...message,conversationType:2}]);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.text, "");
    assert.equal(revoked.attachment, undefined);

    await handle.client.deleteMessage("customer-real|2|9001", message, authorize);
    assert.deepEqual(calls.delete, [{...message,conversationType:2}]);
    assert.deepEqual(operations, ["send", "send", "read"]);

    const deny = async () => { throw Object.assign(new Error("denied"), { status: 403 }); };
    await assert.rejects(handle.client.replyText("customer-real|2|9001", "回复", replyTo, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.revokeMessage("customer-real|2|9001", message, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.deleteMessage("customer-real|2|9001", message, deny), (error) => error?.status === 403);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.revoke.length, 1);
    assert.equal(calls.delete.length, 1);

    messageService.deleteMessage=async()=>{throw {code:107335};};
    await assert.rejects(handle.client.deleteMessage("customer-real|2|9001",message,authorize),error=>error.code==="IM_DELETE_UNAVAILABLE"&&error.status===503&&error.message.includes("消息仍保留"));

    assert.ok(listeners.has("onReceiveMessagesModified"));
    assert.ok(listeners.has("onMessageRevokeNotifications"));
    const received = [];
    handle.client.onMessages((messages) => received.push(...messages));
    listeners.get("onReceiveMessagesModified")([{ messageClientId: "m2", messageServerId: "s2", conversationId: "customer-real|2|9001", senderId: "peer-1", receiverId: "customer-real", createTime: 3, messageType: 0, text: "修改", threadReply: { messageClientId: "m1", messageServerId: "s1", senderId: "peer-1", receiverId: "customer-real", createTime: 1 } }]);
    assert.deepEqual(received[0].reply, { messageId: "s1", senderId: "peer-1" });
    listeners.get("onReceiveMessages")([{ messageClientId: "m3", messageServerId: "s3", conversationId: "customer-real|2|9001", senderId: "peer-1", receiverId: "customer-real", createTime: 4, messageType: 0, text: "带引用", serverExtension: JSON.stringify({ schema: "zzsh.message-reply", version: 1, messageId: "s1", senderId: "peer-1", text: "原消息" }) }]);
    assert.deepEqual(received.at(-1).reply, { messageId: "s1", senderId: "peer-1", text: "原消息" }, "history parses reply metadata from the server extension");
    listeners.get("onMessageRevokeNotifications")([{ messageRefer: { messageClientId: "m1", messageServerId: "s1", conversationId: "customer-real|2|9001", senderId: "customer-real", receiverId: "peer-1", createTime: 1 }, revokeAccountId: "customer-real" }]);
    assert.equal(received[2].revoked, true);
    assert.equal(received[2].text, "");
    assert.equal(received[2].messageServerId, "s1");
    await handle.dispose();
    assert.equal(listeners.size, 0);
  } finally {
    await handle.dispose();
  }
});

test("message state clears revoked content and never resurrects it from stale history", () => {
  const [revoked] = mergeImMessages(
    [{ id: "s1", createTime: 1, text: "hello", attachment: { imageId: "img-1" }, reply: { messageId: "s0", senderId: "peer" } }],
    [{ id: "s1", createTime: 1, revoked: true }],
  );
  assert.equal(revoked.text, "");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.attachment, undefined);
  assert.equal(revoked.reply, undefined);

  const [stale] = mergeImMessages([revoked], [{ id: "s1", createTime: 1, text: "stale page" }]);
  assert.equal(stale.revoked, true);
  assert.equal(stale.text, "");

  const [media] = mergeImMessages(
    [{ id: "m2", createTime: 2, media: { mediaId: "media-1", kind: "video", name: "clip.mp4", mimeType: "video/mp4", size: 3 } }],
    [{ id: "m2", createTime: 2, media: { url: "/api/im/media/media-1" } }],
  );
  assert.equal(media.media.url, "/api/im/media/media-1");
  assert.equal(media.media.kind, "video");
  const [mediaRevoked] = mergeImMessages([media], [{ id: "m2", createTime: 2, revoked: true }]);
  assert.equal(mediaRevoked.media, undefined);
});

test("media metadata mapping keeps only bounded safe fields", () => {
  const safe = {
    mediaId: "fixture-media-1",
    kind: "video",
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: 3,
    width: 640,
    height: 360,
    durationMs: 1_500,
    url: "/api/im/media/fixture-media-1",
    extra: "discarded",
  };
  assert.deepEqual(parseNimMessageMedia(safe), {
    mediaId: "fixture-media-1",
    kind: "video",
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: 3,
    width: 640,
    height: 360,
    durationMs: 1_500,
    url: "/api/im/media/fixture-media-1",
  });
  const remote = "https://nos.example/uploads/fixture-media-1";
  assert.equal(parseNimMessageMedia({ ...safe, url: remote }).url, remote);
  for (const url of [
    "javascript:alert(1)",
    "data:text/plain,hi",
    "http://nos.example/uploads/fixture-media-1",
    "/media/fixture-media-1",
    "//nos.example/uploads/fixture-media-1",
    "https://user:pass@nos.example/uploads/fixture-media-1",
    "https://nos.example/uploads/fixture media-1",
    `https://nos.example/${"a".repeat(2048)}`,
  ]) {
    assert.equal(parseNimMessageMedia({ ...safe, url }).url, undefined, url);
  }
  assert.equal(parseNimMessageMedia({ ...safe, kind: "image" }), undefined);
  assert.equal(parseNimMessageMedia({ ...safe, mimeType: "application/x-msdownload" }), undefined);
  assert.equal(parseNimMessageMedia({ ...safe, size: 100 * 1024 * 1024 + 1 }), undefined);
  assert.equal(parseNimMessageMedia({ ...safe, height: undefined }), undefined);
  assert.equal(parseNimMessageMedia({ ...safe, name: "clip\u0000.mp4" }), undefined);
  assert.equal(validateNimMediaFile(new File([new Uint8Array([1])], "voice.mp3", { type: "audio/mpeg" }), "audio"), "audio/mpeg");
  assert.throws(() => validateNimMediaFile(new File([new Uint8Array([1])], "run.exe", { type: "application/x-msdownload" }), "file"), /不支持该媒体格式/);
});

test("local fake media transport posts bounded base64, maps safe metadata and retries the same client ID", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let first = true;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (first) {
      first = false;
      throw new Error("local transport interrupted");
    }
    const body = JSON.parse(init.body);
    return Response.json({ message: {
      messageClientId: body.media.messageClientId,
      messageServerId: "fixture-server-media-1",
      conversationId: body.conversationId,
      senderId: "customer-local-media",
      receiverId: "9001",
      createTime: 1,
      messageType: 3,
      media: {
        mediaId: "fixture-media-abc",
        kind: body.media.kind,
        name: body.media.name,
        mimeType: body.media.mimeType,
        size: body.media.size,
        width: body.media.width,
        height: body.media.height,
        durationMs: body.media.durationMs,
        url: "/api/im/media/fixture-media-abc",
        unsafeExtra: true,
      },
    } });
  };
  try {
    const state = testContext("customer-local-media");
    const handle = await createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: "customer-local-media" })(state.context);
    const file = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
    await assert.rejects(
      handle.client.sendMedia("customer-local-media|2|9001", file, "video", { width: 640, height: 360, durationMs: 1_500 }),
      (error) => error instanceof NimMediaSendError && error.kind === "UNKNOWN" && Boolean(error.messageClientId),
    );
    const firstBody = JSON.parse(requests[0].init.body);
    const clientId = firstBody.media.messageClientId;
    assert.equal(firstBody.media.kind, "video");
    assert.equal(firstBody.media.size, 3);
    assert.equal(firstBody.media.width, 640);
    assert.equal(firstBody.media.durationMs, 1_500);
    assert.match(firstBody.media.data, /^[A-Za-z0-9+/]+=*$/);
    const reply = await handle.client.retryMedia("customer-local-media|2|9001", clientId);
    const retryBody = JSON.parse(requests[1].init.body);
    assert.equal(retryBody.media.messageClientId, clientId);
    assert.equal(reply.media.mediaId, "fixture-media-abc");
    assert.equal(reply.media.url, "/api/im/media/fixture-media-abc");
    assert.equal(reply.media.unsafeExtra, undefined);
    assert.equal(requests[0].url, "/api/im/messages");
    await handle.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real media adapter calls the V2 creators, reports progress, and retries the same message after an unknown result", async () => {
  const sent = [];
  const created = [];
  const messageService = {
    on() {},
    off() {},
    async sendMessage(message, conversationId, params, progress) {
      sent.push({ message, conversationId, params });
      progress?.(37);
      return { message: { ...message, conversationId, senderId: "customer-media-real", receiverId: "9001", createTime: 2, attachment: { ...message.attachment, url: `https://nos.example/uploads/${message.messageClientId}` } } };
    },
  };
  const messageCreator = {
    createTextMessage: (text) => ({ messageClientId: "text-media", text, messageType: 0 }),
    createVideoMessage(file, name, sceneName, duration, width, height) {
      const message = { messageClientId: "video-client-1", messageType: 3, attachment: { name, size: file.size, ext: "mp4", file } };
      created.push({ kind: "video", file, name, sceneName, duration, width, height, message });
      return message;
    },
    createAudioMessage(file, name, sceneName, duration) {
      const message = { messageClientId: "audio-client-2", messageType: 2, attachment: { name, size: file.size, ext: "aac", file } };
      created.push({ kind: "audio", file, name, sceneName, duration, message });
      return message;
    },
    createFileMessage(file, name, sceneName) {
      const message = { messageClientId: "file-client-3", messageType: 6, attachment: { name, size: file.size, ext: "pdf", file } };
      created.push({ kind: "file", file, name, sceneName, message });
      return message;
    },
  };
  const { sdk } = fakeSdk({ messageService, messageCreator, storageService: {} });
  const authorizations = [];
  const progress = [];
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("customer-media-real").context);
  const conversationId = "customer-media-real|2|9001";
  const grant = { appId: "test-app", orderId: "order-media", teamId: "9001", conversationId, routeEnvironment: "oim4d-test" };
  const params = { routeConfig: { routeEnabled: true, routeEnvironment: "oim4d-test" } };
  const authorize = async (input) => { authorizations.push(input); return grant; };
  const video = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
  const beforeValidation = created.length;
  await assert.rejects(handle.client.sendMedia(conversationId, new File([new Uint8Array([1])], "run.exe", { type: "application/x-msdownload" }), "file"), /不支持该媒体格式/);
  await assert.rejects(handle.client.sendMedia(conversationId, video, "video", { width: 640 }), /视频宽高必须同时提供/);
  await assert.rejects(handle.client.sendMedia(conversationId, video, "file"), /不支持该媒体格式/);
  assert.equal(created.length, beforeValidation, "invalid media never reaches the SDK creators");

  let failVideo = true;
  messageService.sendMessage = async (message, id, sendParams, onProgress) => {
    sent.push({ message, conversationId: id, params: sendParams });
    onProgress?.(37);
    if (message.messageType === 3 && failVideo) {
      failVideo = false;
      throw new Error("connection lost after upload");
    }
    return { message: { ...message, conversationId: id, senderId: "customer-media-real", receiverId: "9001", createTime: 2, attachment: { ...message.attachment, url: `https://nos.example/uploads/${message.messageClientId}` } } };
  };
  await assert.rejects(
    handle.client.sendMedia(conversationId, video, "video", { authorize, width: 640, height: 360, durationMs: 1_500, onProgress: (value) => progress.push(value) }),
    (error) => error instanceof NimMediaSendError && error.kind === "UNKNOWN" && error.messageClientId === "video-client-1",
  );
  assert.equal(created[0].kind, "video");
  assert.equal(created[0].file, video);
  assert.equal(created[0].name, "clip.mp4");
  assert.equal(created[0].sceneName, undefined);
  assert.equal(created[0].duration, 1_500, "creator duration stays in milliseconds");
  assert.equal(created[0].width, 640);
  assert.equal(created[0].height, 360);

  const reply = await handle.client.retryMedia(conversationId, "video-client-1", { authorize, onProgress: (value) => progress.push(value) });
  assert.equal(reply.messageType, 3);
  assert.equal(sent[0].message, sent[1].message, "retry sends the same SDK message object");
  assert.deepEqual(sent.map((call) => call.params), [params, params]);
  assert.deepEqual(reply.media, {
    mediaId: "nim-video-client-1",
    kind: "video",
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: 3,
    width: 640,
    height: 360,
    durationMs: 1_500,
    url: "https://nos.example/uploads/video-client-1",
  });
  assert.deepEqual(reply.attachment, { name: "clip.mp4", size: 3, mimeType: "video/mp4", url: "https://nos.example/uploads/video-client-1" });
  assert.deepEqual(progress, [0, 37, 0, 37, 100]);

  const audio = new File([new Uint8Array([4, 5])], "voice.aac", { type: "audio/aac" });
  const audioReply = await handle.client.sendMedia(conversationId, audio, "audio", { authorize, durationMs: 4_200 });
  assert.equal(created[1].kind, "audio");
  assert.equal(created[1].file, audio);
  assert.equal(created[1].duration, 4_200);
  assert.equal(created[1].width, undefined);
  assert.equal(audioReply.messageType, 2);
  assert.deepEqual(audioReply.media, {
    mediaId: "nim-audio-client-2",
    kind: "audio",
    name: "voice.aac",
    mimeType: "audio/aac",
    size: 2,
    durationMs: 4_200,
    url: "https://nos.example/uploads/audio-client-2",
  });

  const file = new File([new Uint8Array([6])], "report.pdf", { type: "application/pdf" });
  const fileReply = await handle.client.sendMedia(conversationId, file, "file", { authorize });
  assert.equal(created[2].kind, "file");
  assert.equal(created[2].file, file);
  assert.equal(created[2].sceneName, undefined);
  assert.equal(created[2].duration, undefined);
  assert.equal(fileReply.messageType, 6);
  assert.deepEqual(fileReply.media, {
    mediaId: "nim-file-client-3",
    kind: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: 1,
    url: "https://nos.example/uploads/file-client-3",
  });
  assert.deepEqual(authorizations, [
    {conversationId,operation:"send",messageClientId:"video-client-1",messageType:3},
    {conversationId,operation:"send",messageClientId:"video-client-1",messageType:3},
    {conversationId,operation:"send",messageClientId:"audio-client-2",messageType:2},
    {conversationId,operation:"send",messageClientId:"file-client-3",messageType:6},
  ]);
  await assert.rejects(handle.client.retryMedia(conversationId, "missing-media"), (error) => error instanceof NimMediaSendError && error.kind === "FAILED");
  await handle.dispose();
});

test("real NIM audio/video/file messages map into the safe media envelope and unsafe attachments are dropped", async () => {
  const listeners = new Map();
  const historyMessages = [];
  const messageService = {
    on(eventName, listener) { listeners.set(eventName, listener); },
    off(eventName, listener) { if (listeners.get(eventName) === listener) listeners.delete(eventName); },
    async getMessageList() { return historyMessages; },
  };
  const { sdk } = fakeSdk({ messageService, messageCreator: { createTextMessage: (text) => ({ messageClientId: "text-incoming", text }) } });
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("customer-incoming-media").context);
  const received = [];
  handle.client.onMessages((messages) => received.push(...messages));
  const base = { conversationId: "customer-incoming-media|2|9001", senderId: "agent-1", receiverId: "customer-incoming-media", createTime: 5 };
  const videoUrl = "https://nos.example/uploads/in-video";
  const audioUrl = "https://nos.example/uploads/in-audio";
  const fileUrl = "https://nos.example/uploads/in-file";
  const video = { ...base, messageClientId: "in-video", messageType: 3, attachment: { name: "clip.MP4", size: 3, ext: "mp4", url: videoUrl, width: 640, height: 360, duration: 1500, md5: "0123456789abcdef0123456789abcdef" } };
  const messages = [
    video,
    { ...base, messageClientId: "in-audio", messageType: 2, attachment: { name: "voice.aac", size: 2, ext: "aac", url: audioUrl, duration: 3000 } },
    { ...base, messageClientId: "in-file", messageType: 6, attachment: { name: "report.PDF", size: 10, ext: "pdf", url: fileUrl } },
    { ...base, messageClientId: "in-image", messageType: 1, attachment: { imageId: "img-1", url: "https://nos.example/uploads/image" } },
    { ...base, messageClientId: "bad-http", messageType: 3, attachment: { name: "clip.mp4", size: 3, ext: "mp4", url: "http://nos.example/x", width: 1, height: 1, duration: 1 } },
    { ...base, messageClientId: "bad-js", messageType: 6, attachment: { name: "x.pdf", size: 3, ext: "pdf", url: "javascript:alert(1)" } },
    { ...base, messageClientId: "bad-data", messageType: 6, attachment: { name: "x.pdf", size: 3, ext: "pdf", url: "data:text/plain,hi" } },
    { ...base, messageClientId: "bad-relative", messageType: 6, attachment: { name: "x.pdf", size: 3, ext: "pdf", url: "/media/x" } },
    { ...base, messageClientId: "bad-name", messageType: 6, attachment: { name: `${"a".repeat(256)}.pdf`, size: 3, ext: "pdf", url: fileUrl } },
    { ...base, messageClientId: "bad-size", messageType: 6, attachment: { name: "x.pdf", size: 50 * 1024 * 1024 + 1, ext: "pdf", url: fileUrl } },
    { ...base, messageClientId: "bad-dim", messageType: 3, attachment: { name: "clip.mp4", size: 3, ext: "mp4", url: videoUrl, width: 9_000, height: 360, duration: 1 } },
    { ...base, messageClientId: "bad-partial-dim", messageType: 3, attachment: { name: "clip.mp4", size: 3, ext: "mp4", url: videoUrl, width: 640, duration: 1 } },
    { ...base, messageClientId: "bad-duration", messageType: 2, attachment: { name: "voice.aac", size: 2, ext: "aac", url: audioUrl, duration: 86_400_001 } },
    { ...base, messageClientId: "bad-ext", messageType: 6, attachment: { name: "run.exe", size: 3, ext: "exe", url: fileUrl } },
  ];
  listeners.get("onReceiveMessages")(messages);
  const byId = Object.fromEntries(received.map((message) => [message.messageClientId, message]));
  assert.deepEqual(byId["in-video"].media, {
    mediaId: "nim-0123456789abcdef0123456789abcdef",
    kind: "video",
    name: "clip.MP4",
    mimeType: "video/mp4",
    size: 3,
    width: 640,
    height: 360,
    durationMs: 1_500,
    url: videoUrl,
  });
  assert.deepEqual(byId["in-video"].attachment, { name: "clip.MP4", size: 3, mimeType: "video/mp4", url: videoUrl });
  assert.deepEqual(byId["in-audio"].media, {
    mediaId: "nim-in-audio",
    kind: "audio",
    name: "voice.aac",
    mimeType: "audio/aac",
    size: 2,
    durationMs: 3_000,
    url: audioUrl,
  });
  assert.deepEqual(byId["in-file"].media, {
    mediaId: "nim-in-file",
    kind: "file",
    name: "report.PDF",
    mimeType: "application/pdf",
    size: 10,
    url: fileUrl,
  });
  assert.equal(byId["in-file"].attachment.duration, undefined);
  assert.equal(byId["in-image"].media, undefined);
  assert.equal(byId["in-image"].attachment.imageId, "img-1", "image messages keep their existing attachment path");
  for (const id of ["bad-http", "bad-js", "bad-data", "bad-relative", "bad-name", "bad-size", "bad-dim", "bad-partial-dim", "bad-duration", "bad-ext"]) {
    assert.equal(byId[id].media, undefined, `${id} must not expose a media envelope`);
    assert.equal(byId[id].attachment, undefined, `${id} must not leak a raw attachment`);
  }

  historyMessages.push(video);
  const history = await handle.client.getMessageHistory(base.conversationId, 20, undefined, async () => undefined);
  assert.deepEqual(history[0].media, byId["in-video"].media, "history uses the same mapping as live delivery");
  await handle.dispose();
  assert.equal(listeners.size, 0);
});
