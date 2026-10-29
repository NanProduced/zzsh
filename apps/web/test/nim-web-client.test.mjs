import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createLocalFakeNimWebClientFactory,
  createNimWebClientFactory,
  mergeImMessages,
  NimImageSendError,
  NimTextSendError,
  resolveNimSdkModule,
} from "../src/lib/nim-web-client.ts";
import { ImLifecycleSupersededError } from "../src/lib/im-client-lifecycle.ts";

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

function fakeSdk({ loginService = new FakeLoginService(), loginError, messageService, messageCreator, conversationUtil, storageService } = {}) {
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
        async destroy() {
          calls.destroyed += 1;
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
    assert.deepEqual(seen,{conversationId:anchor.conversationId,limit:50,anchorMessage:anchor});
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
  const unsubscribe = handle.client.onConnectionStateChange((state) => states.push(state));
  loginService.connectStatus = 3;
  loginService.emit("onConnectStatus", 3);
  loginService.emit("onKickedOffline");
  loginService.emit("onLoginFailed");
  loginService.emit("onDisconnected");
  assert.deepEqual(states, ["RECONNECTING", "KICKED", "AUTH_FAILED", "DISCONNECTED"]);
  unsubscribe();

  await handle.dispose();
  assert.equal(loginService.logoutCalls, 1);
  assert.equal(calls.destroyed, 1);
  loginService.emit("onConnectStatus", 1);
  assert.deepEqual(states, ["RECONNECTING", "KICKED", "AUTH_FAILED", "DISCONNECTED"]);
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

test("routes authorized P2P messages through the SDK and removes the receive listener", async () => {
  const messageListeners = new Map();
  const sent = [];
  const authorizations = [];
  const history = [{ messageClientId: "history-1", conversationId: "customer-4|1|agent-1", senderId: "agent-1", receiverId: "customer-4", createTime: 1, messageType: 0, text: "历史消息" }];
  const messageService = {
    on(eventName, listener) { messageListeners.set(eventName, listener); },
    off(eventName, listener) { if (messageListeners.get(eventName) === listener) messageListeners.delete(eventName); },
    async getMessageList(options) { assert.deepEqual(options, { conversationId: "customer-4|1|agent-1", limit: 20 }); return history; },
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
    { conversationId: "customer-4|1|agent-1", operation: "send" },
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
    { conversationId: "customer-image|2|9001", operation: "send" },
    { conversationId: "customer-image|2|9001", operation: "send" },
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

test("real adapter calls replyMessage/revokeMessage/deleteMessage behind authorization and merges modified events", async () => {
  const listeners = new Map();
  const calls = { reply: [], revoke: [], delete: [] };
  const messageService = {
    on(eventName, listener) { listeners.set(eventName, listener); },
    off(eventName, listener) { if (listeners.get(eventName) === listener) listeners.delete(eventName); },
    async replyMessage(...args) {
      calls.reply.push(args);
      const replyTo = args[1];
      return { message: { messageClientId: "client-reply", messageServerId: "server-reply", conversationId: replyTo.conversationId, senderId: "customer-real", receiverId: "peer-1", createTime: 2, messageType: 0, text: "回复" } };
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
    assert.equal(calls.reply.length, 1);
    assert.equal(calls.reply[0][1], replyTo);
    assert.equal(calls.reply[0].length, 2);
    assert.equal(reply.reply.messageId, "s1");
    assert.equal(reply.reply.senderId, "peer-1");
    assert.equal(reply.reply.text.length, 120);

    const message = sampleMessage({ conversationId: "customer-real|2|9001", senderId: "customer-real", attachment: { imageId: "ignored" } });
    const revoked = await handle.client.revokeMessage("customer-real|2|9001", message, authorize);
    assert.deepEqual(calls.revoke, [message]);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.text, "");
    assert.equal(revoked.attachment, undefined);

    await handle.client.deleteMessage("customer-real|2|9001", message, authorize);
    assert.deepEqual(calls.delete, [message]);
    assert.deepEqual(operations, ["send", "send", "read"]);

    const deny = async () => { throw Object.assign(new Error("denied"), { status: 403 }); };
    await assert.rejects(handle.client.replyText("customer-real|2|9001", "回复", replyTo, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.revokeMessage("customer-real|2|9001", message, deny), (error) => error?.status === 403);
    await assert.rejects(handle.client.deleteMessage("customer-real|2|9001", message, deny), (error) => error?.status === 403);
    assert.equal(calls.reply.length, 1);
    assert.equal(calls.revoke.length, 1);
    assert.equal(calls.delete.length, 1);

    assert.ok(listeners.has("onReceiveMessagesModified"));
    assert.ok(listeners.has("onMessageRevokeNotifications"));
    const received = [];
    handle.client.onMessages((messages) => received.push(...messages));
    listeners.get("onReceiveMessagesModified")([{ messageClientId: "m2", messageServerId: "s2", conversationId: "customer-real|2|9001", senderId: "peer-1", receiverId: "customer-real", createTime: 3, messageType: 0, text: "修改", threadReply: { messageClientId: "m1", messageServerId: "s1", senderId: "peer-1", receiverId: "customer-real", createTime: 1 } }]);
    assert.deepEqual(received[0].reply, { messageId: "s1", senderId: "peer-1" });
    listeners.get("onMessageRevokeNotifications")([{ messageRefer: { messageClientId: "m1", messageServerId: "s1", conversationId: "customer-real|2|9001", senderId: "customer-real", receiverId: "peer-1", createTime: 1 }, revokeAccountId: "customer-real" }]);
    assert.equal(received[1].revoked, true);
    assert.equal(received[1].text, "");
    assert.equal(received[1].messageServerId, "s1");
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
});
