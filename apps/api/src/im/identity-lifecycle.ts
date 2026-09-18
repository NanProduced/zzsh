import { createHash } from "node:crypto";
import {
  createYunxinDynamicToken,
  YunxinApiError,
  YunxinTransportError,
  type YunxinServerApi,
  type YunxinCreatedAccount,
} from "./yunxin-provider";

export type ImIdentityKind = "USER" | "ADMIN" | "SYSTEM";
export type ImIdentityStatus = "PENDING" | "READY" | "FAILED_PERMANENT" | "DISABLED" | "REVOKED";

export type ImIdentityKey = {
  provider: "yunxin";
  appId: string;
  realm: string;
  kind: ImIdentityKind;
  platformSubjectId: string;
};

export type ImProvisionFailureClass =
  | "UNKNOWN_RESULT"
  | "TRANSIENT_PROVIDER"
  | "PERMANENT_PROVIDER"
  | "ACCOUNT_OWNERSHIP_CONFLICT";

export type ImProvisionFailure = {
  class: ImProvisionFailureClass;
  providerCode: number | null;
};

export type ImIdentityMapping = {
  id: string;
  key: ImIdentityKey;
  accountId: string;
  identityMarker: string;
  status: ImIdentityStatus;
  version: number;
  attemptCount: number;
  attemptLeaseUntil: string | null;
  nextRetryAt: string | null;
  lastFailure: ImProvisionFailure | null;
};

export type ImIdentityIntent = {
  key: ImIdentityKey;
  accountId: string;
  identityMarker: string;
};

export type ImIdentityQueryExecutor = {
  query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

export type ImIdentityIntentRepository = {
  ensureIntentInTransaction(executor: ImIdentityQueryExecutor, intent: ImIdentityIntent): Promise<ImIdentityMapping>;
};

export type ImProvisionClaim = {
  mapping: ImIdentityMapping;
  leaseToken: string;
};

export type ImIdentityMutation = {
  applied: boolean;
  mapping: ImIdentityMapping;
};

/**
 * The SQL implementation must enforce the key/account uniqueness constraints,
 * claim with a compare-and-set update, and commit before the provider call.
 * Retry timing is expressed as a duration so the database owns its clock.
 */
export type ImIdentityRepository = ImIdentityIntentRepository & {
  ensureIntent(intent: ImIdentityIntent): Promise<ImIdentityMapping>;
  findByKey(key: ImIdentityKey): Promise<ImIdentityMapping | null>;
  listMappings(appId: string, limit?: number): Promise<ImIdentityMapping[]>;
  claimProvisionAttempt(input: {
    mappingId: string;
    expectedVersion: number;
    now: Date;
    leaseMs: number;
  }): Promise<ImProvisionClaim | null>;
  markReady(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
  }): Promise<ImIdentityMutation>;
  markRetryableFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImProvisionFailure;
    retryAfterMs: number;
  }): Promise<ImIdentityMutation>;
  markPermanentFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImProvisionFailure;
  }): Promise<ImIdentityMutation>;
};

export type ImIdentityProvisionInput = {
  key: ImIdentityKey;
  displayName?: string;
  avatar?: string;
};

export type ImProvisionResult = {
  outcome: "READY" | "PENDING" | "BLOCKED";
  mapping: ImIdentityMapping;
};

export class ImIdentityUnavailableError extends Error {
  constructor() {
    super("IM identity is unavailable");
    this.name = "ImIdentityUnavailableError";
  }
}

export class ImIdentityInvariantError extends Error {
  constructor() {
    super("IM identity mapping invariant failed");
    this.name = "ImIdentityInvariantError";
  }
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ID_KIND_CODE: Record<ImIdentityKind, string> = { USER: "u", ADMIN: "a", SYSTEM: "s" };
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 5 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30 * 1_000;

function normalizeText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`IM ${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_PATTERN.test(normalized)) {
    throw new TypeError(`IM ${label} is invalid`);
  }
  return normalized;
}

export function normalizeImIdentityKey(input: ImIdentityKey): ImIdentityKey {
  if (!input || typeof input !== "object" || input.provider !== "yunxin") {
    throw new TypeError("IM identity provider is invalid");
  }
  if (input.kind !== "USER" && input.kind !== "ADMIN" && input.kind !== "SYSTEM") {
    throw new TypeError("IM identity kind is invalid");
  }
  return {
    provider: "yunxin",
    appId: normalizeText(input.appId, "app ID", 128),
    realm: normalizeText(input.realm, "realm", 128),
    kind: input.kind,
    platformSubjectId: normalizeText(input.platformSubjectId, "platform subject ID", 256),
  };
}

function canonicalKey(key: ImIdentityKey): string {
  return [key.provider, key.appId, key.realm, key.kind, key.platformSubjectId]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameIdentityKey(left: ImIdentityKey, right: ImIdentityKey): boolean {
  return left.provider === right.provider &&
    left.appId === right.appId &&
    left.realm === right.realm &&
    left.kind === right.kind &&
    left.platformSubjectId === right.platformSubjectId;
}

export function deriveYunxinAccountId(input: ImIdentityKey): string {
  const key = normalizeImIdentityKey(input);
  // 3-character prefix + 29 hex characters stays within Yunxin's 32-character account ID limit.
  return `zz${ID_KIND_CODE[key.kind]}${digest(canonicalKey(key)).slice(0, 29)}`;
}

export function buildYunxinIdentityMarker(input: ImIdentityKey): string {
  const key = normalizeImIdentityKey(input);
  return JSON.stringify({
    schema: "zzsh.im.identity",
    version: 1,
    appId: key.appId,
    realm: key.realm,
    kind: key.kind,
    subjectHash: digest(key.platformSubjectId),
  });
}

function expectedIntent(input: ImIdentityKey): ImIdentityIntent {
  const key = normalizeImIdentityKey(input);
  return { key, accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key) };
}

function assertMapping(mapping: ImIdentityMapping, intent: ImIdentityIntent): void {
  if (
    !mapping ||
    !sameIdentityKey(mapping.key, intent.key) ||
    mapping.accountId !== intent.accountId ||
    mapping.identityMarker !== intent.identityMarker
  ) {
    throw new ImIdentityInvariantError();
  }
}

function isBlocked(status: ImIdentityStatus): boolean {
  return status === "FAILED_PERMANENT" || status === "DISABLED" || status === "REVOKED";
}

function resultFor(mapping: ImIdentityMapping): ImProvisionResult {
  return { outcome: mapping.status === "READY" ? "READY" : isBlocked(mapping.status) ? "BLOCKED" : "PENDING", mapping };
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("IM clock is invalid");
  return value;
}

function providerCode(error: unknown): number | null {
  return error instanceof YunxinApiError ? error.providerCode : null;
}

function isNotFound(error: unknown): boolean {
  const code = providerCode(error);
  return code === 404 || code === 102404;
}

function classifyCreateFailure(error: unknown): ImProvisionFailure {
  if (error instanceof YunxinTransportError) return { class: "UNKNOWN_RESULT", providerCode: null };
  if (error instanceof YunxinApiError) {
    if (error.providerCode === null && !error.retryable) return { class: "UNKNOWN_RESULT", providerCode: null };
    return {
      class: error.retryable ? "TRANSIENT_PROVIDER" : "PERMANENT_PROVIDER",
      providerCode: error.providerCode,
    };
  }
  return { class: "UNKNOWN_RESULT", providerCode: null };
}

function retryDelayMs(attemptCount: number): number {
  // ponytail: deterministic backoff keeps persisted retries testable; add jitter only if worker bursts are observed.
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 12);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
}

function ownedProfile(accountId: string, marker: string, profile: { accountId: string; extension?: string }): boolean {
  return profile.accountId === accountId && profile.extension === marker;
}

type Recovery =
  | { kind: "OWNED" }
  | { kind: "ABSENT" }
  | { kind: "CONFLICT" }
  | { kind: "UNKNOWN"; failure: ImProvisionFailure };

export class ImIdentityProvisioner {
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(
    private readonly repository: ImIdentityRepository,
    private readonly provider: YunxinServerApi,
    options: { now?: () => Date; leaseMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 10 * 60 * 1_000) {
      throw new Error("IM identity lease is invalid");
    }
  }

  async ensure(input: ImIdentityProvisionInput): Promise<ImProvisionResult> {
    const intent = expectedIntent(input.key);
    const displayName = input.displayName === undefined ? undefined : normalizeText(input.displayName, "display name", 128);
    const avatar = input.avatar === undefined ? undefined : normalizeText(input.avatar, "avatar", 512);
    const mapping = await this.repository.ensureIntent(intent);
    assertMapping(mapping, intent);
    const now = validDate(this.now());
    const hadPriorAttempt = mapping.attemptCount > 0 || mapping.lastFailure !== null;

    if (mapping.status === "READY" || isBlocked(mapping.status)) return resultFor(mapping);
    if (mapping.status !== "PENDING") return { outcome: "BLOCKED", mapping };
    // The repository claim is the only database operation before the external request.
    const claim = await this.repository.claimProvisionAttempt({
      mappingId: mapping.id,
      expectedVersion: mapping.version,
      now,
      leaseMs: this.leaseMs,
    });
    if (!claim) return resultFor(mapping);
    assertMapping(claim.mapping, intent);

    if (hadPriorAttempt) {
      const recovery = await this.recover(claim.mapping.accountId, claim.mapping.identityMarker);
      const recovered = await this.applyRecovery(claim, recovery);
      if (recovered) return recovered;
      if (recovery.kind === "UNKNOWN") return this.finishFailure(claim, recovery.failure);
    }

    let created: YunxinCreatedAccount | null = null;
    let createError: unknown = null;
    try {
      created = await this.provider.createAccount({
        accountId: claim.mapping.accountId,
        ...(displayName === undefined ? {} : { name: displayName }),
        ...(avatar === undefined ? {} : { avatar }),
        extension: claim.mapping.identityMarker,
      });
    } catch (error) {
      createError = error;
    }

    if (
      created &&
      created.accountId === claim.mapping.accountId &&
      ownedProfile(claim.mapping.accountId, claim.mapping.identityMarker, created.profile)
    ) {
      return resultFor((await this.repository.markReady(this.leaseInput(claim))).mapping);
    }

    const recovery = await this.recover(claim.mapping.accountId, claim.mapping.identityMarker);
    const recovered = await this.applyRecovery(claim, recovery);
    if (recovered) return recovered;
    const createFailure = classifyCreateFailure(createError);
    // A confirmed permanent provider rejection remains permanent even when the verification query fails.
    const failure = recovery.kind === "UNKNOWN" && createFailure.class !== "PERMANENT_PROVIDER"
      ? recovery.failure
      : createFailure;
    return this.finishFailure(claim, failure);
  }

  private leaseInput(claim: ImProvisionClaim): {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
  } {
    return { mappingId: claim.mapping.id, expectedVersion: claim.mapping.version, leaseToken: claim.leaseToken };
  }

  private async recover(accountId: string, marker: string): Promise<Recovery> {
    try {
      const profile = await this.provider.getProfile(accountId);
      return ownedProfile(accountId, marker, profile) ? { kind: "OWNED" } : { kind: "CONFLICT" };
    } catch (error) {
      if (isNotFound(error)) return { kind: "ABSENT" };
      return { kind: "UNKNOWN", failure: { class: "UNKNOWN_RESULT", providerCode: providerCode(error) } };
    }
  }

  private async applyRecovery(claim: ImProvisionClaim, recovery: Recovery): Promise<ImProvisionResult | null> {
    if (recovery.kind === "OWNED") {
      return resultFor((await this.repository.markReady(this.leaseInput(claim))).mapping);
    }
    if (recovery.kind === "CONFLICT") {
      return resultFor((await this.repository.markPermanentFailure({
        ...this.leaseInput(claim),
        failure: { class: "ACCOUNT_OWNERSHIP_CONFLICT", providerCode: null },
      })).mapping);
    }
    return null;
  }

  private async finishFailure(claim: ImProvisionClaim, failure: ImProvisionFailure): Promise<ImProvisionResult> {
    const lease = this.leaseInput(claim);
    if (failure.class === "PERMANENT_PROVIDER" || failure.class === "ACCOUNT_OWNERSHIP_CONFLICT") {
      return resultFor((await this.repository.markPermanentFailure({ ...lease, failure })).mapping);
    }
    return resultFor((await this.repository.markRetryableFailure({
      ...lease,
      failure,
      retryAfterMs: retryDelayMs(claim.mapping.attemptCount),
    })).mapping);
  }
}

export type YunxinDynamicTokenServiceOptions = {
  appId: string;
  appKey: string;
  appSecret: string;
  ttlSeconds?: number;
  now?: () => number;
};

export type YunxinIssuedDynamicToken = {
  accountId: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
  ttlSeconds: number;
};

export class YunxinDynamicTokenService {
  private readonly appId: string;

  constructor(
    private readonly repository: Pick<ImIdentityRepository, "findByKey">,
    private readonly options: YunxinDynamicTokenServiceOptions,
  ) {
    this.appId = normalizeText(options.appId, "app ID", 128);
  }

  async issue(input: ImIdentityKey): Promise<YunxinIssuedDynamicToken> {
    const key = normalizeImIdentityKey(input);
    if (key.appId !== this.appId) throw new ImIdentityUnavailableError();
    const mapping = await this.repository.findByKey(key);
    if (
      !mapping ||
      !sameIdentityKey(mapping.key, key) ||
      mapping.status !== "READY" ||
      mapping.accountId !== deriveYunxinAccountId(key) ||
      mapping.identityMarker !== buildYunxinIdentityMarker(key)
    ) {
      throw new ImIdentityUnavailableError();
    }
    const issued = createYunxinDynamicToken({
      appKey: this.options.appKey,
      appSecret: this.options.appSecret,
      accountId: mapping.accountId,
      ttlSeconds: this.options.ttlSeconds,
      now: this.options.now,
    });
    return { accountId: mapping.accountId, ...issued };
  }
}
