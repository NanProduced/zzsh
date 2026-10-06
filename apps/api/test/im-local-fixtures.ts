import type { ImMessageTransport, ImOrderImageScope, ImTransportImage, ImTransportMessage } from "../src/im/im-contract";
import {
  YunxinApiError,
  type YunxinAccountLookupFailure,
  type YunxinAccountState,
  type YunxinCreateAccountInput,
  type YunxinCreatedAccount,
  type YunxinOnlineStatus,
  type YunxinOrderTeamApi,
  type YunxinOrderTeamInput,
  type YunxinOrderTeamState,
  type YunxinProfile,
  type YunxinProfilePatch,
  type YunxinServerApi,
  type YunxinSupportScopeApi,
} from "../src/im/yunxin-provider";
import { FakeSupportScopeProvider } from "./im-test-fixtures";
import { OrderTeamTransport } from "./order-team-fixtures";

/**
 * Test-only in-memory message transport. Reuses the shape of the retired
 * browser-round2 FakeMessageTransport, extended with the order-scoped image
 * seam that the current ImMessageTransport contract exposes. Never injected in
 * production and never persists messages.
 */
export class InMemoryMessageTransport implements ImMessageTransport {
  private readonly messages = new Map<string, ImTransportMessage[]>();
  private readonly images = new Map<string, ImTransportImage>();
  private nextId = 1;
  readonly calls = { history: 0, sendText: 0, sendImage: 0, readImage: 0 };

  /** NIM team conversations are viewer-specific (`<account>|2|<teamId>`); the
   *  retained message log is shared by team, like the supplier stores it. */
  private teamKey(conversationId: string): string {
    const match = /^.+\|2\|([0-9]{1,19})$/.exec(conversationId);
    if (!match) throw new Error("fixture conversation is invalid");
    return match[1]!;
  }

  async history(input: { conversationId: string; viewerAccountId: string; limit: number; before?: string }): Promise<ImTransportMessage[]> {
    this.calls.history += 1;
    const rows = this.messages.get(this.teamKey(input.conversationId)) ?? [];
    const beforeIndex = input.before === undefined ? rows.length : rows.findIndex((row) => (row.messageServerId || row.messageClientId) === input.before);
    const end = beforeIndex === -1 ? rows.length : beforeIndex;
    const start = Math.max(0, end - input.limit);
    return rows.slice(start, end).map((row) => ({ ...row, conversationId: input.conversationId }));
  }

  async sendText(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string }): Promise<ImTransportMessage> {
    this.calls.sendText += 1;
    const id = String(this.nextId++).padStart(6, "0");
    const message: ImTransportMessage = {
      messageClientId: `fixture-client-${id}`,
      messageServerId: `fixture-server-${id}`,
      conversationId: input.conversationId,
      senderId: input.senderAccountId,
      receiverId: input.receiverAccountId,
      createTime: Date.now(),
      text: input.text,
      messageType: 0,
    };
    const teamKey = this.teamKey(input.conversationId);
    const rows = this.messages.get(teamKey) ?? [];
    rows.push(message);
    this.messages.set(teamKey, rows);
    return { ...message };
  }

  async sendImage(input: {
    conversationId: string;
    scope: ImOrderImageScope;
    senderAccountId: string;
    receiverAccountId: string;
    messageClientId: string;
    name: string;
    mimeType: "image/jpeg" | "image/png";
    size: number;
    body: Uint8Array;
    width?: number;
    height?: number;
  }): Promise<ImTransportMessage> {
    this.calls.sendImage += 1;
    const imageId = `fixture-image-${input.messageClientId}`;
    this.images.set(imageId, { imageId, scope: input.scope, mimeType: input.mimeType, body: input.body });
    const id = String(this.nextId++).padStart(6, "0");
    const message: ImTransportMessage = {
      messageClientId: input.messageClientId,
      messageServerId: `fixture-server-${id}`,
      conversationId: input.conversationId,
      senderId: input.senderAccountId,
      receiverId: input.receiverAccountId,
      createTime: Date.now(),
      messageType: 1,
      attachment: {
        imageId,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        ...(input.width === undefined ? {} : { width: input.width }),
        ...(input.height === undefined ? {} : { height: input.height }),
      },
    };
    const teamKey = this.teamKey(input.conversationId);
    const rows = this.messages.get(teamKey) ?? [];
    rows.push(message);
    this.messages.set(teamKey, rows);
    return { ...message };
  }

  async getImageScope(imageId: string): Promise<{ imageId: string; scope: ImOrderImageScope } | null> {
    const image = this.images.get(imageId);
    return image ? { imageId, scope: image.scope } : null;
  }

  async readImage(input: { imageId: string; scope: ImOrderImageScope; viewerAccountId: string }): Promise<ImTransportImage | null> {
    this.calls.readImage += 1;
    return this.images.get(input.imageId) ?? null;
  }
}

/**
 * Test-only composite supplier used by the local runner and focused tests.
 * Account existence and profile existence are tracked separately so the
 * recovery contract (accounts 102404 vs profiles 103404) can be exercised.
 */
export class LocalFakeYunxinProvider implements YunxinServerApi, YunxinSupportScopeApi, YunxinOrderTeamApi {
  private readonly accounts = new Map<string, { profile: YunxinProfile; enabled: boolean; token: string }>();
  readonly support = new FakeSupportScopeProvider();
  readonly teams = new OrderTeamTransport();
  readonly calls = { createAccount: 0, getAccount: 0, getProfile: 0, getProfiles: 0, getOnlineStatuses: 0 };

  async createAccount(input: YunxinCreateAccountInput): Promise<YunxinCreatedAccount> {
    this.calls.createAccount += 1;
    const profile: YunxinProfile = {
      accountId: input.accountId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
      ...(input.extension === undefined ? {} : { extension: input.extension }),
    };
    this.accounts.set(input.accountId, { profile, enabled: true, token: `fixture-token-${input.accountId}` });
    return { accountId: input.accountId, token: `fixture-token-${input.accountId}`, profile };
  }

  async getProfile(accountId: string): Promise<YunxinProfile> {
    this.calls.getProfile += 1;
    const account = this.accounts.get(accountId);
    if (!account) throw new YunxinApiError("get-profile", 103404, false);
    return account.profile;
  }

  async getProfiles(accountIds: string[]): Promise<{ profiles: YunxinProfile[]; failed: YunxinAccountLookupFailure[] }> {
    this.calls.getProfiles += 1;
    const profiles: YunxinProfile[] = [];
    const failed: YunxinAccountLookupFailure[] = [];
    for (const accountId of accountIds) {
      const account = this.accounts.get(accountId);
      if (account) profiles.push(account.profile);
      else failed.push({ accountId, providerCode: 103404 });
    }
    return { profiles, failed };
  }

  async updateProfile(accountId: string, patch: YunxinProfilePatch): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) throw new YunxinApiError("update-profile", 103404, false);
    account.profile = { ...account.profile, ...patch, accountId };
  }

  async getAccount(accountId: string): Promise<YunxinAccountState> {
    this.calls.getAccount += 1;
    const account = this.accounts.get(accountId);
    if (!account) throw new YunxinApiError("get-account", 102404, false);
    return {
      accountId,
      enabled: account.enabled,
      p2pChatBanned: null,
      teamChatBanned: null,
      chatroomChatBanned: null,
      qchatChatBanned: null,
    };
  }

  async setAccountEnabled(accountId: string, enabled: boolean): Promise<YunxinAccountState> {
    const account = this.accounts.get(accountId);
    if (!account) throw new YunxinApiError("set-account-enabled", 102404, false);
    account.enabled = enabled;
    return this.getAccount(accountId);
  }

  async refreshAccountToken(accountId: string): Promise<{ accountId: string; token: string }> {
    const account = this.accounts.get(accountId);
    if (!account) throw new YunxinApiError("refresh-token", 102404, false);
    return { accountId, token: account.token };
  }

  async getOnlineStatuses(accountIds: string[]): Promise<{ statuses: YunxinOnlineStatus[]; failed: YunxinAccountLookupFailure[] }> {
    this.calls.getOnlineStatuses += 1;
    return { statuses: accountIds.map((accountId) => ({ accountId, online: false, sessions: [] })), failed: [] };
  }

  async readTeamMessage(): Promise<null> {
    return null;
  }

  createSupportTeam(input: Parameters<YunxinSupportScopeApi["createSupportTeam"]>[0]) {
    return this.support.createSupportTeam(input);
  }

  // The shared method name serves both team families; route by team ownership.
  addSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string) {
    if (this.support.teams.has(teamId)) return this.support.addSupportTeamMember(teamId, operatorAccountId, memberAccountId);
    return this.teams.client.addSupportTeamMember(teamId, operatorAccountId, memberAccountId);
  }

  removeSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string) {
    return this.support.removeSupportTeamMember(teamId, operatorAccountId, memberAccountId);
  }

  dismissSupportTeam(teamId: string, ownerAccountId: string) {
    return this.support.dismissSupportTeam(teamId, ownerAccountId);
  }

  getSupportTeam(teamId: string) {
    return this.support.getSupportTeam(teamId);
  }

  findSupportTeam(input: Parameters<YunxinSupportScopeApi["findSupportTeam"]>[0]) {
    return this.support.findSupportTeam(input);
  }

  readSupportTeamExistence(input: Parameters<YunxinSupportScopeApi["readSupportTeamExistence"]>[0]) {
    return this.support.readSupportTeamExistence(input);
  }

  createOrderTeam(input: YunxinOrderTeamInput) {
    return this.teams.client.createOrderTeam(input);
  }

  readOrderTeam(teamId: string): Promise<YunxinOrderTeamState | null> {
    return this.teams.client.readOrderTeam(teamId);
  }

  sendOrderTeamNotice(teamId: string, operatorAccountId: string, routeConfig?: Parameters<YunxinOrderTeamApi["sendOrderTeamNotice"]>[2]) {
    return this.teams.client.sendOrderTeamNotice(teamId, operatorAccountId, routeConfig);
  }
}
