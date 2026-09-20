import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createLocalFakeNimWebClientFactory,
  createNimWebClientFactory,
  NimImageSendError,
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
  const {sdk}=fakeSdk({messageService:{on(){},off(){},async getMessageList(options){reads++;seen=options;return [];},async sendMessage(){sends++;return {message:anchor};}},messageCreator:{createTextMessage:text=>({text})}});
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
    messageCreator: { createTextMessage: (text) => ({ text, messageType: 0 }) },
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
  assert.deepEqual(sent, [{ message: { text: "收到", messageType: 0 }, conversationId: "customer-4|1|agent-1" }]);
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
    messageCreator: { createTextMessage: (text) => ({ text }) },
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
      createTextMessage: (text) => ({ text }),
    },
  });
  const authorizations = [];
  const progress = [];
  const handle = await createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk)(testContext("customer-image").context);
  const file = new File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });
  const authorize = async (input) => authorizations.push(input);
  await assert.rejects(handle.client.sendImage("customer-image|2|9001", file, { authorize, width: 12, height: 8, onProgress: (value) => progress.push(value) }), (error) => error instanceof NimImageSendError && error.kind === "UNKNOWN" && error.messageClientId === "image-client-1");
  const reply = await handle.client.retryImage("customer-image|2|9001", "image-client-1", { authorize, onProgress: (value) => progress.push(value) });
  assert.equal(reply.messageClientId, "image-client-1");
  assert.equal(sent[0].message, sent[1].message);
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
    messageCreator: { createTextMessage: (text) => ({ text }) },
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
