import {
  ImLifecycleSupersededError,
  type ImClientContext,
  type ImClientFactory,
  type ImClientHandle,
} from "./im-client-lifecycle.ts";

export type NimWebConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "KICKED" | "AUTH_FAILED";
type NimListener = (...args: unknown[]) => void;

export type NimMessageLike = {
  messageClientId: string;
  messageServerId?: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  createTime: number;
  text?: string;
  messageType?: number;
  attachment?: { raw?: string; url?: string; name?: string; [key: string]: unknown };
  sendingState?: number;
};

export type NimWebClientLike = {
  readonly accountId: string;
  getConnectionState(): NimWebConnectionState;
  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void;
  onMessages(listener: (messages: NimMessageLike[]) => void): () => void;
  getMessageHistory(conversationId: string, limit?: number): Promise<NimMessageLike[]>;
  sendText(conversationId: string, text: string): Promise<NimMessageLike>;
};

type NimMessageServiceLike = {
  on: (eventName: string, listener: NimListener) => void;
  off: (eventName: string, listener: NimListener) => void;
  sendMessage: (message: unknown, conversationId: string) => Promise<{ message?: NimMessageLike }>;
  getMessageList?: (options: Record<string, unknown>) => Promise<NimMessageLike[]>;
};
type NimMessageCreatorLike = { createTextMessage: (text: string) => unknown };
type NimConversationIdUtilLike = {
  p2pConversationId: (accountId: string) => string;
  teamConversationId?: (teamId: string) => string;
};
type NimLoginServiceLike = {
  on: (eventName: string, listener: NimListener) => void;
  off: (eventName: string, listener: NimListener) => void;
  login: (accountId: string, token: string, options?: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
};

export type NimInstanceLike = {
  V2NIMLoginService: NimLoginServiceLike;
  V2NIMMessageService?: NimMessageServiceLike;
  V2NIMMessageCreator?: NimMessageCreatorLike;
  V2NIMConversationIdUtil?: NimConversationIdUtilLike;
  destroy: () => Promise<void>;
};
export type NimSdkLike = { getInstance: (options: { appkey: string; apiVersion: "v2"; debugLevel: "off" | "error" | "warn" | "log" | "debug"; enableV2CloudConversation: false }, otherOptions?: Record<string, unknown>) => NimInstanceLike };
export type NimTokenProvider = (accountId: string) => Promise<string>;
export type NimWebClientOptions = {
  appKey: string;
  accountId?: string;
  token?: string;
  tokenProvider?: NimTokenProvider;
  debugLevel?: "off" | "error" | "warn" | "log" | "debug";
  retryCount?: number;
  timeout?: number;
  forceMode?: boolean;
  lbsUrls?: readonly string[];
  linkUrl?: string;
};
export type NimSdkLoader = () => Promise<NimSdkLike>;

const DEFAULT_DEBUG_LEVEL = "off" as const;
function requireNonBlank(value: string, name: string): string { if (typeof value !== "string") throw new TypeError(`${name} must be a string`); const normalized = value.trim(); if (!normalized) throw new TypeError(`${name} must not be blank`); return normalized; }
function validateOptions(options: NimWebClientOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("NIM options are required");
  if (requireNonBlank(options.appKey, "NIM app key").length > 128) throw new TypeError("NIM app key must be at most 128 characters");
  if (options.accountId !== undefined && requireNonBlank(options.accountId, "NIM account ID").length > 128) throw new TypeError("NIM account ID must be at most 128 characters");
  if (options.tokenProvider && options.token !== undefined) throw new TypeError("NIM token and tokenProvider are mutually exclusive");
  if (options.tokenProvider !== undefined && typeof options.tokenProvider !== "function") throw new TypeError("NIM tokenProvider must be a function");
  if (!options.tokenProvider) requireNonBlank(options.token ?? "", "NIM token");
  if (options.retryCount !== undefined && (!Number.isInteger(options.retryCount) || options.retryCount < 1)) throw new TypeError("NIM retryCount must be a positive integer");
  if (options.timeout !== undefined && (!Number.isInteger(options.timeout) || options.timeout < 1)) throw new TypeError("NIM timeout must be a positive integer");
  for (const url of options.lbsUrls ?? []) { const parsed = new URL(url); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("NIM lbsUrls must contain valid http(s) URLs"); }
  if (options.linkUrl) { const parsed = new URL(options.linkUrl); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("NIM linkUrl must be a valid http(s) URL"); }
}
function mapConnectStatus(status: unknown): NimWebConnectionState | undefined { return status === 0 ? "DISCONNECTED" : status === 1 ? "CONNECTED" : status === 2 ? "CONNECTING" : status === 3 ? "RECONNECTING" : undefined; }
async function loadNimSdk(): Promise<NimSdkLike> {
  if (typeof window === "undefined") throw new Error("NIM Web SDK can only load in a browser");
  const module = (await import("nim-web-sdk-ng")) as unknown as { default?: NimSdkLike };
  const sdk = resolveNimSdkModule(module);
  if (!sdk) throw new Error("NIM Web SDK is unavailable");
  return sdk;
}

export function resolveNimSdkModule(module: { default?: unknown }): NimSdkLike | undefined {
  const hasGetInstance = (value: unknown): value is NimSdkLike => Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { getInstance?: unknown }).getInstance === "function");
  const candidate = module.default;
  if (hasGetInstance(candidate)) return candidate;
  const nested = candidate && typeof candidate === "object" ? (candidate as { default?: unknown }).default : undefined;
  return hasGetInstance(nested) ? nested : undefined;
}

export class NimWebClient implements NimWebClientLike {
  readonly accountId: string;
  readonly nim: NimInstanceLike;
  private readonly context: ImClientContext;
  private readonly messageService?: NimMessageServiceLike;
  private readonly messageEventHandler?: NimListener;
  private state: NimWebConnectionState = "DISCONNECTED";
  private loggedIn = false;
  private disposed = false;
  private readonly listeners = new Set<(state: NimWebConnectionState) => void>();
  private readonly messageListeners = new Set<(messages: NimMessageLike[]) => void>();
  private readonly eventHandlers: Array<[string, NimListener]> = [];

  constructor(context: ImClientContext, nim: NimInstanceLike, accountId: string) {
    this.context = context; this.nim = nim; this.accountId = accountId;
    const loginService = nim.V2NIMLoginService; this.messageService = nim.V2NIMMessageService;
    const bind = (eventName: string, handler: (...args: unknown[]) => void) => { const guarded = context.onCurrent(handler); loginService.on(eventName, guarded); this.eventHandlers.push([eventName, guarded]); };
    bind("onConnectStatus", (status) => { const next = mapConnectStatus(status); if (next) this.setState(next); });
    bind("onLoginStatus", (status) => { if (status === 2) this.setState("CONNECTING"); if (status === 0 && this.state !== "KICKED" && this.state !== "AUTH_FAILED") this.setState("DISCONNECTED"); });
    bind("onLoginFailed", () => this.setState("AUTH_FAILED")); bind("onKickedOffline", () => this.setState("KICKED")); bind("onDisconnected", () => this.setState("DISCONNECTED")); bind("onConnectFailed", () => this.setState("RECONNECTING"));
    if (this.messageService) { const handler = context.onCurrent((messages: unknown) => { if (!Array.isArray(messages)) return; const safe = messages.filter((message): message is NimMessageLike => Boolean(message && typeof message === "object")); if (safe.length) for (const listener of this.messageListeners) listener(safe); }); this.messageEventHandler = handler; this.messageService.on("onReceiveMessages", handler); }
  }
  getConnectionState(): NimWebConnectionState { return this.state; }
  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onMessages(listener: (messages: NimMessageLike[]) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  conversationIdForPeer(peerAccountId: string): string { const peer = requireNonBlank(peerAccountId, "NIM peer account ID"); if (!this.nim.V2NIMConversationIdUtil) throw new Error("NIM conversation utility is unavailable"); return this.nim.V2NIMConversationIdUtil.p2pConversationId(peer); }
  conversationIdForTeam(teamId: string): string { const id = requireNonBlank(teamId, "NIM team ID"); if (!this.nim.V2NIMConversationIdUtil?.teamConversationId) throw new Error("NIM team conversation utility is unavailable"); return this.nim.V2NIMConversationIdUtil.teamConversationId(id); }
  async getMessageHistory(conversationId: string, limit = 50): Promise<NimMessageLike[]> { this.assertCurrent(); const id = requireNonBlank(conversationId, "NIM conversation ID"); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("NIM history limit must be between 1 and 100"); if (!this.messageService?.getMessageList) throw new Error("NIM message history is unavailable"); const messages = await this.messageService.getMessageList({ conversationId: id, limit }); this.assertCurrent(); return Array.isArray(messages) ? messages : []; }
  async sendText(conversationId: string, text: string): Promise<NimMessageLike> { this.assertCurrent(); const id = requireNonBlank(conversationId, "NIM conversation ID"); const body = requireNonBlank(text, "NIM message text"); if (body.length > 4_000) throw new TypeError("NIM message text must be at most 4000 characters"); if (!this.messageService || !this.nim.V2NIMMessageCreator) throw new Error("NIM message sending is unavailable"); const result = await this.messageService.sendMessage(this.nim.V2NIMMessageCreator.createTextMessage(body), id); this.assertCurrent(); if (!result?.message || typeof result.message !== "object") throw new Error("NIM message response is invalid"); return result.message; }
  async login(options: NimWebClientOptions): Promise<void> { this.assertCurrent(); const loginOptions: Record<string, unknown> = { authType: options.tokenProvider ? 1 : 0, forceMode: options.forceMode ?? false }; if (options.retryCount !== undefined) loginOptions.retryCount = options.retryCount; if (options.timeout !== undefined) loginOptions.timeout = options.timeout; if (options.tokenProvider) loginOptions.tokenProvider = async () => { this.assertCurrent(); const token = await options.tokenProvider?.(this.accountId); this.assertCurrent(); return requireNonBlank(token ?? "", "NIM token provider result"); }; this.setState("CONNECTING"); await this.nim.V2NIMLoginService.login(this.accountId, options.token ?? "", loginOptions); this.assertCurrent(); this.loggedIn = true; this.setState(mapConnectStatus(this.getSdkConnectStatus()) ?? "CONNECTED"); }
  async logout(): Promise<void> { if (!this.loggedIn || this.disposed) return; await this.nim.V2NIMLoginService.logout(); this.loggedIn = false; this.setState("DISCONNECTED"); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const [eventName, handler] of this.eventHandlers) { try { this.nim.V2NIMLoginService.off(eventName, handler); } catch { /* cleanup continues */ } } this.eventHandlers.length = 0; if (this.messageService && this.messageEventHandler) { try { this.messageService.off("onReceiveMessages", this.messageEventHandler); } catch { /* cleanup continues */ } } this.messageListeners.clear(); if (this.loggedIn) { try { await this.nim.V2NIMLoginService.logout(); } catch { /* destroy still runs */ } this.loggedIn = false; } try { await this.nim.destroy(); } finally { this.listeners.clear(); } }
  private assertCurrent(): void { if (this.disposed) throw new Error("NIM client is disposed"); if (!this.context.isCurrent()) throw new ImLifecycleSupersededError(); }
  private getSdkConnectStatus(): unknown { return (this.nim.V2NIMLoginService as NimLoginServiceLike & { getConnectStatus?: () => unknown }).getConnectStatus?.(); }
  private setState(next: NimWebConnectionState): void { if (this.disposed || this.state === next) return; this.state = next; for (const listener of this.listeners) listener(next); }
}

export function createNimWebClientFactory(options: NimWebClientOptions, sdkLoader: NimSdkLoader = loadNimSdk): ImClientFactory<NimWebClient> {
  validateOptions(options);
  return async (context): Promise<ImClientHandle<NimWebClient>> => {
    const sdk = await sdkLoader();
    const loginConfig: Record<string, unknown> = {};
    if (options.lbsUrls?.length || options.linkUrl) loginConfig.V2NIMLoginServiceConfig = { ...(options.lbsUrls?.length ? { lbsUrls: [...options.lbsUrls] } : {}), ...(options.linkUrl ? { linkUrl: options.linkUrl } : {}) };
    const nim = sdk.getInstance({ appkey: requireNonBlank(options.appKey, "NIM app key"), apiVersion: "v2", debugLevel: options.debugLevel ?? DEFAULT_DEBUG_LEVEL, enableV2CloudConversation: false }, Object.keys(loginConfig).length ? loginConfig : undefined);
    const accountId = options.accountId === undefined ? context.identity : requireNonBlank(options.accountId, "NIM account ID");
    const client = new NimWebClient(context, nim, accountId);
    try { await client.login(options); if (!context.isCurrent()) throw new ImLifecycleSupersededError(); return { client, dispose: () => client.dispose() }; } catch (error) { await client.dispose(); throw error; }
  };
}

export type LocalFakeNimWebClientOptions = { endpoint: string; accountId: string; pollMs?: number };

function validateLocalFakeOptions(options: LocalFakeNimWebClientOptions): void {
  if (!options || typeof options !== "object" || typeof options.endpoint !== "string" || !/^\/(?!\/)/.test(options.endpoint) || options.endpoint.length > 128) {
    throw new TypeError("Local IM test endpoint is invalid");
  }
  if (typeof options.accountId !== "string" || !options.accountId.trim() || options.accountId.length > 128) throw new TypeError("Local IM test account ID is invalid");
  if (options.pollMs !== undefined && (!Number.isInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 5_000)) throw new TypeError("Local IM test poll interval is invalid");
}

export class LocalFakeNimWebClient implements NimWebClientLike {
  readonly accountId: string;
  private readonly context: ImClientContext;
  private readonly endpoint: string;
  private readonly pollMs: number;
  private state: NimWebConnectionState = "DISCONNECTED";
  private disposed = false;
  private loggedIn = false;
  private pollTimer: number | undefined;
  private polling = false;
  private readonly listeners = new Set<(state: NimWebConnectionState) => void>();
  private readonly messageListeners = new Set<(messages: NimMessageLike[]) => void>();
  private readonly known = new Map<string, Set<string>>();

  constructor(context: ImClientContext, options: LocalFakeNimWebClientOptions) {
    validateLocalFakeOptions(options);
    this.context = context;
    this.endpoint = options.endpoint;
    this.accountId = options.accountId.trim();
    this.pollMs = options.pollMs ?? 350;
  }

  getConnectionState(): NimWebConnectionState { return this.state; }

  onConnectionStateChange(listener: (state: NimWebConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMessages(listener: (messages: NimMessageLike[]) => void): () => void {
    this.messageListeners.add(listener);
    this.startPolling();
    return () => this.messageListeners.delete(listener);
  }

  async login(): Promise<void> {
    this.assertCurrent();
    this.setState("CONNECTING");
    this.loggedIn = true;
    this.assertCurrent();
    this.setState("CONNECTED");
  }

  async getMessageHistory(conversationId: string, limit = 50): Promise<NimMessageLike[]> {
    this.assertCurrent();
    const messages = await this.readHistory(conversationId, limit);
    this.assertCurrent();
    this.remember(conversationId, messages);
    return messages;
  }

  async sendText(conversationId: string, text: string): Promise<NimMessageLike> {
    this.assertCurrent();
    const id = conversationId.trim();
    const body = text.trim();
    if (!id || id.length > 160 || !body || body.length > 4_000) throw new TypeError("Local IM message is invalid");
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: id, text: body }),
      });
    } catch {
      throw new Error("IM message request failed");
    }
    if (!response.ok) throw new Error("IM message request failed");
    const value = await response.json().catch(() => null) as { message?: NimMessageLike } | null;
    if (!value?.message || typeof value.message !== "object") throw new Error("IM message response is invalid");
    this.assertCurrent();
    this.remember(id, [value.message]);
    return value.message;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.loggedIn = false;
    this.setState("DISCONNECTED");
    this.listeners.clear();
    this.messageListeners.clear();
    this.known.clear();
  }

  private async readHistory(conversationId: string, limit: number): Promise<NimMessageLike[]> {
    const id = conversationId.trim();
    if (!id || id.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Local IM history request is invalid");
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}?conversationId=${encodeURIComponent(id)}&limit=${limit}`, { credentials: "same-origin", cache: "no-store" });
    } catch {
      throw new Error("IM history request failed");
    }
    if (!response.ok) throw new Error("IM history request failed");
    const value = await response.json().catch(() => null) as { messages?: unknown } | null;
    if (!Array.isArray(value?.messages)) throw new Error("IM history response is invalid");
    return value.messages.filter((message): message is NimMessageLike => Boolean(message && typeof message === "object"));
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.disposed) return;
    this.pollTimer = window.setInterval(() => { void this.poll(); }, this.pollMs);
  }

  private async poll(): Promise<void> {
    if (this.disposed || !this.loggedIn || this.polling || this.known.size === 0) return;
    this.polling = true;
    try {
      for (const [conversationId, known] of this.known) {
        const messages = await this.readHistory(conversationId, 100);
        const incoming = messages.filter((message) => !known.has(this.messageKey(message)));
        this.remember(conversationId, messages);
        if (incoming.length > 0 && !this.disposed && this.context.isCurrent()) {
          for (const listener of this.messageListeners) listener(incoming);
        }
      }
    } catch {
      // Polling is best-effort; the next history/send operation surfaces auth and network errors.
    } finally {
      this.polling = false;
    }
  }

  private remember(conversationId: string, messages: NimMessageLike[]): void {
    const known = this.known.get(conversationId) ?? new Set<string>();
    for (const message of messages) known.add(this.messageKey(message));
    this.known.set(conversationId, known);
  }

  private messageKey(message: NimMessageLike): string {
    return message.messageServerId || message.messageClientId || `${message.senderId}-${message.createTime}`;
  }

  private assertCurrent(): void {
    if (this.disposed) throw new Error("IM client is disposed");
    if (!this.context.isCurrent()) throw new ImLifecycleSupersededError();
  }

  private setState(next: NimWebConnectionState): void {
    if (this.disposed || this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

export function createLocalFakeNimWebClientFactory(options: LocalFakeNimWebClientOptions): ImClientFactory<LocalFakeNimWebClient> {
  validateLocalFakeOptions(options);
  return async (context) => {
    const client = new LocalFakeNimWebClient(context, options);
    try {
      await client.login();
      return { client, dispose: () => client.dispose() };
    } catch (error) {
      await client.dispose();
      throw error;
    }
  };
}
