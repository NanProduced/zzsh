import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  ImIdentityProvisioner,
  ImIdentityRepository,
  ImIdentityUnavailableError,
  ImProvisionClaim,
  ImIdentityKey,
  ImIdentityMapping,
  ImIdentityMutation,
  ImIdentityIntent,
  YunxinDynamicTokenService,
} from "../src/im/identity-lifecycle";
import { YunxinApiError, YunxinServerApi, YunxinTransportError } from "../src/im/yunxin-provider";

const APP_ID = "provider-test";
const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";

function key(kind: ImIdentityKey["kind"], subject = "subject-1"): ImIdentityKey {
  return { provider: "yunxin", appId: APP_ID, realm: "zzsh", kind, platformSubjectId: subject };
}

function copyMapping(mapping: ImIdentityMapping): ImIdentityMapping {
  return {
    ...mapping,
    key: { ...mapping.key },
    lastFailure: mapping.lastFailure ? { ...mapping.lastFailure } : null,
  };
}

class MemoryIdentityRepository implements ImIdentityRepository {
  private readonly rows = new Map<string, ImIdentityMapping>();
  private readonly rowsById = new Map<string, ImIdentityMapping>();
  private readonly accounts = new Map<string, string>();
  private readonly attemptStartedAt = new Map<string, number>();
  private nextId = 1;

  ensureIntent(intent: ImIdentityIntent): Promise<ImIdentityMapping> {
    const lookup = JSON.stringify(intent.key);
    const existing = this.rows.get(lookup);
    if (existing) {
      if (existing.accountId !== intent.accountId || existing.identityMarker !== intent.identityMarker) {
        throw new Error("identity intent conflict");
      }
      return Promise.resolve(copyMapping(existing));
    }
    const accountOwner = this.accounts.get(intent.accountId);
    if (accountOwner && accountOwner !== lookup) throw new Error("identity account conflict");
    const mapping: ImIdentityMapping = {
      id: `identity-${this.nextId++}`,
      key: { ...intent.key },
      accountId: intent.accountId,
      identityMarker: intent.identityMarker,
      status: "PENDING",
      version: 1,
      attemptCount: 0,
      attemptLeaseUntil: null,
      nextRetryAt: null,
      lastFailure: null,
    };
    this.rows.set(lookup, mapping);
    this.rowsById.set(mapping.id, mapping);
    this.accounts.set(mapping.accountId, lookup);
    return Promise.resolve(copyMapping(mapping));
  }

  ensureIntentInTransaction(_executor: { query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }, intent: ImIdentityIntent): Promise<ImIdentityMapping> {
    return this.ensureIntent(intent);
  }

  findByKey(input: ImIdentityKey): Promise<ImIdentityMapping | null> {
    const mapping = this.rows.get(JSON.stringify(input));
    return Promise.resolve(mapping ? copyMapping(mapping) : null);
  }

  listMappings(appId: string, limit = 100): Promise<ImIdentityMapping[]> {
    return Promise.resolve([...this.rows.values()]
      .filter((mapping) => mapping.key.appId === appId)
      .slice(0, limit)
      .map(copyMapping));
  }

  claimProvisionAttempt(input: { mappingId: string; expectedVersion: number; now: Date; leaseMs: number }): Promise<ImProvisionClaim | null> {
    const mapping = this.rowsById.get(input.mappingId);
    if (!mapping || mapping.version !== input.expectedVersion || mapping.status !== "PENDING") return Promise.resolve(null);
    if (mapping.attemptLeaseUntil && Date.parse(mapping.attemptLeaseUntil) > input.now.getTime()) return Promise.resolve(null);
    if (mapping.nextRetryAt && Date.parse(mapping.nextRetryAt) > input.now.getTime()) return Promise.resolve(null);
    mapping.version += 1;
    mapping.attemptCount += 1;
    this.attemptStartedAt.set(mapping.id, input.now.getTime());
    mapping.attemptLeaseUntil = new Date(input.now.getTime() + input.leaseMs).toISOString();
    mapping.nextRetryAt = null;
    return Promise.resolve({ mapping: copyMapping(mapping), leaseToken: `lease-${mapping.attemptCount}` });
  }

  markReady(input: { mappingId: string; expectedVersion: number; leaseToken: string }): Promise<ImIdentityMutation> {
    const mapping = this.rowsById.get(input.mappingId);
    if (!this.ownsLease(mapping, input)) return Promise.resolve(this.notApplied(mapping));
    mapping!.status = "READY";
    mapping!.version += 1;
    mapping!.attemptLeaseUntil = null;
    mapping!.nextRetryAt = null;
    mapping!.lastFailure = null;
    return Promise.resolve({ applied: true, mapping: copyMapping(mapping!) });
  }

  markRetryableFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImIdentityMapping["lastFailure"] & {};
    retryAfterMs: number;
  }): Promise<ImIdentityMutation> {
    const mapping = this.rowsById.get(input.mappingId);
    if (!this.ownsLease(mapping, input)) return Promise.resolve(this.notApplied(mapping));
    mapping!.version += 1;
    mapping!.attemptLeaseUntil = null;
    mapping!.nextRetryAt = new Date((this.attemptStartedAt.get(mapping!.id) ?? Date.now()) + input.retryAfterMs).toISOString();
    mapping!.lastFailure = { ...input.failure };
    return Promise.resolve({ applied: true, mapping: copyMapping(mapping!) });
  }

  markPermanentFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImIdentityMapping["lastFailure"] & {};
  }): Promise<ImIdentityMutation> {
    const mapping = this.rowsById.get(input.mappingId);
    if (!this.ownsLease(mapping, input)) return Promise.resolve(this.notApplied(mapping));
    mapping!.status = "FAILED_PERMANENT";
    mapping!.version += 1;
    mapping!.attemptLeaseUntil = null;
    mapping!.nextRetryAt = null;
    mapping!.lastFailure = { ...input.failure };
    return Promise.resolve({ applied: true, mapping: copyMapping(mapping!) });
  }

  disable(input: ImIdentityKey): void {
    const mapping = this.rows.get(JSON.stringify(input));
    assert.ok(mapping);
    mapping.status = "DISABLED";
    mapping.version += 1;
    mapping.attemptLeaseUntil = null;
  }

  read(input: ImIdentityKey): ImIdentityMapping {
    const mapping = this.rows.get(JSON.stringify(input));
    assert.ok(mapping);
    return copyMapping(mapping);
  }

  private ownsLease(
    mapping: ImIdentityMapping | undefined,
    input: { expectedVersion: number; leaseToken: string },
  ): mapping is ImIdentityMapping {
    return Boolean(mapping && mapping.version === input.expectedVersion && input.leaseToken === `lease-${mapping.attemptCount}`);
  }

  private notApplied(mapping: ImIdentityMapping | undefined): ImIdentityMutation {
    if (!mapping) throw new Error("identity mapping missing");
    return { applied: false, mapping: copyMapping(mapping) };
  }
}

function providerOf(overrides: Pick<YunxinServerApi, "createAccount" | "getProfile">): YunxinServerApi {
  return {
    ...overrides,
    getProfiles: async () => ({ profiles: [], failed: [] }),
    updateProfile: async () => undefined,
    getAccount: async (accountId) => ({ accountId, enabled: true, p2pChatBanned: null, teamChatBanned: null, chatroomChatBanned: null, qchatChatBanned: null }),
    setAccountEnabled: async (accountId) => ({ accountId, enabled: true, p2pChatBanned: null, teamChatBanned: null, chatroomChatBanned: null, qchatChatBanned: null }),
    refreshAccountToken: async (accountId) => ({ accountId, token: "static-token" }),
    getOnlineStatuses: async () => ({ statuses: [], failed: [] }),
  };
}

function successfulCreate(input: { accountId: string; extension?: string }) {
  return { accountId: input.accountId, token: "provider-token", profile: { accountId: input.accountId, extension: input.extension } };
}

test("derives separate opaque accounts and markers for user, admin and system identities", async () => {
  const user = key("USER", "user-42");
  const admin = key("ADMIN", "user-42");
  const system = key("SYSTEM", "order-router");
  const ids = [user, admin, system].map(deriveYunxinAccountId);
  const markers = [user, admin, system].map(buildYunxinIdentityMarker);

  assert.equal(new Set(ids).size, 3);
  assert.match(ids[0]!, /^zzu[A-Za-z0-9]{29}$/);
  assert.match(ids[1]!, /^zza[A-Za-z0-9]{29}$/);
  assert.match(ids[2]!, /^zzs[A-Za-z0-9]{29}$/);
  assert.ok(ids.every((id) => !id.includes("user-42")));
  assert.ok(markers.every((marker) => !marker.includes("user-42")));

  const repository = new MemoryIdentityRepository();
  let creates = 0;
  const provisioner = new ImIdentityProvisioner(
    repository,
    providerOf({
      createAccount: async (input) => {
        creates += 1;
        return successfulCreate(input);
      },
      getProfile: async (accountId) => ({ accountId }),
    }),
    { now: () => new Date("2026-09-15T00:00:00.000Z") },
  );
  const first = await provisioner.ensure({ key: admin, displayName: "客服一号" });
  const second = await provisioner.ensure({ key: admin, displayName: "客服一号" });
  assert.equal(first.outcome, "READY");
  assert.equal(second.outcome, "READY");
  assert.equal(creates, 1);
});

test("uses a lease so concurrent provisioning does not hold a database lock across the provider call", async () => {
  const identity = key("USER", "concurrent-user");
  const repository = new MemoryIdentityRepository();
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const providerRelease = new Promise<void>((resolve) => { release = resolve; });
  let creates = 0;
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async (input) => {
      creates += 1;
      entered();
      await providerRelease;
      return successfulCreate(input);
    },
    getProfile: async (accountId) => ({ accountId }),
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });

  const firstPromise = provisioner.ensure({ key: identity });
  await enteredProvider;
  const second = await provisioner.ensure({ key: identity });
  assert.equal(second.outcome, "PENDING");
  release();
  const first = await firstPromise;
  assert.equal(first.outcome, "READY");
  assert.equal(creates, 1);
});

test("recovers a create whose response was lost when the marker proves ownership", async () => {
  const identity = key("USER", "response-lost");
  const repository = new MemoryIdentityRepository();
  let profiles = 0;
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async () => { throw new YunxinTransportError("create-account"); },
    getProfile: async (accountId) => {
      profiles += 1;
      return { accountId, extension: buildYunxinIdentityMarker(identity) };
    },
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });

  const result = await provisioner.ensure({ key: identity });
  assert.equal(result.outcome, "READY");
  assert.equal(profiles, 1);
});

test("does not take over an existing account with a different identity marker", async () => {
  const identity = key("ADMIN", "owned-by-someone-else");
  const repository = new MemoryIdentityRepository();
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async () => { throw new YunxinApiError("create-account", 102449, false); },
    getProfile: async (accountId) => ({ accountId, extension: "foreign-marker" }),
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });

  const result = await provisioner.ensure({ key: identity });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.mapping.status, "FAILED_PERMANENT");
  assert.equal(result.mapping.lastFailure?.class, "ACCOUNT_OWNERSHIP_CONFLICT");
});

test("preserves an explicit permanent create rejection when ownership verification is unavailable", async () => {
  const identity = key("ADMIN", "permanent-create-error");
  const repository = new MemoryIdentityRepository();
  let creates = 0;
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async () => {
      creates += 1;
      throw new YunxinApiError("create-account", 403, false);
    },
    getProfile: async () => { throw new YunxinTransportError("get-profile"); },
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });

  const result = await provisioner.ensure({ key: identity });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.mapping.status, "FAILED_PERMANENT");
  assert.equal(result.mapping.lastFailure?.class, "PERMANENT_PROVIDER");
  assert.equal(creates, 1);
  assert.equal((await provisioner.ensure({ key: identity })).outcome, "BLOCKED");
  assert.equal(creates, 1);
});

test("persists retry backoff for an unresolved create instead of retrying immediately forever", async () => {
  const identity = key("USER", "retry-user");
  const repository = new MemoryIdentityRepository();
  let nowMs = Date.parse("2026-09-15T00:00:00.000Z");
  let creates = 0;
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async (input) => {
      creates += 1;
      if (creates === 1) throw new YunxinTransportError("create-account");
      return successfulCreate(input);
    },
    getProfile: async () => { throw new YunxinApiError("get-profile", 102404, false); },
  }), { now: () => new Date(nowMs) });

  const pending = await provisioner.ensure({ key: identity });
  assert.equal(pending.outcome, "PENDING");
  assert.equal(pending.mapping.lastFailure?.class, "UNKNOWN_RESULT");
  assert.equal(pending.mapping.nextRetryAt, "2026-09-15T00:00:01.000Z");
  assert.equal((await provisioner.ensure({ key: identity })).outcome, "PENDING");
  assert.equal(creates, 1);

  nowMs += 1_001;
  const ready = await provisioner.ensure({ key: identity });
  assert.equal(ready.outcome, "READY");
  assert.equal(creates, 2);
});

test("checks an earlier unknown result before attempting the same stable account again", async () => {
  const identity = key("USER", "query-before-retry");
  const repository = new MemoryIdentityRepository();
  let nowMs = Date.parse("2026-09-15T00:00:00.000Z");
  let creates = 0;
  let profiles = 0;
  const events: string[] = [];
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async () => {
      creates += 1;
      events.push("create");
      throw new YunxinTransportError("create-account");
    },
    getProfile: async (accountId) => {
      profiles += 1;
      if (profiles === 1) {
        events.push("query-absent");
        throw new YunxinApiError("get-profile", 102404, false);
      }
      events.push("query-owned");
      return { accountId, extension: buildYunxinIdentityMarker(identity) };
    },
  }), { now: () => new Date(nowMs) });

  const pending = await provisioner.ensure({ key: identity });
  assert.equal(pending.outcome, "PENDING");
  nowMs += 1_001;
  const ready = await provisioner.ensure({ key: identity });
  assert.equal(ready.outcome, "READY");
  assert.equal(creates, 1);
  assert.deepEqual(events, ["create", "query-absent", "query-owned"]);
});

test("a late provider success cannot re-enable an identity disabled while the request was in flight", async () => {
  const identity = key("ADMIN", "late-success");
  const repository = new MemoryIdentityRepository();
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const providerRelease = new Promise<void>((resolve) => { release = resolve; });
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async (input) => {
      entered();
      await providerRelease;
      return successfulCreate(input);
    },
    getProfile: async (accountId) => ({ accountId }),
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });

  const promise = provisioner.ensure({ key: identity });
  await enteredProvider;
  repository.disable(identity);
  release();
  const result = await promise;
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.mapping.status, "DISABLED");
});

test("an expired lease lets a newer attempt win while the older provider result is ignored", async () => {
  const identity = key("USER", "expired-lease");
  const repository = new MemoryIdentityRepository();
  let nowMs = Date.parse("2026-09-15T00:00:00.000Z");
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
  let releaseFirst!: () => void;
  const firstProviderRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let creates = 0;
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async (input) => {
      creates += 1;
      if (creates === 1) {
        entered();
        await firstProviderRelease;
      }
      return successfulCreate(input);
    },
    getProfile: async () => { throw new YunxinApiError("get-profile", 102404, false); },
  }), { now: () => new Date(nowMs), leaseMs: 1_000 });

  const firstPromise = provisioner.ensure({ key: identity });
  await enteredProvider;
  nowMs += 1_001;
  const second = await provisioner.ensure({ key: identity });
  assert.equal(second.outcome, "READY");
  assert.equal(creates, 2);
  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.outcome, "READY");
  assert.equal(repository.read(identity).status, "READY");
});

test("issues a dynamic token only for a ready mapped identity", async () => {
  const identity = key("ADMIN", "token-user");
  const repository = new MemoryIdentityRepository();
  const provisioner = new ImIdentityProvisioner(repository, providerOf({
    createAccount: async (input) => successfulCreate(input),
    getProfile: async (accountId) => ({ accountId }),
  }), { now: () => new Date("2026-09-15T00:00:00.000Z") });
  await provisioner.ensure({ key: identity });

  const issuedAt = 1_700_000_000_000;
  const service = new YunxinDynamicTokenService(repository, {
    appId: APP_ID,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    ttlSeconds: 600,
    now: () => issuedAt,
  });
  const issued = await service.issue(identity);
  const payload = JSON.parse(Buffer.from(issued.token, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(issued.accountId, deriveYunxinAccountId(identity));
  assert.equal(payload.curTime, issuedAt);
  assert.equal(payload.ttl, 600);
  assert.equal(payload.signature, createHash("sha1").update(`${APP_KEY}${issued.accountId}${issuedAt}600${APP_SECRET}`).digest("hex"));

  const pending = key("USER", "not-created");
  await assert.rejects(() => service.issue(pending), ImIdentityUnavailableError);
  await assert.rejects(() => service.issue({ ...identity, appId: "another-app" }), ImIdentityUnavailableError);
});
