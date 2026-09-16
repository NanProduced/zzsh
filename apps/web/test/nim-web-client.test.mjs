import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createLocalFakeNimWebClientFactory,
  createNimWebClientFactory,
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

function fakeSdk({ loginService = new FakeLoginService(), loginError, messageService, messageCreator, conversationUtil } = {}) {
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
  const factory = createNimWebClientFactory({ appKey: "test-app-key", token: "test-token" }, async () => sdk);
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
  unsubscribe();
  await handle.dispose();
  assert.equal(messageListeners.size, 0);
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
